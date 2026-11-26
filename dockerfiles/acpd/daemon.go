// The supervisor for one ACP agent process.
//
// yaac runs agents under tmux so a closed tab, dropped relay, or restarted
// server does not kill a turn in progress. An ACP agent speaks JSON-RPC over
// stdio, which a PTY would corrupt, and a streamd `ctrl` stream kills its
// child when the socket closes. So acpd runs inside a tmux window, owns the
// agent's stdio, and exposes it on a UNIX socket the server can attach to and
// detach from freely:
//
//	tmux window                          server
//	┌───────────────────────────┐        ┌──────────────────────┐
//	│ acpd ── stdio ── agent    │        │ ACP client           │
//	│   └── /tmp/yaac-acp/*.sock│◄───────┤ ctrl stream +        │
//	└───────────────────────────┘        │   `acpd dial`        │
//	                                     └──────────────────────┘
//
// acpd does not interpret JSON-RPC; all protocol logic lives in the server.
//
// # The record
//
// Every line relayed in either direction is appended to `--log`, one whole
// line at a time. The file is the conversation's history, written whether
// or not a client is attached, on a host-mounted path the server can read
// even after the pod is gone. The server reads it for live output too, so
// nothing is buffered for an absent client. Client lines are recorded
// because the agent echoes user messages only when replaying `session/load`.
//
// The record is synced (`fdatasync`) after each client line, after acpd's
// own lines, and once the agent's output pauses or has run on for a while.
// On NFS a file's data reaches the server only when it is closed, synced or
// the kernel writes it back (up to 30 s later), and the server reads the
// record from another node, so an unsynced record would show a sent message
// only once the agent's next output pushed it out. It is synced, not closed
// and reopened, because the server renames a fresh conversation's record
// from its own node, which neither the old path nor, under gVisor,
// `/dev/fd/<fd>` follows.
//
// Images are kept out of it (see images.go), and every other byte is
// recorded verbatim.
//
// The record also says when each line was written, for the pane's
// timestamps: its second line is `_acpd/time {at}` (epoch ms), and a line is
// preceded by another once a second has passed since the last. That dates
// every line to within a second for at most one extra line a second.
//
// A conversation that cannot be recorded cannot be rendered, even though
// RPC still works. So a record failure restarts the agent under a fresh
// record, and the reattaching client's `session/load` replays the
// conversation into it. The file is truncated on each start and its first
// line holds a new life id, so a replay never duplicates history.
//
// # Attach semantics
//
// At most one client at a time; a new connection displaces the old, so a
// stale half-open socket cannot lock the agent out. A client's half-close
// leaves the agent's stdin open. Two control notifications use the `_acpd/`
// prefix, which no ACP method uses:
//
//   - `_acpd/hello {firstAttach}`: the first line of every attach.
//     `firstAttach` is false when some earlier client already spoke to this
//     agent, which tells the server the ACP handshake (`initialize`,
//     `session/new`) has already happened and must not be repeated on a live
//     process.
//   - `_acpd/exit {code, signal}`: the agent process is gone, so an attached
//     server can tell that from a dropped connection without probing. Also
//     recorded, since a notice sent while detached simply goes nowhere.
//
// With `--wait-for`, the agent starts at once but a client is held, with no
// hello, until every given path exists. A launch can then start the agent
// while its checkouts are still being written, and the conversation still
// opens on the finished checkouts, since a client's handshake begins at the
// hello.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// Grace between SIGTERM and SIGKILL when acpd shuts the agent down.
	childKillGrace = 5 * time.Second
	// How long the agent's output must pause before the record is settled,
	// and the longest a busy record goes unsettled.
	settleQuiet = 50 * time.Millisecond
	settleMax   = 200 * time.Millisecond
	// The least time between two time marks.
	timeMark = time.Second
	// How often a held client checks for `--wait-for`.
	waitForPoll = 25 * time.Millisecond
	// Record-failure restarts allowed before acpd exits. A full disk does
	// not heal, so exiting beats respawning forever.
	recordRestartLimit = 3
	// How long the exit notice gets to reach an attached client before acpd
	// tears down.
	exitLinger = 50 * time.Millisecond
	// How long the agent's stdout may stay open after it exits, held by a
	// process it left behind, before acpd stops reading it.
	stdoutWaitDelay = 2 * time.Second
)

