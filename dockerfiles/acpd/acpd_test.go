// Drives a real agent over a real socket and checks what reaches an attached
// client and what lands in the record. The agent is usually `cat`: acpd
// interprets no protocol, so a byte echo exercises everything it does.
// Agents that need to react to what they read are this test binary itself,
// re-run with ACPD_TEST_AGENT naming the behavior (see TestMain).
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	switch os.Getenv("ACPD_TEST_AGENT") {
	case "":
		os.Exit(m.Run())
	case "bang":
		// Speaks the moment it reads a `!`, even mid-line.
		readChunks(func(p []byte) {
			if bytes.IndexByte(p, '!') >= 0 {
				os.Stdout.WriteString(`{"agent":"spoke"}` + "\n")
			}
		})
	case "burst":
		// Echoes its stdin, and answers a `burst` with 50 lines of its own,
		// 10 ms apart, so only settleMax can settle them.
		readChunks(func(p []byte) {
			os.Stdout.Write(p)
			if bytes.Contains(p, []byte("burst")) {
				go func() {
					for i := 0; i < 50; i++ {
						os.Stdout.WriteString(`{"said":"out"}` + "\n")
						time.Sleep(10 * time.Millisecond)
					}
				}()
			}
		})
	case "lines":
		// Reads lines, as an adapter does, and echoes each.
		scan := bufio.NewScanner(os.Stdin)
		for scan.Scan() {
			line, _ := json.Marshal(map[string]string{"got": scan.Text()})
			os.Stdout.Write(append(line, '\n'))
		}
	}
	os.Exit(0)
}

