package main

// The listener, the handshake, and the stream kinds that splice or run a
// command. The wire is the server's (packages/server/src/drivers/k8s/
// substrate/stream-relay.ts), which speaks it to pods of every build, so it
// changes only by adding to it.
//
// Every connection starts with one JSON handshake line,
//
//	{"token": "<stream token>", "kind": "<kind>", ...params}
//
// answered by one JSON line, {"ok":true} or {"ok":false,"error":"..."},
// after which the stream's payload flows:
//
//	tcp   {port}             raw splice to localhost:<port>, dialed in the pod
//	                         so a dev server bound to loopback is reachable
//	unix  {path}             raw splice to a UNIX socket in the pod (an ACP
//	                         conversation's acpd), retried while it is unbound
//	ctrl  {cmd}              argv with piped stdio and no TTY, spliced raw
//	exec  {cmd, stdin?}      run argv once, reply with one JSON line, close
//	pty   {cmd, cols, rows}  argv under a PTY, framed both ways (pty.go)
//	ports {}                 the pod's listening ports as JSON lines (ports.go)
//	claim {bytes}            make the pod one workspace's (claim.go)
//
// The token is per workspace, derived from the install's secret and handed
// to the pod as YAAC_STREAM_TOKEN. It is defense in depth: only netd's relay
// can reach streamd, and a leaked token opens only its own pod.

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	defaultPort = 10300
	// The handshake line's deadline; it precedes any payload byte.
	handshakeTimeout = 10 * time.Second
	// How a unix stream waits for its socket: acpd binds it a moment after
	// tmux opens its window, and the server's dial usually comes first. Two
	// seconds, generous for a loaded gVisor node.
	unixConnectTries    = 40
	unixConnectInterval = 50 * time.Millisecond
	// How long a ctrl stream waits, once its child exits, for output that a
	// grandchild holding the pipe keeps back.
	ctrlOutputGrace = time.Second
	// How long a finished stream waits for the client to close its side.
	lingerTimeout = 10 * time.Second
)

type config struct {
	token string
	// The handshake line's cap: twice the longest argument Linux runs
	// (128 KiB), since a command travels in it. Only a command made mostly
	// of characters JSON escapes would not fit, and it fails loudly.
	handshakeMaxBytes int
	// Concurrent streams, so a runaway client cannot exhaust the pod.
	maxStreams int32
	// Per-stream cap on each of an exec's stdout and stderr.
	execOutputMaxBytes int
	// Between SIGTERM and the follow-up SIGKILL when a stream ends a child.
	killGrace time.Duration
	// Where the ports kind reads tcp and tcp6 from.
	procNetDir string
	// How often a ports stream re-reads them, and how long it may go
	// without sending, so the server can tell a quiet pod from a dead stream.
	portsPoll, portsKeepalive time.Duration
	claim                     claimDeps
}

func defaultConfig(token string) config {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/home/yaac"
	}
	return config{
		token:              token,
		handshakeMaxBytes:  256 * 1024,
		maxStreams:         128,
		execOutputMaxBytes: 4 * 1024 * 1024,
		killGrace:          2 * time.Second,
		procNetDir:         "/proc/net",
		portsPoll:          2 * time.Second,
		portsKeepalive:     30 * time.Second,
		claim:              claimDeps{home: home, run: runCommand, setenv: os.Setenv, checkpointLoop: true},
	}
}

type daemon struct {
	cfg    config
	active atomic.Int32
	// The port it serves, which a ports stream leaves out.
	port atomic.Int32
}

func newDaemon(cfg config) *daemon {
	return &daemon{cfg: cfg}
}

// serve accepts streams until the listener closes.
func (d *daemon) serve(ln net.Listener) {
	d.port.Store(int32(ln.Addr().(*net.TCPAddr).Port))
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			// Out of descriptors, most likely; streams that end free some.
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go d.handle(c.(*net.TCPConn))
	}
}

// One connection. Reads go through `r`, the reader the handshake was read
// with, so bytes that arrived with the handshake reach the stream's kind.
type stream struct {
	conn *net.TCPConn
	r    *bufio.Reader
	wmu  sync.Mutex
}

func (s *stream) write(p []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.conn.Write(p)
	return err
}

// writeJSON sends one JSON line. HTML characters are left as they are,
// which Go would otherwise spell as six bytes each in an exec's output.
func (s *stream) writeJSON(v any) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	return s.write(b.Bytes())
}