type config struct {
	sock    string
	argv    []string
	logPath string
	// The agent's working directory (the workspace checkout, which differs
	// per driver). Empty means acpd's own, which is the window tmux opened.
	cwd     string
	waitFor []string
	// Where acpd's own diagnostics and the agent's stderr go: the tmux pane,
	// where a human attaching would look.
	logOut    io.Writer
	killGrace time.Duration
	// The clock the record's time marks read, and how the record is synced.
	// Tests replace both.
	now  func() time.Time
	sync func(*os.File) error
}

// One agent process. Its stdout is read by exec's copier, which calls
// `agentOutput`, and its exit by `waitChild`.
type agent struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	exited    bool
	killTimer *time.Timer
}

// One attached connection. `done` closes once its reader has stopped,
// having ended any line the client left unfinished on `agent`'s stdin.
type client struct {
	conn  net.Conn
	agent *agent
	done  chan struct{}
}

type daemon struct {
	cfg config
	// Guards everything below. Never held across a write to a client or the
	// agent's stdin, which can block on the other end.
	mu sync.Mutex
	// Serializes attaches, so one displacement finishes before the next.
	attachMu sync.Mutex

	// True once a client has sent something, i.e. the ACP handshake started.
	// A client that connected and died before writing ran no handshake, so
	// its successor must still be told `firstAttach:true`.
	everSpoke   bool
	child       *agent
	client      *client
	listener    net.Listener
	closing     bool
	recordReady bool
	waited      bool
	// Set while acpd tears the agent down on purpose, so its exit is not
	// read as the agent dying.
	restarting     bool
	recordRestarts int
	rec            *os.File
	// The pending settle, and when the oldest unsettled bytes were written.
	settleTimer    *time.Timer
	unsettledSince time.Time
	// When the record last noted the time.
	markedAt time.Time
	exitCode chan int
}