func readChunks(fn func([]byte)) {
	buf := make([]byte, 64*1024)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			fn(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func testAgent(behavior string) []string {
	return []string{"env", "ACPD_TEST_AGENT=" + behavior, os.Args[0]}
}

// A socket path short enough for SUN_PATH_MAX, which t.TempDir's is not.
func sockPath(t *testing.T) string {
	dir, err := os.MkdirTemp("", "acpd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "agent.sock")
}

func logPath(t *testing.T) string {
	return filepath.Join(t.TempDir(), "c.jsonl")
}

func start(t *testing.T, argv []string, opts ...func(*config)) (*daemon, string) {
	t.Helper()
	cfg := config{sock: sockPath(t), argv: argv}
	for _, opt := range opts {
		opt(&cfg)
	}
	d := newDaemon(cfg)
	t.Cleanup(d.close)
	if err := d.listen(); err != nil {
		t.Fatal(err)
	}
	return d, cfg.sock
}

func withLog(path string) func(*config) {
	return func(c *config) { c.logPath = path }
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A connected client and every line acpd has sent it.
type peer struct {
	conn   net.Conn
	mu     sync.Mutex
	lines  []string
	closed bool
}

func connect(t *testing.T, sock string) *peer {
	t.Helper()
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	p := &peer{conn: conn}
	go func() {
		r := bufio.NewReader(conn)
		for {
			line, err := r.ReadString('\n')
			p.mu.Lock()
			if err != nil {
				p.closed = true
				p.mu.Unlock()
				return
			}
			p.lines = append(p.lines, strings.TrimSuffix(line, "\n"))
			p.mu.Unlock()
		}
	}()
	return p
}

func (p *peer) snapshot() ([]string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.lines), p.closed
}

func (p *peer) waitFor(t *testing.T, what string, pred func([]string) bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		lines, _ := p.snapshot()
		if pred(lines) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; saw %q", what, lines)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (p *peer) waitClosed(t *testing.T) {
	t.Helper()
	waitUntil(t, "the connection to close", func() bool { _, closed := p.snapshot(); return closed })
}

func (p *peer) send(t *testing.T, s string) {
	t.Helper()
	if _, err := p.conn.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
}

func lineCount(n int) func([]string) bool {
	return func(l []string) bool { return len(l) >= n }
}

func anyContains(s string) func([]string) bool {
	return func(l []string) bool {
		return slices.ContainsFunc(l, func(line string) bool { return strings.Contains(line, s) })
	}
}

func parse(t *testing.T, line string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(line), &v); err != nil {
		t.Fatalf("not JSON: %q", line)
	}
	return v
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, _ := os.ReadFile(path)
	return string(b)
}

// A record's lines after its head: the life line and the first time mark.
func relayed(t *testing.T, path string) []string {
	lines := strings.Split(strings.TrimSpace(readFile(t, path)), "\n")
	if len(lines) < 2 {
		return nil
	}
	return lines[2:]
}

// Write to the agent as if a client had, attached or not.
func toAgent(t *testing.T, d *daemon, s string) {
	t.Helper()
	d.mu.Lock()
	stdin := d.child.stdin
	d.mu.Unlock()
	if _, err := stdin.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
}

// Break the record the way a full disk does, so the restart path can be
// driven without one.
func breakRecord(d *daemon) *agent {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.rec.Close()
	return d.child
}

func currentChild(d *daemon) *agent {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.child
}

const hello = `{"jsonrpc":"2.0","method":"_acpd/hello","params":{"firstAttach":%t}}`

func TestParseArgs(t *testing.T) {
	cfg, err := parseArgs([]string{
		"--sock", "/s", "--log", "/l", "--cwd", "/w",
		"--wait-for", "/w/a/.git", "--wait-for", "/w/b/.git", "--", "agent", "--wait-for", "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := config{sock: "/s", logPath: "/l", cwd: "/w",
		waitFor: []string{"/w/a/.git", "/w/b/.git"}, argv: []string{"agent", "--wait-for", "x"}}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("got %+v", cfg)
	}
	for _, bad := range [][]string{
		{"--sock", "/s", "agent"},
		{"--log", "/l", "--", "agent"},
		{"--sock", "/s", "--"},
		{"--sock"},
		{"--sock", "/s", "--bogus", "x", "--", "agent"},
	} {
		if _, err := parseArgs(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestFirstAttachOnlyForTheFirstClient(t *testing.T) {
	// A reattach skips the handshake.
	_, sock := start(t, []string{"cat"})
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	if lines, _ := a.snapshot(); lines[0] != fmt.Sprintf(hello, true) {
		t.Fatalf("first hello %q", lines[0])
	}
	a.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`+"\n")
	a.waitFor(t, "echo", lineCount(2))
	a.conn.Close()

	b := connect(t, sock)
	b.waitFor(t, "hello", lineCount(1))
	if lines, _ := b.snapshot(); lines[0] != fmt.Sprintf(hello, false) {
		t.Fatalf("second hello %q", lines[0])
	}
}

func TestFirstAttachWhenThePreviousClientNeverSpoke(t *testing.T) {
	_, sock := start(t, []string{"cat"})
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.conn.Close()
	time.Sleep(50 * time.Millisecond)

	b := connect(t, sock)
	b.waitFor(t, "hello", lineCount(1))
	if lines, _ := b.snapshot(); lines[0] != fmt.Sprintf(hello, true) {
		t.Fatalf("hello %q", lines[0])
	}
}

func TestRecordsBothDirectionsAttachedOrNot(t *testing.T) {
	log := logPath(t)
	d, sock := start(t, []string{"cat"}, withLog(log))
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.send(t, `{"said":"while attached"}`+"\n")
	a.waitFor(t, "echo", anyContains("while attached"))
	a.conn.Close()
	time.Sleep(50 * time.Millisecond)

	toAgent(t, d, `{"said":"while detached"}`+"\n")
	waitUntil(t, "the detached line", func() bool { return strings.Contains(readFile(t, log), "while detached") })
	recorded := readFile(t, log)
	if !strings.Contains(strings.Split(recorded, "\n")[0], "_acpd/life") || !strings.Contains(recorded, "while attached") {
		t.Fatalf("record %q", recorded)
	}
}

func TestSyncsAfterClientLinesPausesAndBurstsAcrossARename(t *testing.T) {
	dir := t.TempDir()
	launch := filepath.Join(dir, "launch.jsonl")
	adopted := filepath.Join(dir, "session.jsonl")
	var syncs atomic.Int32
	_, sock := start(t, testAgent("burst"), withLog(launch), func(c *config) {
		c.sync = func(f *os.File) error { syncs.Add(1); return fdatasync(f) }
	})
	if syncs.Load() != 1 {
		t.Fatalf("%d syncs at start", syncs.Load())
	}

	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.send(t, `{"said":"prompt"}`+"\n")
	// The client line syncs at once; the agent's echo after the pause.
	a.waitFor(t, "echo", anyContains("prompt"))
	waitUntil(t, "the echo to settle", func() bool { return syncs.Load() >= 3 })

	// The server adopts the record under the session's name mid-conversation.
	if err := os.Rename(launch, adopted); err != nil {
		t.Fatal(err)
	}
	a.send(t, `{"said":"burst"}`+"\n")
	a.waitFor(t, "burst echo", anyContains("burst"))
	before := syncs.Load()
	time.Sleep(450 * time.Millisecond)
	if syncs.Load() < before+2 {
		t.Fatalf("a busy record synced %d times in 450ms", syncs.Load()-before)
	}
	a.waitFor(t, "the burst", func(l []string) bool {
		return len(slices.DeleteFunc(slices.Clone(l), func(s string) bool { return !strings.Contains(s, `"out"`) })) == 50
	})

	// Written to the open file, never reopened by path: a reopen cannot
	// follow a rename made from another node.
	if _, err := os.Stat(launch); err == nil {
		t.Fatal("the record was reopened under its old name")
	}
	var said []string
	waitUntil(t, "the burst to be recorded", func() bool {
		said = nil
		for _, line := range strings.Split(strings.TrimSpace(readFile(t, adopted)), "\n")[1:] {
			if !strings.Contains(line, "_acpd/") {
				said = append(said, parse(t, line)["said"].(string))
			}
		}
		return len(said) == 54
	})
	want := []string{"prompt", "prompt", "burst", "burst"}
	for len(want) < 54 {
		want = append(want, "out")
	}
	if !slices.Equal(said, want) {
		t.Fatalf("recorded %q", said)
	}
}

func TestDatesWhatItRecordsWithAtMostOneMarkASecond(t *testing.T) {
	log := logPath(t)
	t0 := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	now := t0
	advance := func(by time.Duration) { mu.Lock(); now = now.Add(by); mu.Unlock() }
	d, _ := start(t, []string{"cat"}, withLog(log), func(c *config) {
		c.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	})
	say := func(said string) {
		toAgent(t, d, fmt.Sprintf(`{"said":%q}`+"\n", said))
		waitUntil(t, said, func() bool { return strings.Contains(readFile(t, log), said) })
	}
	say("at start")
	advance(999 * time.Millisecond)
	say("within the second")
	advance(time.Millisecond)
	say("a second on")
	say("same instant")
	advance(time.Minute)
	say("a minute on")

	lines := strings.Split(strings.TrimSpace(readFile(t, log)), "\n")
	if !strings.Contains(lines[0], `"startedAt":"2026-10-17T12:00:00.000Z"`) {
		t.Fatalf("life %q", lines[0])
	}
	mark := func(at time.Time) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","method":"_acpd/time","params":{"at":%d}}`, at.UnixMilli())
	}
	want := []string{
		mark(t0),
		`{"said":"at start"}`,
		`{"said":"within the second"}`,
		mark(t0.Add(time.Second)),
		`{"said":"a second on"}`,
		`{"said":"same instant"}`,
		mark(t0.Add(61 * time.Second)),
		`{"said":"a minute on"}`,
	}
	if !slices.Equal(lines[1:], want) {
		t.Fatalf("record\n%s", strings.Join(lines[1:], "\n"))
	}
}

func TestRecordsWholeLinesWhenOneSideSpeaksMidLine(t *testing.T) {
	log := logPath(t)
	_, sock := start(t, testAgent("bang"), withLog(log))
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.send(t, `{"user":"a long line!`)
	a.waitFor(t, "the agent", anyContains("spoke"))
	a.send(t, `"}`+"\n")
	waitUntil(t, "the client line", func() bool { return strings.Contains(readFile(t, log), `long line!"}`) })
	if got := relayed(t, log); !slices.Equal(got, []string{`{"agent":"spoke"}`, `{"user":"a long line!"}`}) {
		t.Fatalf("record %q", got)
	}
}

func TestStoresImagesBesideTheRecordRelayingThemUnchanged(t *testing.T) {
	log := logPath(t)
	_, sock := start(t, []string{"cat"}, withLog(log))
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 64*1024)...)
	b64 := base64.StdEncoding.EncodeToString(png)
	sum := sha256.Sum256(png)
	hash := hex.EncodeToString(sum[:])
	ref := "yaac-image:" + hash
	// A second image whose base64 would need padding, sent without it.
	unpadded := append(slices.Clone(png), 1)
	sum = sha256.Sum256(unpadded)
	unpaddedHash := hex.EncodeToString(sum[:])
	// An ACP image block, the same image in an Anthropic-style source and
	// under claude's `toolResponse` key, the image's base64 in fields the
	// pane renders as text, a long string that is not an image, and an
	// image too small to matter, and an image sent unpadded. Spacing and key order are the agent's, and
	// the record keeps them.
	template := `{"prompt":[{"type":"image","mimeType":"image/png","data":"%[1]s"}],` +
		`"rawOutput":[{"type":"image","source":{"type":"base64","media_type":"image/png", "data" : "%[1]s"}}],` +
		`"_meta":{"claudeCode":{"toolResponse":{"type":"image","file":{"base64":"%[1]s","type":"image/png"}}},` +
		`"terminal_output":{"data":"%[2]s"},"terminal_output_delta":{"data":"%[2]s"}},` +
		`"content":[{"type":"diff","path":"fixture.b64","newText":"%[2]s"},` +
		`{"type":"content","content":{"type":"text","text":"%[2]s"}}],` +
		`"text":{"data":"%[3]s"},"icon":{"type":"image","data":"%[4]s"},"n":1.50,` +
		`"shot":{"type":"image","data":"%[5]s"}}`
	small := base64.StdEncoding.EncodeToString(png[:100])
	notImage := strings.Repeat("x", 20_000)
	line := fmt.Sprintf(template, b64, b64, notImage, small, base64.RawStdEncoding.EncodeToString(unpadded))
	stored := fmt.Sprintf(template, ref, b64, notImage, small, "yaac-image:"+unpaddedHash)

	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	// In chunks, as a large write arrives; `cat` echoes it as agent output.
	a.send(t, line[:5000])
	time.Sleep(20 * time.Millisecond)
	a.send(t, line[5000:]+"\n")
	a.waitFor(t, "echo", lineCount(2))
	if lines, _ := a.snapshot(); lines[1] != line {
		t.Fatal("the relayed line differs from what was sent")
	}

	waitUntil(t, "both lines recorded", func() bool { return len(relayed(t, log)) == 2 })
	if got := relayed(t, log); got[0] != stored || got[1] != stored {
		t.Fatalf("recorded %.300q", got[0])
	}
	images := filepath.Join(filepath.Dir(log), "images")
	if b, _ := os.ReadFile(filepath.Join(images, hash)); !bytes.Equal(b, png) {
		t.Fatal("stored image differs")
	}
	if b, _ := os.ReadFile(filepath.Join(images, unpaddedHash)); !bytes.Equal(b, unpadded) {
		t.Fatal("stored unpadded image differs")
	}
	if entries, _ := os.ReadDir(images); len(entries) != 2 {
		t.Fatalf("%d files in images/", len(entries))
	}
}

func TestEndsALineItsClientAbandoned(t *testing.T) {
	// So the next client's first line arrives whole.
	_, sock := start(t, testAgent("lines"), withLog(logPath(t)))
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.send(t, `{"cut":"sho`)
	time.Sleep(50 * time.Millisecond)
	a.conn.Close()
	time.Sleep(50 * time.Millisecond)

	b := connect(t, sock)
	b.waitFor(t, "hello", lineCount(1))
	b.send(t, `{"next":"request"}`+"\n")
	b.waitFor(t, "the whole line", anyContains(`{"got":"{\"next\":\"request\"}"}`))
}

func TestDoesNotReplayToANewClient(t *testing.T) {
	// The record is what it missed.
	log := logPath(t)
	d, sock := start(t, []string{"cat"}, withLog(log))
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.conn.Close()
	time.Sleep(50 * time.Millisecond)
	toAgent(t, d, `{"missed":true}`+"\n")
	waitUntil(t, "the missed line", func() bool { return strings.Contains(readFile(t, log), `"missed"`) })

	b := connect(t, sock)
	b.waitFor(t, "hello", lineCount(1))
	time.Sleep(100 * time.Millisecond)
	if lines, _ := b.snapshot(); anyContains(`"missed"`)(lines) {
		t.Fatal("replayed to a new client")
	}
}

func TestRecordsTheAgentsExit(t *testing.T) {
	// A detached client would never see it.
	log := logPath(t)
	d, _ := start(t, []string{"sh", "-c", "exit 4"}, withLog(log))
	if code := d.wait(); code != 4 {
		t.Fatalf("exit code %d", code)
	}
	if got := relayed(t, log); !slices.Equal(got, []string{`{"jsonrpc":"2.0","method":"_acpd/exit","params":{"code":4,"signal":null}}`}) {
		t.Fatalf("record %q", got)
	}
}

func TestReportsAnAgentKilledBySignal(t *testing.T) {
	log := logPath(t)
	d, _ := start(t, []string{"sh", "-c", "kill -TERM $$"}, withLog(log))
	if code := d.wait(); code != 1 {
		t.Fatalf("exit code %d", code)
	}
	if got := relayed(t, log); !slices.Equal(got, []string{`{"jsonrpc":"2.0","method":"_acpd/exit","params":{"code":0,"signal":"SIGTERM"}}`}) {
		t.Fatalf("record %q", got)
	}
}

func TestExitsWhenTheAgentCannotBeSpawned(t *testing.T) {
	d, _ := start(t, []string{"/nonexistent/agent"}, withLog(logPath(t)))
	if code := d.wait(); code != 127 {
		t.Fatalf("exit code %d", code)
	}
}

func TestRestartsTheAgentUnderAFreshRecordWhenTheRecordFails(t *testing.T) {
	log := logPath(t)
	d, sock := start(t, []string{"cat"}, withLog(log))
	a := connect(t, sock)
	a.waitFor(t, "hello", anyContains("_acpd/hello"))
	firstLife := strings.Split(readFile(t, log), "\n")[0]

	first := breakRecord(d)
	toAgent(t, d, `{"triggers":"the write"}`+"\n")
	a.waitClosed(t)
	waitUntil(t, "a new agent", func() bool { return currentChild(d) != first })

	b := connect(t, sock)
	b.waitFor(t, "hello", anyContains("_acpd/hello"))
	if lines, _ := b.snapshot(); lines[0] != fmt.Sprintf(hello, true) {
		t.Fatalf("hello %q", lines[0])
	}
	secondLife := strings.Split(readFile(t, log), "\n")[0]
	if !strings.Contains(secondLife, "_acpd/life") || secondLife == firstLife {
		t.Fatalf("life %q after %q", secondLife, firstLife)
	}
	b.send(t, `{"after":"restart"}`+"\n")
	b.waitFor(t, "echo", anyContains(`"after"`))
}

func TestARestartForgetsALineReadAsItBegan(t *testing.T) {
	// A client line read just before a record restart must not count as a
	// handshake with the agent that replaces it.
	d, sock := start(t, []string{"cat"}, withLog(logPath(t)))
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	first := currentChild(d)

	d.mu.Lock()
	a.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`+"\n")
	// The reader has the line and waits for the lock while the record fails.
	time.Sleep(50 * time.Millisecond)
	d.recordFailed(errors.New("disk full"))
	d.mu.Unlock()
	a.waitClosed(t)
	waitUntil(t, "a new agent", func() bool { return currentChild(d) != first })

	b := connect(t, sock)
	b.waitFor(t, "hello", lineCount(1))
	if lines, _ := b.snapshot(); lines[0] != fmt.Sprintf(hello, true) {
		t.Fatalf("hello %q", lines[0])
	}
}

func TestRefusesAnAttachWhileTheAgentIsRestarting(t *testing.T) {
	// An agent that ignores SIGTERM keeps the restart open for the full grace.
	d, sock := start(t, []string{"sh", "-c", `trap "" TERM; while IFS= read -r l; do printf "%s\n" "$l"; done`}, withLog(logPath(t)), func(c *config) {
		c.killGrace = 300 * time.Millisecond
	})
	a := connect(t, sock)
	a.waitFor(t, "hello", anyContains("_acpd/hello"))

	first := breakRecord(d)
	toAgent(t, d, `{"triggers":"the write"}`+"\n")
	a.waitClosed(t)

	during := connect(t, sock)
	during.waitClosed(t)
	if lines, _ := during.snapshot(); len(lines) != 0 {
		t.Fatalf("a refused client got %q", lines)
	}

	waitUntil(t, "a new agent", func() bool { return currentChild(d) != first })
	after := connect(t, sock)
	after.waitFor(t, "hello", anyContains(`"firstAttach":true`))
}

func TestGivesUpWhenTheRecordCannotBeRepaired(t *testing.T) {
	// A directory where the record should be, so every open fails.
	log := logPath(t)
	if err := os.Mkdir(log, 0o755); err != nil {
		t.Fatal(err)
	}
	d, _ := start(t, []string{"cat"}, withLog(log))
	if currentChild(d) != nil {
		t.Fatal("started an agent with no record")
	}
	if code := d.wait(); code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestRelaysWithoutARecordWhenNoneWasAskedFor(t *testing.T) {
	_, sock := start(t, []string{"cat"})
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.send(t, `{"still":"works"}`+"\n")
	a.waitFor(t, "echo", anyContains("works"))
}

func TestDisplacesAStaleClient(t *testing.T) {
	// So a half-open socket cannot lock the agent out.
	_, sock := start(t, []string{"cat"})
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	b := connect(t, sock)
	b.waitFor(t, "hello", lineCount(1))
	a.waitClosed(t)
	b.send(t, `{"mine":1}`+"\n")
	b.waitFor(t, "echo", anyContains(`"mine"`))
}

func TestKeepsAHalfClosedClientAttached(t *testing.T) {
	// A client's half-close must not end the agent's stdin.
	d, sock := start(t, []string{"cat"})
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.conn.(*net.UnixConn).CloseWrite()
	time.Sleep(50 * time.Millisecond)
	toAgent(t, d, `{"still":"attached"}`+"\n")
	a.waitFor(t, "output after the half-close", anyContains("attached"))
}

func TestReportsTheAgentExitingToTheClient(t *testing.T) {
	// So the server never waits on a dead process.
	_, sock := start(t, []string{"sh", "-c", "read x; exit 3"})
	a := connect(t, sock)
	a.waitFor(t, "hello", lineCount(1))
	a.send(t, "go\n")
	a.waitFor(t, "exit", anyContains("_acpd/exit"))
	lines, _ := a.snapshot()
	if got := parse(t, lines[len(lines)-1])["params"].(map[string]any)["code"]; got != 3.0 {
		t.Fatalf("code %v", got)
	}
}

func TestRemovesItsSocketWhenTheAgentDies(t *testing.T) {
	// So a dead window cannot look attachable.
	d, sock := start(t, []string{"sh", "-c", "exit 0"})
	d.wait()
	if _, err := os.Stat(sock); err == nil {
		t.Fatal("socket left behind")
	}
}

func TestReplacesASocketFileLeftByAPreviousLife(t *testing.T) {
	sock := sockPath(t)
	if err := os.WriteFile(sock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	_, got := start(t, []string{"cat"}, func(c *config) { c.sock = sock })
	connect(t, got).waitFor(t, "hello", lineCount(1))
}

func TestRunsTheAgentInTheCwdItWasHanded(t *testing.T) {
	// A wrong cwd makes the spawn fail, which looks like a missing binary
	// and takes the workspace down.
	dir := t.TempDir()
	log := filepath.Join(dir, "c.jsonl")
	start(t, []string{"sh", "-c", "pwd -P; exec cat"}, withLog(log), func(c *config) { c.cwd = dir })
	real, _ := filepath.EvalSymlinks(dir)
	// Output before any attach reaches only the record.
	waitUntil(t, "the agent's cwd", func() bool { return strings.Contains(readFile(t, log), real) })
}

func TestDefaultsToItsOwnDirectory(t *testing.T) {
	// Every driver starts the tmux session in the workspace.
	log := logPath(t)
	start(t, []string{"sh", "-c", "pwd -P; exec cat"}, withLog(log))
	wd, _ := os.Getwd()
	real, _ := filepath.EvalSymlinks(wd)
	waitUntil(t, "the agent's cwd", func() bool { return strings.Contains(readFile(t, log), real) })
}

func TestHoldsAClientUntilEveryCheckoutExists(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "c.jsonl")
	first := filepath.Join(dir, "a", ".git")
	second := filepath.Join(dir, "b", ".git")
	_, sock := start(t, []string{"sh", "-c", "echo booted; exec cat"}, withLog(log), func(c *config) {
		c.waitFor = []string{first, second}
	})
	// The agent boots while the checkouts are still being written.
	waitUntil(t, "the agent to boot", func() bool { return strings.Contains(readFile(t, log), "booted") })

	// A client connects, but its handshake cannot start before the hello.
	a := connect(t, sock)
	a.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`+"\n")
	os.MkdirAll(second, 0o755)
	time.Sleep(200 * time.Millisecond)
	if lines, _ := a.snapshot(); len(lines) != 0 {
		t.Fatalf("served before the first checkout landed: %q", lines)
	}

	os.MkdirAll(first, 0o755)
	a.waitFor(t, "hello and echo", lineCount(2))
	lines, _ := a.snapshot()
	if lines[0] != fmt.Sprintf(hello, true) || parse(t, lines[1])["method"] != "initialize" {
		t.Fatalf("got %q", lines)
	}
}