// end half-closes the stream after its last byte and bounds how long the
// client may take to close its side. Whoever reads the stream then reads
// to its end: closing a socket with unread input sends a reset, which can
// cost the client what it has not read yet.
func (s *stream) end() {
	_ = s.conn.CloseWrite()
	_ = s.conn.SetReadDeadline(time.Now().Add(lingerTimeout))
}

func (s *stream) endAndDrain() {
	s.end()
	_, _ = io.Copy(io.Discard, s.r)
}

type reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func (s *stream) refuse(reason string) {
	_ = s.writeJSON(reply{Error: reason})
	s.endAndDrain()
}

type params map[string]any

// A stream kind checks its parameters and either refuses or returns what
// runs the stream once {ok} is sent. It writes nothing itself, so the reply
// comes first.
type kind func(d *daemon, s *stream, p params) (run func(), refusal string)

var kinds = map[string]kind{
	"tcp":   tcpKind,
	"unix":  unixKind,
	"ctrl":  ctrlKind,
	"exec":  execKind,
	"pty":   ptyKind,
	"ports": portsKind,
	"claim": claimKind,
}

func (d *daemon) handle(c *net.TCPConn) {
	defer c.Close()
	s := &stream{conn: c, r: bufio.NewReader(c)}
	_ = c.SetReadDeadline(time.Now().Add(handshakeTimeout))
	line, err := readLine(s.r, d.cfg.handshakeMaxBytes)
	if err != nil {
		// Too long, too slow, or gone.
		return
	}
	_ = c.SetReadDeadline(time.Time{})

	var p params
	if json.Unmarshal(line, &p) != nil || p == nil {
		s.refuse("malformed handshake")
		return
	}
	token, ok := p["token"].(string)
	if !ok {
		s.refuse("malformed handshake")
		return
	}
	if !tokenEqual(token, d.cfg.token) {
		s.refuse("bad token")
		return
	}
	// The slot is taken before the kind starts anything, so a burst of
	// handshakes cannot all pass the cap.
	if d.active.Add(1) > d.cfg.maxStreams {
		d.active.Add(-1)
		s.refuse("too many streams")
		return
	}
	name, _ := p["kind"].(string)
	k, ok := kinds[name]
	if !ok {
		d.active.Add(-1)
		s.refuse("unknown kind " + jsonText(p, "kind"))
		return
	}
	run, refusal := k(d, s, p)
	if refusal != "" {
		d.active.Add(-1)
		s.refuse(refusal)
		return
	}
	defer d.active.Add(-1)
	// Run even if the reply did not go out: a kind may have started a
	// child, which notices the dead stream and ends.
	_ = s.writeJSON(reply{OK: true})
	run()
}