// Start the agent under a fresh record; `listen` then serves it. A record
// that cannot be opened at all is fatal (see `listen`).
func newDaemon(cfg config) *daemon {
	if cfg.logOut == nil {
		cfg.logOut = io.Discard
	}
	if cfg.killGrace == 0 {
		cfg.killGrace = childKillGrace
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	if cfg.sync == nil {
		cfg.sync = fdatasync
	}
	d := &daemon{cfg: cfg, exitCode: make(chan int, 1)}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.recordReady = d.openRecord()
	if d.recordReady {
		d.startChild()
	}
	return d
}

func (d *daemon) log(msg string) {
	fmt.Fprintf(d.cfg.logOut, "[acpd] %s\n", msg)
}

type lifeParams struct {
	ID        string `json:"id"`
	StartedAt string `json:"startedAt"`
}

type timeParams struct {
	At int64 `json:"at"`
}

type helloParams struct {
	FirstAttach bool `json:"firstAttach"`
}

type exitParams struct {
	Code   int     `json:"code"`
	Signal *string `json:"signal"`
}

func controlLine(method string, params any) []byte {
	line, _ := json.Marshal(struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{"2.0", method, params})
	return append(line, '\n')
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Open (or reopen) the record with a fresh life id, which tells the server's
// tailer to discard what it read from the previous file.
func (d *daemon) openRecord() bool {
	if d.cfg.logPath == "" {
		return true
	}
	fail := func(err error) bool {
		d.log(fmt.Sprintf("log unavailable (%v)", err))
		if d.rec != nil {
			d.rec.Close()
			d.rec = nil
		}
		return false
	}
	if err := os.MkdirAll(filepath.Dir(d.cfg.logPath), 0o777); err != nil {
		return fail(err)
	}
	f, err := os.OpenFile(d.cfg.logPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return fail(err)
	}
	d.rec = f
	at := d.cfg.now()
	d.markedAt = at
	head := controlLine("_acpd/life", lifeParams{newUUID(), at.UTC().Format("2006-01-02T15:04:05.000Z")})
	head = append(head, controlLine("_acpd/time", timeParams{at.UnixMilli()})...)
	if _, err := f.Write(head); err != nil {
		return fail(err)
	}
	if err := d.cfg.sync(f); err != nil {
		return fail(err)
	}
	return true
}

// Restart the agent under a fresh record after a record write failed. The
// client is dropped so it reattaches, sees `firstAttach:true`, and re-runs
// the handshake against the new process; `waitChild` finishes the restart.
func (d *daemon) restartForRecord(reason string) {
	if d.closing || d.restarting {
		return
	}
	if d.recordRestarts >= recordRestartLimit {
		d.log(fmt.Sprintf("record failed again (%s) after %d restarts; giving up", reason, d.recordRestarts))
		d.shutdown(1)
		return
	}
	d.recordRestarts++
	d.restarting = true
	d.log(fmt.Sprintf("record failed (%s); restarting the agent under a fresh record (%d/%d)",
		reason, d.recordRestarts, recordRestartLimit))
	d.everSpoke = false
	if d.client != nil {
		d.client.conn.Close()
		d.client = nil
	}
	d.terminate(d.child)
}

// SIGTERM the agent, then SIGKILL it if it outlives the grace period.
func (d *daemon) terminate(a *agent) {
	_ = a.cmd.Process.Signal(syscall.SIGTERM)
	a.killTimer = time.AfterFunc(d.cfg.killGrace, func() { _ = a.cmd.Process.Kill() })
}

// Drop the record after a failure and restart the agent under a fresh one.
func (d *daemon) recordFailed(err error) {
	d.stopSettle()
	if d.rec != nil {
		d.rec.Close()
		d.rec = nil
	}
	d.restartForRecord(err.Error())
}

func (d *daemon) stopSettle() {
	if d.settleTimer != nil {
		d.settleTimer.Stop()
		d.settleTimer = nil
	}
}

// Sync the record so what was written reaches the reader.
func (d *daemon) settle() {
	d.stopSettle()
	if d.rec == nil {
		return
	}
	if err := d.cfg.sync(d.rec); err != nil {
		d.recordFailed(err)
	}
}

// Settle once the output pauses, or by settleMax after the oldest unsettled
// write if it never does.
func (d *daemon) settleSoon() {
	now := time.Now()
	if d.settleTimer == nil {
		d.unsettledSince = now
	} else {
		d.settleTimer.Stop()
	}
	delay := max(0, min(settleQuiet, d.unsettledSince.Add(settleMax).Sub(now)))
	d.settleTimer = time.AfterFunc(delay, func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.settle()
	})
}

// Append relayed bytes to the record; a failure restarts the agent. `now`
// settles at once, for lines a reader is waiting on; the agent's output
// settles once it pauses.
func (d *daemon) record(buf []byte, now bool) {
	if d.rec == nil {
		return
	}
	if at := d.cfg.now(); at.Sub(d.markedAt) >= timeMark {
		if _, err := d.rec.Write(controlLine("_acpd/time", timeParams{at.UnixMilli()})); err != nil {
			d.recordFailed(err)
			return
		}
		d.markedAt = at
	}
	if _, err := d.rec.Write(withoutImages(buf, filepath.Dir(d.cfg.logPath), d.log)); err != nil {
		d.recordFailed(err)
		return
	}
	if now {
		d.settle()
	} else {
		d.settleSoon()
	}
}

// Records one direction's bytes a whole line at a time, so a long line
// arriving in chunks (e.g. a prompt with a base64 image) is never
// interleaved with the other direction. `now` is passed on to `record`.
type lineRecorder struct {
	pending []byte
	now     bool
}

func (r *lineRecorder) feed(d *daemon, chunk []byte) {
	end := bytes.LastIndexByte(chunk, '\n') + 1
	if end == 0 {
		r.pending = append(r.pending, chunk...)
		return
	}
	d.record(append(r.pending, chunk[:end]...), r.now)
	r.pending = append([]byte(nil), chunk[end:]...)
}

// Drop an unfinished tail; returns whether there was one.
func (r *lineRecorder) abandon() bool {
	had := len(r.pending) > 0
	r.pending = nil
	return had
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// Spawn the agent and wire its stdio. Runs again on each restart.
func (d *daemon) startChild() {
	cmd := exec.Command(d.cfg.argv[0], d.cfg.argv[1:]...)
	cmd.Dir = d.cfg.cwd
	cmd.Stderr = d.cfg.logOut
	cmd.WaitDelay = stdoutWaitDelay
	stdin, err := cmd.StdinPipe()
	if err != nil {
		d.log(fmt.Sprintf("agent spawn failed: %v", err))
		d.shutdown(127)
		return
	}
	a := &agent{cmd: cmd, stdin: stdin}
	out := &lineRecorder{}
	cmd.Stdout = writerFunc(func(p []byte) (int, error) {
		d.agentOutput(a, out, p)
		return len(p), nil
	})
	if err := cmd.Start(); err != nil {
		d.log(fmt.Sprintf("agent spawn failed: %v", err))
		d.shutdown(127)
		return
	}
	d.child = a
	go d.waitChild(a)
}

// Record the agent's output and forward it to the attached client, if any;
// nothing is buffered otherwise. A slow client blocks this write, and so the
// agent's stdout.
func (d *daemon) agentOutput(a *agent, out *lineRecorder, p []byte) {
	d.mu.Lock()
	if a != d.child {
		d.mu.Unlock()
		return
	}
	out.feed(d, p)
	c := d.client
	d.mu.Unlock()
	d.send(c, p)
}

func (d *daemon) send(c *client, p []byte) {
	if c == nil {
		return
	}
	if _, err := c.conn.Write(p); err != nil {
		d.detach(c, "error")
		c.conn.Close()
	}
}

// A signal's conventional name (`SIGTERM`), which the exit notice carries.
var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT",
	syscall.SIGILL: "SIGILL", syscall.SIGTRAP: "SIGTRAP", syscall.SIGABRT: "SIGABRT",
	syscall.SIGBUS: "SIGBUS", syscall.SIGFPE: "SIGFPE", syscall.SIGKILL: "SIGKILL",
	syscall.SIGUSR1: "SIGUSR1", syscall.SIGSEGV: "SIGSEGV", syscall.SIGUSR2: "SIGUSR2",
	syscall.SIGPIPE: "SIGPIPE", syscall.SIGALRM: "SIGALRM", syscall.SIGTERM: "SIGTERM",
}

func signalName(s syscall.Signal) string {
	if name, ok := signalNames[s]; ok {
		return name
	}
	return fmt.Sprintf("SIG%d", int(s))
}

func (d *daemon) waitChild(a *agent) {
	_ = a.cmd.Wait()
	ws, _ := a.cmd.ProcessState.Sys().(syscall.WaitStatus)
	params := exitParams{Code: ws.ExitStatus()}
	if ws.Signaled() {
		name := signalName(ws.Signal())
		params = exitParams{Code: 0, Signal: &name}
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	a.exited = true
	if a.killTimer != nil {
		a.killTimer.Stop()
	}
	if a != d.child || d.closing {
		return
	}
	if d.restarting {
		d.restarting = false
		if !d.openRecord() {
			d.log("the record could not be reopened; exiting rather than running blind")
			d.shutdown(1)
			return
		}
		d.startChild()
		return
	}
	signal := "null"
	if params.Signal != nil {
		signal = *params.Signal
	}
	d.log(fmt.Sprintf("agent exited (code=%d signal=%s)", params.Code, signal))
	exit := controlLine("_acpd/exit", params)
	// Recorded too, since a notice sent while detached is otherwise lost.
	d.record(exit, true)
	c := d.client
	go d.send(c, exit)
	code := params.Code
	if params.Signal != nil {
		code = 1
	}
	time.AfterFunc(exitLinger, func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.shutdown(code)
	})
}

// Bind the socket and serve clients until `close` or the agent's exit.
func (d *daemon) listen() error {
	d.mu.Lock()
	ready := d.recordReady
	if !ready {
		d.log("no record; refusing to serve a conversation that cannot be rendered")
		d.shutdown(1)
	}
	d.mu.Unlock()
	if !ready {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(d.cfg.sock), 0o700); err != nil {
		return err
	}
	// A stale socket file would make bind() fail with EADDRINUSE.
	_ = os.Remove(d.cfg.sock)
	ln, err := net.Listen("unix", d.cfg.sock)
	if err != nil {
		return err
	}
	// Same-uid access only.
	_ = os.Chmod(d.cfg.sock, 0o600)
	d.mu.Lock()
	if d.closing {
		d.mu.Unlock()
		ln.Close()
		return nil
	}
	d.listener = ln
	d.mu.Unlock()
	d.log(fmt.Sprintf("listening on %s (agent: %s)", d.cfg.sock, strings.Join(d.cfg.argv, " ")))
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go d.serve(conn)
		}
	}()
	return nil
}

