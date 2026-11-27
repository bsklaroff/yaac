package main

// The pty kind: a command under a PTY, framed both ways.

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
)

// Frames are [1B type][4B big-endian length][payload], the codec of
// packages/shared/src/stream-frames.ts.
//
//	client to pod: 0 data, 1 resize {cols,rows}, 2 signal {name}
//	pod to client: 0 data, 3 exit {code}
const (
	frameData   = 0
	frameResize = 1
	frameSignal = 2
	frameExit   = 3

	frameHeaderBytes = 5
	// A larger frame is a protocol error, which ends the stream.
	maxFrameBytes = 1024 * 1024
)

const (
	// One flush window: well under a 60Hz frame, but long enough to span
	// one tmux redraw.
	batchWindow = 8 * time.Millisecond
	// Flush at once past this. A flush exceeds it by at most one read, far
	// under the frame cap.
	maxBatchBytes = 64 * 1024
	// How long, once the child exits, its output may take to drain before
	// the exit frame. A background job that holds the terminal open keeps
	// it from ever draining.
	ptyDrainGrace = 200 * time.Millisecond
)

func ptyKind(_ *daemon, s *stream, p params) (func(), string) {
	cmdArgv, ok := argv(p["cmd"])
	if !ok {
		return nil, "pty: cmd must be a non-empty argv array"
	}
	cmd, ptmx, err := startPty(cmdArgv, dimension(p["cols"], 80), dimension(p["rows"], 24))
	if err != nil {
		return nil, "pty: spawn failed: " + err.Error()
	}
	return func() { runPty(s, cmd, ptmx) }, ""
}

// dimension reads a terminal size, or falls back to `def`.
func dimension(v any, def int) int {
	n, ok := integer(v)
	if !ok || n < 1 || n > 1000 {
		return def
	}
	return int(n)
}

// startPty runs argv on a new terminal, as its session leader, in $HOME.
func startPty(cmdArgv []string, cols, rows int) (*exec.Cmd, *os.File, error) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		return nil, nil, err
	}
	defer tty.Close()
	if err := pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	if err := setTerminalFlags(tty); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	cmd := exec.Command(cmdArgv[0], cmdArgv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	cmd.Dir = os.Getenv("HOME")
	if cmd.Dir == "" {
		cmd.Dir = "/"
	}
	cmd.Env = ptyEnv(os.Environ(), cmd.Dir)
	if err := cmd.Start(); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	return cmd, ptmx, nil
}

// ptyEnv is streamd's environment for a terminal started in `dir`: without
// what says it is itself inside a multiplexer or a terminal of a fixed
// size, with the image's TERM, since a lesser one drops cursor hiding and
// 256 colors, and with PWD naming the terminal's own directory.
func ptyEnv(env []string, dir string) []string {
	out := make([]string, 0, len(env)+2)
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		switch name {
		case "TMUX", "TMUX_PANE", "STY", "WINDOW", "WINDOWID", "TERMCAP", "COLUMNS", "LINES", "TERM", "PWD":
			continue
		}
		out = append(out, kv)
	}
	return append(out, "TERM=xterm-256color", "PWD="+dir)
}

func runPty(s *stream, cmd *exec.Cmd, ptmx *os.File) {
	defer ptmx.Close()
	out := newBatcher(func(b []byte) { _ = s.write(encodeFrame(frameData, b)) })
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			out.push(buf[:n])
			if err != nil {
				return
			}
		}
	}()
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		readPtyInput(s, cmd.Process, ptmx)
	}()
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()

	select {
	case <-inputDone:
		// The client detached: its EOF, a dropped stream or a bad frame.
		// Closing the stream first ends a flush blocked on it, which holds
		// the batcher. Then hang the child up, as closing its terminal
		// would; the waiter above reaps it.
		_ = s.conn.Close()
		_ = cmd.Process.Signal(syscall.SIGHUP)
		out.close(false)
		return
	case <-exited:
	}
	select {
	case <-outputDone:
	case <-time.After(ptyDrainGrace):
	}
	// The last output goes to a client that may have stopped reading.
	_ = s.conn.SetWriteDeadline(time.Now().Add(lingerTimeout))
	out.close(true)
	code := 0
	if ws := cmd.ProcessState.Sys().(syscall.WaitStatus); ws.Exited() {
		code = ws.ExitStatus()
	}
	exit, _ := json.Marshal(map[string]int{"code": code})
	_ = s.write(encodeFrame(frameExit, exit))
	s.end()
	<-inputDone
}