// readLine reads up to and including a newline, failing once the line
// without it would pass `max`. It grows as bytes arrive rather than
// holding the cap for every connection.
func readLine(r *bufio.Reader, max int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if err == nil && len(line)-1 <= max {
			return line, nil
		}
		if len(line) > max {
			return nil, errors.New("handshake line too long")
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// tokenEqual compares in constant time, over digests so the lengths match.
func tokenEqual(a, b string) bool {
	ha, hb := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

// jsonText is a parameter as the handshake spelled it, for an error.
func jsonText(p params, key string) string {
	v, present := p[key]
	if !present {
		return "undefined"
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// integer reads a whole JSON number that a double holds exactly, as
// JavaScript's Number.isSafeInteger does.
func integer(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || math.Abs(f) > 1<<53-1 {
		return 0, false
	}
	return int64(f), true
}

// argv reads a non-empty array of strings.
func argv(v any) ([]string, bool) {
	list, ok := v.([]any)
	if !ok || len(list) == 0 {
		return nil, false
	}
	out := make([]string, len(list))
	for i, x := range list {
		if out[i], ok = x.(string); !ok {
			return nil, false
		}
	}
	return out, true
}

func tcpKind(_ *daemon, s *stream, p params) (func(), string) {
	port, ok := integer(p["port"])
	if !ok || port < 1 || port > 65535 {
		return nil, "tcp: invalid port"
	}
	return func() {
		// localhost reaches a server bound to 127.0.0.1 or to ::1.
		target, err := net.Dial("tcp", net.JoinHostPort("localhost", strconv.FormatInt(port, 10)))
		if err != nil {
			return
		}
		splice(s, target)
	}, ""
}

// The connect happens in streamd's own process, so an ACP attach starts no
// process in the sandbox. The client is not read until it connects, so what
// it sends first waits in the socket.
func unixKind(_ *daemon, s *stream, p params) (func(), string) {
	path, ok := p["path"].(string)
	if !ok || path == "" {
		return nil, "unix: path must be a string"
	}
	return func() {
		for tries := unixConnectTries; ; tries-- {
			target, err := net.Dial("unix", path)
			if err == nil {
				splice(s, target)
				return
			}
			if tries <= 1 {
				return
			}
			time.Sleep(unixConnectInterval)
		}
	}, ""
}

// splice copies both ways. Each direction's end half-closes its
// destination, so a client's EOF reaches the target while the target's
// answer still flows back; a failure in either closes both.
func splice(s *stream, target net.Conn) {
	defer target.Close()
	done := make(chan error, 2)
	go func() {
		_, err := io.Copy(target, s.r)
		if hc, ok := target.(interface{ CloseWrite() error }); ok {
			_ = hc.CloseWrite()
		}
		done <- err
	}()
	go func() {
		_, err := io.Copy(s.conn, target)
		_ = s.conn.CloseWrite()
		done <- err
	}()
	for range 2 {
		if err := <-done; err != nil {
			_ = s.conn.Close()
			_ = target.Close()
		}
	}
}

// tmux control mode is a line protocol, so ctrl splices the child's stdin
// and stdout raw. The client's EOF closes the child's stdin; the stream
// failing ends the child.
func ctrlKind(d *daemon, s *stream, p params) (func(), string) {
	cmdArgv, ok := argv(p["cmd"])
	if !ok {
		return nil, "ctrl: cmd must be a non-empty argv array"
	}
	return func() { runCtrl(s, cmdArgv, d.cfg.killGrace) }, ""
}

func runCtrl(s *stream, cmdArgv []string, killGrace time.Duration) {
	cmd := exec.Command(cmdArgv[0], cmdArgv[1:]...)
	exited := make(chan struct{})
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = s.conn.Close()
			go stopChild(cmd.Process, exited, killGrace)
		})
	}
	cmd.Stdout = failWriter{s, stop}
	cmd.WaitDelay = ctrlOutputGrace
	stdin, err := cmd.StdinPipe()
	if err != nil || cmd.Start() != nil {
		return
	}
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		_, err := io.Copy(stdin, s.r)
		_ = stdin.Close()
		if err != nil {
			stop()
		}
	}()
	_ = cmd.Wait()
	close(exited)
	s.end()
	<-inputDone
}

// failWriter writes to the stream and ends the child when that fails.
type failWriter struct {
	s    *stream
	fail func()
}

func (w failWriter) Write(p []byte) (int, error) {
	if err := w.s.write(p); err != nil {
		w.fail()
		return 0, err
	}
	return len(p), nil
}

// stopChild ends a child gently, then hard if it is still running after
// the grace.
func stopChild(p *os.Process, exited <-chan struct{}, grace time.Duration) {
	_ = p.Signal(syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(grace):
		_ = p.Signal(syscall.SIGKILL)
	}
}

// stopGroup ends a process group the same way, signalling it even once its
// leader has exited, so nothing the command started outlives it.
func stopGroup(pid int, grace time.Duration) {
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	time.AfterFunc(grace, func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
}

type execResult struct {
	ExitCode int `json:"exitCode"`
	// The command never started (out of memory or descriptors), so its
	// 127 is not a shell's command-not-found.
	SpawnFailed bool   `json:"spawnFailed,omitempty"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	// The signal that killed it, so a killed probe is not read as a real
	// failure.
	Signal    string `json:"signal,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// exec runs a command once and replies with its result. With `stdin: n`, the
// next n bytes the client sends are the command's input; a long prompt's
// delivery script travels this way, past the handshake line's cap. A client
// never half-closes an exec stream, so the count is what says the input is
// whole, and an EOF before the reply means the client gave up: the command
// leads its own session, and its whole process group is ended, so a
// timed-out script's children do not keep running and holding its locks.
func execKind(d *daemon, s *stream, p params) (func(), string) {
	cmdArgv, ok := argv(p["cmd"])
	if !ok {
		return nil, "exec: cmd must be a non-empty argv array"
	}
	stdinBytes := int64(-1)
	if v := p["stdin"]; v != nil {
		if stdinBytes, ok = integer(v); !ok || stdinBytes < 0 {
			return nil, "exec: stdin must be a byte count"
		}
	}
	return func() { runExec(s, cmdArgv, stdinBytes, d.cfg) }, ""
}

func runExec(s *stream, cmdArgv []string, stdinBytes int64, cfg config) {
	cmd := exec.Command(cmdArgv[0], cmdArgv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	var stdin io.WriteCloser
	if stdinBytes >= 0 {
		stdin, _ = cmd.StdinPipe()
	}
	stdout, stderr := capped{max: cfg.execOutputMaxBytes}, capped{max: cfg.execOutputMaxBytes}
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		_ = s.writeJSON(execResult{ExitCode: 127, SpawnFailed: true, Stderr: err.Error()})
		s.endAndDrain()
		return
	}
	clientGone := make(chan struct{})
	go func() {
		defer close(clientGone)
		if stdin != nil {
			// Taken whole before the command gets it, so a command that never
			// reads its input cannot stop this reader from seeing the client
			// leave. Input cut short is never handed on: the command would
			// read its prefix and an EOF, and a script would run its first
			// half. It waits on an open stdin instead until its group is
			// ended. Wait closes the pipe when the command exits, which also
			// ends a write it never read.
			var input bytes.Buffer
			if _, err := io.CopyN(&input, s.r, stdinBytes); err != nil {
				return
			}
			go func() {
				_, _ = stdin.Write(input.Bytes())
				_ = stdin.Close()
			}()
		}
		// Anything more is not the command's.
		_, _ = io.Copy(io.Discard, s.r)
	}()
	waited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(waited)
	}()
	select {
	case <-waited:
	case <-clientGone:
		stopGroup(cmd.Process.Pid, cfg.killGrace)
		<-waited
		return
	}
	res := execResult{
		Stdout:    string(stdout.buf),
		Stderr:    string(stderr.buf),
		Truncated: stdout.truncated || stderr.truncated,
	}
	if ws := cmd.ProcessState.Sys().(syscall.WaitStatus); ws.Signaled() {
		res.ExitCode, res.Signal = 1, signalName(ws.Signal())
	} else {
		res.ExitCode = ws.ExitStatus()
	}
	_ = s.writeJSON(res)
	s.end()
	<-clientGone
}

// capped keeps the first `max` bytes written to it and drops the rest,
// still taking it so the command never blocks on a full pipe.
type capped struct {
	max       int
	buf       []byte
	truncated bool
}

func (c *capped) Write(p []byte) (int, error) {
	keep := p
	if room := c.max - len(c.buf); len(p) > room {
		c.truncated = true
		keep = p[:max(room, 0)]
	}
	c.buf = append(c.buf, keep...)
	return len(p), nil
}

// The signals a pty stream may send, by the names the server uses, and
// the names an exec's reply gives: one name per signal.
var signals = map[string]syscall.Signal{
	"SIGHUP": syscall.SIGHUP, "SIGINT": syscall.SIGINT, "SIGQUIT": syscall.SIGQUIT,
	"SIGILL": syscall.SIGILL, "SIGTRAP": syscall.SIGTRAP, "SIGABRT": syscall.SIGABRT,
	"SIGBUS": syscall.SIGBUS, "SIGFPE": syscall.SIGFPE, "SIGKILL": syscall.SIGKILL,
	"SIGUSR1": syscall.SIGUSR1, "SIGSEGV": syscall.SIGSEGV, "SIGUSR2": syscall.SIGUSR2,
	"SIGPIPE": syscall.SIGPIPE, "SIGALRM": syscall.SIGALRM, "SIGTERM": syscall.SIGTERM,
	"SIGCHLD": syscall.SIGCHLD, "SIGCONT": syscall.SIGCONT, "SIGSTOP": syscall.SIGSTOP,
	"SIGTSTP": syscall.SIGTSTP, "SIGTTIN": syscall.SIGTTIN, "SIGTTOU": syscall.SIGTTOU,
	"SIGURG": syscall.SIGURG, "SIGXCPU": syscall.SIGXCPU, "SIGXFSZ": syscall.SIGXFSZ,
	"SIGVTALRM": syscall.SIGVTALRM, "SIGPROF": syscall.SIGPROF, "SIGWINCH": syscall.SIGWINCH,
	"SIGIO": syscall.SIGIO, "SIGSYS": syscall.SIGSYS,
}

// More names for signals above, which a pty stream may send but an exec's
// reply never gives.
var signalAliases = map[string]syscall.Signal{}

func signalByName(name string) (syscall.Signal, bool) {
	if sig, ok := signals[name]; ok {
		return sig, true
	}
	sig, ok := signalAliases[name]
	return sig, ok
}

func signalName(sig syscall.Signal) string {
	for name, s := range signals {
		if s == sig {
			return name
		}
	}
	return fmt.Sprintf("SIG%d", int(sig))
}