// Hold until every `--wait-for` path exists, or acpd is closing.
func (d *daemon) whenReady() {
	for {
		d.mu.Lock()
		done := d.waited || d.closing
		d.mu.Unlock()
		if done {
			return
		}
		missing := false
		for _, p := range d.cfg.waitFor {
			if _, err := os.Stat(p); err != nil {
				missing = true
				break
			}
		}
		if !missing {
			d.mu.Lock()
			d.waited = true
			d.mu.Unlock()
			return
		}
		time.Sleep(waitForPoll)
	}
}

// During a restart, refuse: an accepted `initialize` would reach the dying
// agent and set `everSpoke` for a handshake the new agent never saw. The
// server retries with backoff.
func (d *daemon) refuses() bool {
	if d.closing {
		return true
	}
	if d.restarting || d.child == nil {
		d.log("refusing an attach: no agent to serve it")
		return true
	}
	return false
}

func (d *daemon) serve(conn net.Conn) {
	d.whenReady()
	d.attachMu.Lock()
	defer d.attachMu.Unlock()

	d.mu.Lock()
	if d.refuses() {
		d.mu.Unlock()
		conn.Close()
		return
	}
	prev := d.client
	if prev != nil {
		d.log("displacing previous client")
		d.client = nil
	}
	d.mu.Unlock()
	if prev != nil {
		// Its reader ends any line it left unfinished before this client
		// can write a line of its own.
		prev.conn.Close()
		<-prev.done
	}

	d.mu.Lock()
	if d.refuses() {
		d.mu.Unlock()
		conn.Close()
		return
	}
	c := &client{conn: conn, agent: d.child, done: make(chan struct{})}
	// A few bytes into a fresh socket's empty buffer, so this cannot block.
	if _, err := conn.Write(controlLine("_acpd/hello", helloParams{!d.everSpoke})); err != nil {
		d.mu.Unlock()
		conn.Close()
		return
	}
	d.client = c
	d.mu.Unlock()
	go d.readClient(c)
}