func TestDialWaitsForTheSocketAndRelaysBothWays(t *testing.T) {
	sock := sockPath(t)
	inR, inW := io.Pipe()
	var out lockedBuffer
	exited := make(chan int, 1)
	// Dialed before acpd binds, as a window's first dial usually is.
	go func() { exited <- dial(sock, inR, &out) }()
	time.Sleep(100 * time.Millisecond)
	start(t, []string{"cat"}, func(c *config) { c.sock = sock })

	waitUntil(t, "hello through the dial", func() bool { return strings.Contains(out.String(), "_acpd/hello") })
	inW.Write([]byte(`{"via":"dial"}` + "\n"))
	waitUntil(t, "echo through the dial", func() bool { return strings.Contains(out.String(), `{"via":"dial"}`) })

	// The server's stream closing ends the dial.
	inW.Close()
	select {
	case code := <-exited:
		if code != 0 {
			t.Fatalf("dial exited %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the dial outlived its stdin")
	}
}

func TestDialEndsWhenAcpdCloses(t *testing.T) {
	d, sock := start(t, []string{"cat"})
	inR, _ := io.Pipe()
	var out lockedBuffer
	exited := make(chan int, 1)
	go func() { exited <- dial(sock, inR, &out) }()
	waitUntil(t, "hello through the dial", func() bool { return strings.Contains(out.String(), "_acpd/hello") })
	d.close()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the dial outlived acpd")
	}
}

func TestDialGivesUpOnASocketThatNeverAppears(t *testing.T) {
	defer func(r int, i time.Duration) { dialRetries, dialInterval = r, i }(dialRetries, dialInterval)
	dialRetries, dialInterval = 3, time.Millisecond
	if code := dial(sockPath(t), strings.NewReader(""), io.Discard); code != 1 {
		t.Fatalf("dial exited %d", code)
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