// readPtyInput applies the client's frames until its stream ends or breaks
// the protocol.
func readPtyInput(s *stream, proc *os.Process, ptmx *os.File) {
	header := make([]byte, frameHeaderBytes)
	for {
		if _, err := io.ReadFull(s.r, header); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(header[1:])
		if n > maxFrameBytes {
			return
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(s.r, payload); err != nil {
			return
		}
		switch header[0] {
		case frameData:
			_, _ = ptmx.Write(payload)
		case frameResize:
			var size map[string]any
			if json.Unmarshal(payload, &size) != nil {
				continue
			}
			cols, rows := dimension(size["cols"], 0), dimension(size["rows"], 0)
			if cols > 0 && rows > 0 {
				_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
			}
		case frameSignal:
			var sig map[string]any
			if json.Unmarshal(payload, &sig) != nil {
				continue
			}
			name, _ := sig["name"].(string)
			if signum, ok := signalByName(name); ok {
				_ = proc.Signal(signum)
			}
		}
	}
}

func encodeFrame(t byte, payload []byte) []byte {
	b := make([]byte, frameHeaderBytes+len(payload))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:], uint32(len(payload)))
	copy(b[frameHeaderBytes:], payload)
	return b
}

// batcher coalesces a terminal's many small writes into fewer, larger data
// frames, by the policy of packages/shared/src/batcher.ts. A tmux redraw
// arrives as many small reads, and sending each as its own frame makes the
// browser paint half-drawn screens, splitting the hide-cursor and
// show-cursor pair so the cursor flashes while scrolling.
//
//   - A push after a quiet window goes out at once, so a keystroke's echo
//     is not delayed.
//   - Pushes within the window of the last flush go out together when it
//     closes.
//   - Reaching the size cap flushes at once.
//
// Writes block, so a client that reads slowly stops the terminal's reader
// and, through the full terminal, the program.
//
// A flush never ends inside a UTF-8 character, since the server decodes
// each frame on its own: an unfinished one waits for the next flush, or
// goes out alone once it has waited a whole window.
type batcher struct {
	mu        sync.Mutex
	write     func([]byte)
	window    time.Duration
	max       int
	pending   []byte
	timer     *time.Timer
	lastFlush time.Time
	closed    bool
}

func newBatcher(write func([]byte)) *batcher {
	return &batcher{write: write, window: batchWindow, max: maxBatchBytes}
}

func (b *batcher) push(p []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || len(p) == 0 {
		return
	}
	b.pending = append(b.pending, p...)
	if len(b.pending) >= b.max {
		b.flush(false)
		return
	}
	if b.timer != nil {
		return
	}
	if since := time.Since(b.lastFlush); since < b.window {
		b.arm(b.window - since)
		return
	}
	b.flush(false)
}

func (b *batcher) arm(d time.Duration) {
	b.timer = time.AfterFunc(d, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.timer = nil
		if !b.closed {
			b.flush(true)
		}
	})
}

// flush writes what is pending but an unfinished last character, which
// the window's end (`windowEnded`) sends when it is all that is left.
func (b *batcher) flush(windowEnded bool) {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	tail := unfinishedRune(b.pending)
	if windowEnded && tail == len(b.pending) {
		tail = 0
	}
	if cut := len(b.pending) - tail; cut > 0 {
		b.write(b.pending[:cut])
		b.lastFlush = time.Now()
		b.pending = b.pending[:copy(b.pending, b.pending[cut:])]
	}
	if len(b.pending) > 0 {
		b.arm(b.window)
	}
}

// close stops the batcher for good, first writing what is pending when
// `flush` is set (the exit frame must follow all output).
func (b *batcher) close(flush bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	if flush && len(b.pending) > 0 {
		b.write(b.pending)
	}
	b.pending = nil
	b.closed = true
}

// unfinishedRune is how many bytes at the end of p begin a UTF-8 character
// that is not complete yet.
func unfinishedRune(p []byte) int {
	for i := len(p) - 1; i >= 0 && i >= len(p)-(utf8.UTFMax-1); i-- {
		if utf8.RuneStart(p[i]) {
			if utf8.FullRune(p[i:]) {
				return 0
			}
			return len(p) - i
		}
	}
	return 0
}