// Relay a client's bytes to its agent until the connection ends. A half
// close ends only this reader; the client stays attached for output until
// it is displaced or a write to it fails. Bytes read after the client was
// displaced or dropped for a restart go nowhere, so a fresh agent is never
// marked as having had its handshake.
func (d *daemon) readClient(c *client) {
	defer close(c.done)
	in := &lineRecorder{now: true}
	buf := make([]byte, 64*1024)
	for {
		n, err := c.conn.Read(buf)
		if n > 0 {
			d.mu.Lock()
			current := d.client == c
			if current {
				d.everSpoke = true
				in.feed(d, buf[:n])
			}
			d.mu.Unlock()
			if current {
				if _, werr := c.agent.stdin.Write(buf[:n]); werr != nil {
					d.log(fmt.Sprintf("agent stdin: %v", werr))
				}
			}
		}
		if err != nil {
			// A client that leaves mid-line has sent the agent a fragment.
			// Ending it with a newline stops the next client's first line
			// being glued onto it.
			if in.abandon() {
				_, _ = c.agent.stdin.Write([]byte{'\n'})
			}
			if !errors.Is(err, io.EOF) {
				d.detach(c, "error")
			}
			return
		}
	}
}

func (d *daemon) detach(c *client, reason string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client != c {
		return
	}
	d.client = nil
	d.log(fmt.Sprintf("client detached (%s)", reason))
}

// Stop serving and report `code` to `wait`. The agent gets SIGTERM if it is
// still running; acpd exits without waiting for it.
func (d *daemon) shutdown(code int) {
	if d.closing {
		return
	}
	d.closing = true
	if d.client != nil {
		d.client.conn.Close()
		d.client = nil
	}
	if d.listener != nil {
		d.listener.Close()
	}
	_ = os.Remove(d.cfg.sock)
	d.stopSettle()
	if d.rec != nil {
		d.rec.Close()
		d.rec = nil
	}
	if d.child != nil && !d.child.exited {
		d.terminate(d.child)
	}
	d.exitCode <- code
}

// The exit code acpd should end with: the agent's own, 1 if a signal ended
// it or the record failed, 127 if it could not be spawned.
func (d *daemon) wait() int {
	return <-d.exitCode
}

func (d *daemon) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.shutdown(0)
}
