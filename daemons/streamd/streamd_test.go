package main

// The daemon over loopback sockets: the handshake, each splicing and
// command kind, the pty kind and its output batcher.

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const testToken = "test-token-0123456789abcdef"

// startDaemon serves a daemon on a loopback port for the test's life.
func startDaemon(t *testing.T, configure ...func(*config)) int {
	t.Helper()
	cfg := defaultConfig(testToken)
	for _, f := range configure {
		f(&cfg)
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go newDaemon(cfg).serve(ln)
	return ln.Addr().(*net.TCPAddr).Port
}

type client struct {
	t    *testing.T
	conn *net.TCPConn
	r    *bufio.Reader
}

// open dials and sends the handshake line, with `extra` in the same write.
func open(t *testing.T, port int, hs any, extra ...byte) *client {
	t.Helper()
	conn, err := net.Dial("tcp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	line, _ := json.Marshal(hs)
	if _, err := conn.Write(append(append(line, '\n'), extra...)); err != nil {
		t.Fatal(err)
	}
	return &client{t: t, conn: conn.(*net.TCPConn), r: bufio.NewReader(conn)}
}

func (c *client) line() string {
	c.t.Helper()
	s, err := c.r.ReadString('\n')
	if err != nil {
		c.t.Fatalf("reading a line: %v (got %q)", err, s)
	}
	return s
}

func (c *client) reply() reply {
	c.t.Helper()
	var r reply
	if err := json.Unmarshal([]byte(c.line()), &r); err != nil {
		c.t.Fatal(err)
	}
	return r
}

func (c *client) mustOK() *client {
	c.t.Helper()
	if r := c.reply(); !r.OK {
		c.t.Fatalf("refused: %s", r.Error)
	}
	return c
}

// rest reads to the end of the stream.
func (c *client) rest() []byte {
	c.t.Helper()
	b, err := io.ReadAll(c.r)
	if err != nil {
		c.t.Fatalf("reading to the end: %v", err)
	}
	return b
}

func (c *client) execResult() map[string]any {
	c.t.Helper()
	var res map[string]any
	if err := json.Unmarshal(c.rest(), &res); err != nil {
		c.t.Fatal(err)
	}
	return res
}

func execHS(cmd ...string) map[string]any {
	return map[string]any{"token": testToken, "kind": "exec", "cmd": cmd}
}

func TestHandshake(t *testing.T) {
	port := startDaemon(t)
	for _, tc := range []struct {
		name string
		hs   any
		want string
	}{
		{"a bad token", map[string]any{"token": "wrong", "kind": "exec", "cmd": []string{"true"}}, "bad token"},
		{"an unknown kind", map[string]any{"token": testToken, "kind": "nope"}, `unknown kind "nope"`},
		{"a missing kind", map[string]any{"token": testToken}, "unknown kind undefined"},
		{"a token that is not a string", map[string]any{"token": 5}, "malformed handshake"},
		{"a line that is not an object", []int{1}, "malformed handshake"},
		{"an invalid parameter", map[string]any{"token": testToken, "kind": "tcp", "port": "80"}, "tcp: invalid port"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := open(t, port, tc.hs)
			if r := c.reply(); r.OK || r.Error != tc.want {
				t.Fatalf("got %+v, want the refusal %q", r, tc.want)
			}
			// The refusal is the whole stream.
			if rest := c.rest(); len(rest) != 0 {
				t.Fatalf("more after the refusal: %q", rest)
			}
		})
	}

	t.Run("takes a line up to the cap, and closes on a longer one", func(t *testing.T) {
		port := startDaemon(t, func(c *config) { c.handshakeMaxBytes = 200 })
		// A handshake of n bytes before its newline.
		line := func(n int) []byte {
			head := `{"token":"` + testToken + `","kind":"nope","pad":"`
			return []byte(head + strings.Repeat("x", n-len(head)-2) + "\"}\n")
		}
		send := func(b []byte) string {
			conn, err := net.Dial("tcp4", "127.0.0.1:"+strconv.Itoa(port))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
			_, _ = conn.Write(b)
			got, _ := io.ReadAll(conn)
			return string(got)
		}
		if got := send(line(200)); !strings.Contains(got, `unknown kind \"nope\"`) {
			t.Fatalf("a line at the cap got %q", got)
		}
		if got := send(line(201)); got != "" {
			t.Fatalf("a line past the cap got %q", got)
		}
	})

	t.Run("a line that is not JSON", func(t *testing.T) {
		conn, err := net.Dial("tcp4", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_, _ = conn.Write([]byte("not json\n"))
		got, _ := io.ReadAll(conn)
		if string(got) != `{"ok":false,"error":"malformed handshake"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestExec(t *testing.T) {
	port := startDaemon(t)

	t.Run("runs the argv and reports its exit and output as one JSON line", func(t *testing.T) {
		c := open(t, port, execHS("sh", "-c", "echo out; echo err >&2; exit 0")).mustOK()
		res := c.execResult()
		if res["exitCode"] != 0.0 || res["stdout"] != "out\n" || res["stderr"] != "err\n" {
			t.Fatalf("got %v", res)
		}
	})

	t.Run("reports a nonzero exit", func(t *testing.T) {
		res := open(t, port, execHS("sh", "-c", "echo nope >&2; exit 7")).mustOK().execResult()
		if res["exitCode"] != 7.0 || res["stderr"] != "nope\n" {
			t.Fatalf("got %v", res)
		}
	})

	// The server acts on a 127 (reporting a tool missing), so a command
	// that never ran must be told apart.
	t.Run("marks a command it could not start", func(t *testing.T) {
		res := open(t, port, execHS("/nonexistent/binary")).mustOK().execResult()
		if res["exitCode"] != 127.0 || res["spawnFailed"] != true {
			t.Fatalf("got %v", res)
		}
	})

	// Otherwise the server reads a killed probe as a real failure.
	t.Run("reports the signal that killed the command", func(t *testing.T) {
		res := open(t, port, execHS("sh", "-c", "kill -KILL $$")).mustOK().execResult()
		if res["signal"] != "SIGKILL" || res["exitCode"] != 1.0 {
			t.Fatalf("got %v", res)
		}
	})

	t.Run("sends HTML characters as they are", func(t *testing.T) {
		c := open(t, port, execHS("printf", "<a>&</a>")).mustOK()
		if raw := c.rest(); !bytes.Contains(raw, []byte(`"stdout":"<a>&</a>"`)) {
			t.Fatalf("got %s", raw)
		}
	})

	// Multibyte and past any pipe buffer; part of it rides with the
	// handshake, the rest comes later, and bytes past the count are not the
	// command's.
	t.Run("feeds the command the byte count its handshake names, however it arrives", func(t *testing.T) {
		input := bytes.Repeat([]byte("é✓🙂 line\n"), 60_000)
		hs := map[string]any{"token": testToken, "kind": "exec", "cmd": []string{"sh", "-c", "cat"}, "stdin": len(input)}
		c := open(t, port, hs, input[:1000]...)
		go func() {
			time.Sleep(50 * time.Millisecond)
			_, _ = c.conn.Write(append(append([]byte{}, input[1000:]...), []byte("extra")...))
		}()
		c.mustOK()
		res := c.execResult()
		if res["exitCode"] != 0.0 || res["stdout"] != string(input) {
			t.Fatalf("exit %v, stdout of %d bytes, want %d", res["exitCode"], len(res["stdout"].(string)), len(input))
		}
	})

	t.Run("refuses a stdin that is not a byte count", func(t *testing.T) {
		hs := map[string]any{"token": testToken, "kind": "exec", "cmd": []string{"cat"}, "stdin": -1}
		if r := open(t, port, hs).reply(); r.Error != "exec: stdin must be a byte count" {
			t.Fatalf("got %+v", r)
		}
	})

	t.Run("cuts output past the cap, without stopping the command", func(t *testing.T) {
		port := startDaemon(t, func(c *config) { c.execOutputMaxBytes = 1024 })
		res := open(t, port, execHS("sh", "-c", "head -c 100000 /dev/zero | tr '\\0' x; echo done >&2")).mustOK().execResult()
		if res["exitCode"] != 0.0 || res["truncated"] != true || len(res["stdout"].(string)) != 1024 || res["stderr"] != "done\n" {
			t.Fatalf("exit %v truncated %v stdout %d bytes stderr %q", res["exitCode"], res["truncated"], len(res["stdout"].(string)), res["stderr"])
		}
	})

	// A script cut short must not run its first half.
	t.Run("never hands the command input cut short", func(t *testing.T) {
		port := startDaemon(t, func(c *config) { c.killGrace = 200 * time.Millisecond })
		dir := t.TempDir()
		pidFile, eof := filepath.Join(dir, "pid"), filepath.Join(dir, "eof")
		// It outlives SIGTERM, so only an EOF on its input lets it reach the touch.
		script := `echo $$ >"$0"; trap "" TERM; cat >/dev/null; touch "$1"`
		hs := map[string]any{"token": testToken, "kind": "exec", "cmd": []string{"sh", "-c", script, pidFile, eof}, "stdin": 100}
		c := open(t, port, hs, []byte("only part")...).mustOK()
		var pid int
		waitFor(t, func() bool {
			b, _ := os.ReadFile(pidFile)
			pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
			return pid != 0
		})
		_ = c.conn.Close()
		waitFor(t, func() bool { return !alive(pid) })
		if _, err := os.Stat(eof); err == nil {
			t.Fatal("the command read an EOF after part of its input")
		}
	})

	// A caller that gave up must not leave the command's children running.
	t.Run("ends the command's whole process group when the stream closes early", func(t *testing.T) {
		c := open(t, port, execHS("sh", "-c", "sleep 30 & wait")).mustOK()
		var sleeper int
		waitFor(t, func() bool {
			sleeper = sleeperOf(t, os.Getpid())
			return sleeper != 0
		})
		_ = c.conn.Close()
		waitFor(t, func() bool { return !alive(sleeper) })
	})
}

// sleeperOf is the pid of a `sleep` whose grandparent is `pid`, or 0.
func sleeperOf(t *testing.T, pid int) int {
	out, err := exec.Command("ps", "-eo", "pid=,ppid=,comm=").Output()
	if err != nil {
		t.Fatal(err)
	}
	type row struct{ pid, ppid int }
	var rows []row
	sleepers := map[int]int{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		p, _ := strconv.Atoi(f[0])
		pp, _ := strconv.Atoi(f[1])
		rows = append(rows, row{p, pp})
		if f[2] == "sleep" {
			sleepers[p] = pp
		}
	}
	for _, r := range rows {
		if r.ppid != pid {
			continue
		}
		for s, parent := range sleepers {
			if parent == r.pid {
				return s
			}
		}
	}
	return 0
}

func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); !cond(); {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCtrl(t *testing.T) {
	port := startDaemon(t)

	t.Run("splices stdin and stdout raw, and ends the stream when the child exits", func(t *testing.T) {
		c := open(t, port, map[string]any{"token": testToken, "kind": "ctrl", "cmd": []string{"cat"}}, []byte("line one\n")...).mustOK()
		_ = c.conn.CloseWrite()
		if got := c.rest(); string(got) != "line one\n" {
			t.Fatalf("got %q", got)
		}
	})

	// A client's EOF only closes the child's stdin; a stream that can no
	// longer take its output ends it.
	t.Run("ends the child when its output cannot be delivered", func(t *testing.T) {
		c := open(t, port, map[string]any{"token": testToken, "kind": "ctrl", "cmd": []string{"sh", "-c", "echo $$; while sleep 0.05; do echo tick; done"}}).mustOK()
		pid, err := strconv.Atoi(strings.TrimSpace(c.line()))
		if err != nil {
			t.Fatal(err)
		}
		_ = c.conn.Close()
		waitFor(t, func() bool { return !alive(pid) })
	})
}

// A loopback server standing in for an in-pod dev server: it answers with
// everything it read, once the client's side ends.
func startEcho(t *testing.T, network, addr string) net.Listener {
	t.Helper()
	ln, err := net.Listen(network, addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				got, _ := io.ReadAll(c)
				_, _ = c.Write(append([]byte("got:"), got...))
			}()
		}
	}()
	return ln
}

func TestTCP(t *testing.T) {
	port := startDaemon(t)
	echo := startEcho(t, "tcp4", "127.0.0.1:0")

	t.Run("carries the client's EOF to the target, and the answer back", func(t *testing.T) {
		hs := map[string]any{"token": testToken, "kind": "tcp", "port": echo.Addr().(*net.TCPAddr).Port}
		c := open(t, port, hs, []byte("ping")...).mustOK()
		_, _ = c.conn.Write([]byte(" pong"))
		_ = c.conn.CloseWrite()
		if got := c.rest(); string(got) != "got:ping pong" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("refuses an invalid port", func(t *testing.T) {
		for _, p := range []any{"nope", 0, 70000, 80.5} {
			if r := open(t, port, map[string]any{"token": testToken, "kind": "tcp", "port": p}).reply(); r.OK {
				t.Fatalf("port %v accepted", p)
			}
		}
	})
}

func TestUnix(t *testing.T) {
	port := startDaemon(t)

	// The server dials a new acp window's socket before acpd has bound it.
	t.Run("connects once the socket is bound, holding what the client sent first", func(t *testing.T) {
		sock := filepath.Join(t.TempDir(), "a.sock")
		c := open(t, port, map[string]any{"token": testToken, "kind": "unix", "path": sock}, []byte("early ")...).mustOK()
		time.Sleep(120 * time.Millisecond)
		startEcho(t, "unix", sock)
		_, _ = c.conn.Write([]byte("late"))
		_ = c.conn.CloseWrite()
		if got := c.rest(); string(got) != "got:early late" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("refuses a stream with no path", func(t *testing.T) {
		if r := open(t, port, map[string]any{"token": testToken, "kind": "unix"}).reply(); r.OK {
			t.Fatal("accepted")
		}
	})
}

type frame struct {
	typ     byte
	payload []byte
}

func (c *client) frame() (frame, error) {
	header := make([]byte, frameHeaderBytes)
	if _, err := io.ReadFull(c.r, header); err != nil {
		return frame{}, err
	}
	payload := make([]byte, binary.BigEndian.Uint32(header[1:]))
	_, err := io.ReadFull(c.r, payload)
	return frame{header[0], payload}, err
}

// output reads frames until one with `want` in the data so far, or the exit
// frame, and returns the data and the exit frame's code (-1 if none came).
func (c *client) output(want string) (string, int) {
	c.t.Helper()
	var data strings.Builder
	for {
		f, err := c.frame()
		if err != nil {
			c.t.Fatalf("reading frames: %v (data so far %q)", err, data.String())
		}
		switch f.typ {
		case frameData:
			data.Write(f.payload)
			if want != "" && strings.Contains(data.String(), want) {
				return data.String(), -1
			}
		case frameExit:
			var exit struct{ Code int }
			_ = json.Unmarshal(f.payload, &exit)
			return data.String(), exit.Code
		}
	}
}

func ptyHS(cmd ...string) map[string]any {
	return map[string]any{"token": testToken, "kind": "pty", "cmd": cmd, "cols": 80, "rows": 24}
}

func jsonFrame(t byte, v any) []byte {
	b, _ := json.Marshal(v)
	return encodeFrame(t, b)
}

func TestPty(t *testing.T) {
	port := startDaemon(t)

	t.Run("runs the argv on a terminal, frames its output, then its exit", func(t *testing.T) {
		c := open(t, port, ptyHS("sh", "-c", "echo TERM=$TERM; exit 3")).mustOK()
		data, code := c.output("")
		if !strings.Contains(data, "TERM=xterm-256color") || code != 3 {
			t.Fatalf("got %q, exit %d", data, code)
		}
		if rest := c.rest(); len(rest) != 0 {
			t.Fatalf("more after the exit frame: %q", rest)
		}
	})

	// Frames split anywhere, the first riding with the handshake.
	t.Run("delivers input frames to the terminal, however they are split", func(t *testing.T) {
		input := append(encodeFrame(frameData, []byte("typed ")), encodeFrame(frameData, []byte("more\n"))...)
		c := open(t, port, ptyHS("cat"), input[:3]...).mustOK()
		for _, b := range input[3:] {
			_, _ = c.conn.Write([]byte{b})
		}
		if data, _ := c.output("typed more"); !strings.Contains(data, "typed more") {
			t.Fatalf("got %q", data)
		}
	})

	t.Run("resizes the terminal", func(t *testing.T) {
		c := open(t, port, ptyHS("sh", "-c", "read x; stty size")).mustOK()
		_, _ = c.conn.Write(jsonFrame(frameResize, map[string]int{"cols": 100, "rows": 30}))
		_, _ = c.conn.Write(encodeFrame(frameData, []byte("\n")))
		if data, _ := c.output(""); !strings.Contains(data, "30 100") {
			t.Fatalf("got %q", data)
		}
	})

	// node-pty reported a signalled child's exit as 0, which the server
	// takes as the session's end either way.
	t.Run("sends a signal frame's signal, and a killed child exits 0", func(t *testing.T) {
		c := open(t, port, ptyHS("sh", "-c", "echo ready; exec sleep 30")).mustOK()
		c.output("ready")
		_, _ = c.conn.Write(jsonFrame(frameSignal, map[string]string{"name": "SIGKILL"}))
		if _, code := c.output(""); code != 0 {
			t.Fatalf("exit %d", code)
		}
	})

	t.Run("hangs the child up when the client leaves, or breaks the protocol", func(t *testing.T) {
		for _, leave := range []func(c *client){
			func(c *client) { _ = c.conn.CloseWrite() },
			func(c *client) { _, _ = c.conn.Write([]byte{frameData, 0x7f, 0xff, 0xff, 0xff}) },
		} {
			c := open(t, port, ptyHS("sh", "-c", "echo $$; exec sleep 30")).mustOK()
			data, _ := c.output("\n")
			pid, err := strconv.Atoi(strings.TrimSpace(data))
			if err != nil {
				t.Fatal(err)
			}
			leave(c)
			waitFor(t, func() bool { return !alive(pid) })
		}
	})

	t.Run("starts the child in $HOME, with PWD saying so", func(t *testing.T) {
		home := os.Getenv("HOME")
		if home == "" {
			home = "/"
		}
		if data, _ := open(t, port, ptyHS("env")).mustOK().output(""); !strings.Contains(data, "\nPWD="+home+"\r") {
			t.Fatalf("got %q", data)
		}
	})

	if runtime.GOOS == "linux" {
		t.Run("takes input as UTF-8", func(t *testing.T) {
			data, _ := open(t, port, ptyHS("stty", "-a")).mustOK().output("")
			if !strings.Contains(data, " iutf8") || strings.Contains(data, "-iutf8") {
				t.Fatalf("got %q", data)
			}
		})
	}
}

// A batcher whose writes are recorded, with a window long enough that a
// loaded machine cannot stretch the gaps between pushes past it.
func recordingBatcher() (*batcher, func() []string) {
	var mu sync.Mutex
	var writes []string
	b := newBatcher(func(p []byte) {
		mu.Lock()
		defer mu.Unlock()
		writes = append(writes, string(p))
	})
	b.window = 300 * time.Millisecond
	return b, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), writes...)
	}
}

func waitForWrites(t *testing.T, writes func() []string, n int) []string {
	t.Helper()
	waitFor(t, func() bool { return len(writes()) >= n })
	return writes()
}

func TestBatcher(t *testing.T) {
	t.Run("sends a push after quiet at once, and merges the window's pushes", func(t *testing.T) {
		b, writes := recordingBatcher()
		b.push([]byte("a"))
		if got := writes(); len(got) != 1 || got[0] != "a" {
			t.Fatalf("got %q", got)
		}
		b.push([]byte("b"))
		b.push([]byte("c"))
		if got := waitForWrites(t, writes, 2); got[1] != "bc" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("sends a push after the window has passed at once again", func(t *testing.T) {
		b, writes := recordingBatcher()
		b.push([]byte("a"))
		time.Sleep(b.window + 50*time.Millisecond)
		b.push([]byte("b"))
		if got := writes(); strings.Join(got, "|") != "a|b" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("flushes at once at the size cap", func(t *testing.T) {
		b, writes := recordingBatcher()
		b.max = 4
		b.push([]byte("a"))
		b.push([]byte("bcd"))
		b.push([]byte("efgh"))
		if got := writes(); strings.Join(got, "|") != "a|bcdefgh" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("closing sends what is pending, or drops it, and ends the batcher", func(t *testing.T) {
		b, writes := recordingBatcher()
		b.push([]byte("a"))
		b.push([]byte("b"))
		b.close(true)
		b.push([]byte("c"))
		if got := writes(); strings.Join(got, "|") != "a|b" {
			t.Fatalf("got %q", got)
		}
		b, writes = recordingBatcher()
		b.push([]byte("a"))
		b.push([]byte("b"))
		b.close(false)
		time.Sleep(2 * b.window)
		if got := writes(); strings.Join(got, "|") != "a" {
			t.Fatalf("got %q", got)
		}
	})

	// The server decodes each frame by itself.
	t.Run("never ends a frame inside a character", func(t *testing.T) {
		b, writes := recordingBatcher()
		b.push([]byte("a\xe2\x9c"))
		b.push([]byte("\x93b"))
		if got := waitForWrites(t, writes, 2); strings.Join(got, "|") != "a|✓b" {
			t.Fatalf("got %q", got)
		}
		// A lone unfinished character goes out once its window has passed.
		b.push([]byte("\xf0"))
		if got := waitForWrites(t, writes, 3); got[2] != "\xf0" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestUnfinishedRune(t *testing.T) {
	for in, want := range map[string]int{
		"": 0, "abc": 0, "é": 0, "✓": 0, "🙂": 0,
		"a\xc3": 1, "a\xe2\x9c": 2, "a\xf0\x9f\x99": 3, "a\xf0": 1,
		// Invalid sequences are sent as they are.
		"\x80\x80\x80": 0, "a\xff": 0,
	} {
		if got := unfinishedRune([]byte(in)); got != want {
			t.Errorf("unfinishedRune(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestDialFailureClosesTheStream(t *testing.T) {
	port := startDaemon(t)
	// A port nothing listens on: the stream opens, then closes.
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	free := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	c := open(t, port, map[string]any{"token": testToken, "kind": "tcp", "port": free}).mustOK()
	if _, err := c.r.ReadByte(); !errors.Is(err, io.EOF) {
		t.Fatalf("got %v", err)
	}
}

func TestStreamCap(t *testing.T) {
	procDir := t.TempDir()
	write(t, filepath.Join(procDir, "tcp"), procFile())
	port := startDaemon(t, func(c *config) {
		c.procNetDir = procDir
		c.maxStreams = 2
	})
	ports := map[string]any{"token": testToken, "kind": "ports"}
	first := open(t, port, ports).mustOK()
	open(t, port, ports).mustOK()
	if r := open(t, port, ports).reply(); r.Error != "too many streams" {
		t.Fatalf("got %+v", r)
	}
	// A refused stream holds no slot, and a closed one frees its own.
	_ = first.conn.Close()
	waitFor(t, func() bool {
		c := open(t, port, ports)
		defer c.conn.Close()
		return c.reply().OK
	})
}

// Run as a child by TestInheritedSignalIgnores: prints the signals an exec
// child of this process ignores, with streamd's reset applied when asked.
func TestSignalHelper(t *testing.T) {
	mode := os.Getenv("STREAMD_SIGNAL_HELPER")
	if mode == "" {
		t.Skip("run by TestInheritedSignalIgnores")
	}
	if mode == "reset" {
		resetInheritedSignals()
	}
	out, err := exec.Command("cat", "/proc/self/status").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if mask, ok := strings.CutPrefix(line, "SigIgn:"); ok {
			fmt.Println("MASK", strings.TrimSpace(mask))
		}
	}
}

// The shell that starts streamd in the background ignores SIGINT for it,
// and Go would hand that on to every child.
func TestInheritedSignalIgnores(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	mask := func(mode string) uint64 {
		t.Helper()
		cmd := exec.Command("sh", "-c", `trap "" INT HUP; exec "$0" -test.run='^TestSignalHelper$' -test.v`, os.Args[0])
		cmd.Env = append(os.Environ(), "STREAMD_SIGNAL_HELPER="+mode)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		for _, line := range strings.Split(string(out), "\n") {
			if hex, ok := strings.CutPrefix(line, "MASK "); ok {
				m, err := strconv.ParseUint(hex, 16, 64)
				if err != nil {
					t.Fatal(err)
				}
				return m
			}
		}
		t.Fatalf("no mask in %s", out)
		return 0
	}
	const intHup = 1<<(syscall.SIGINT-1) | 1<<(syscall.SIGHUP-1)
	if mask("keep")&intHup != intHup {
		t.Fatal("the parent's ignores never reached the child, so this proves nothing")
	}
	if got := mask("reset"); got&intHup != 0 {
		t.Fatalf("a child still ignores SIGINT or SIGHUP: mask %x", got)
	}
}

func TestSignalNames(t *testing.T) {
	// One name per signal, whatever the map's order.
	for range 20 {
		if got := signalName(syscall.SIGABRT); got != "SIGABRT" {
			t.Fatalf("got %s", got)
		}
	}
	if sig, ok := signalByName("SIGTERM"); !ok || sig != syscall.SIGTERM {
		t.Fatal("SIGTERM")
	}
	if _, ok := signalByName("SIGNOPE"); ok {
		t.Fatal("an unknown name was taken")
	}
}
