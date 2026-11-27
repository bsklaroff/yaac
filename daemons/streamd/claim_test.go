package main

// The claim: what it writes into the home dir and the one tmux invocation
// it hands the workspace's environment to. tmux and the opencode
// checkpoint script are replaced by a recorder.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type call struct {
	cmd  string
	args []string
}

type recorder struct {
	mu    sync.Mutex
	calls []call
	env   map[string]string
}

func (r *recorder) deps(home string) claimDeps {
	return claimDeps{
		home: home,
		run: func(cmd string, args ...string) error {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.calls = append(r.calls, call{cmd, args})
			return nil
		},
		setenv: func(name, value string) error {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.env[name] = value
			return nil
		},
	}
}

func (r *recorder) cmds() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, c := range r.calls {
		out = append(out, c.cmd)
	}
	return out
}

func newRecorder() *recorder {
	return &recorder{env: map[string]string{"KEPT": "yes"}}
}

func baseRequest() claimRequest {
	var req claimRequest
	req.Git.Name = `Ada "A" Lovelace`
	req.Git.Email = "ada@example.com"
	req.Git.SafeDirectories = []string{"/workspace", `/workspace/b\c`}
	req.Env = map[string]string{"TZ": "Europe/Paris", "YAAC_PORT_3000": "3000", "EMPTY": ""}
	req.Cwd = "/workspace/app"
	req.StatusRight = "ports: 3000"
	return req
}

func ptr(s string) *string { return &s }

func read(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestClaimWorkspace(t *testing.T) {
	t.Run("writes the git identity and trust, and hands tmux the environment, session and status line in one call", func(t *testing.T) {
		home, r := t.TempDir(), newRecorder()
		write(t, filepath.Join(home, ".gitconfig"), "[stale]\n")
		if err := claimWorkspace(baseRequest(), r.deps(home)); err != nil {
			t.Fatal(err)
		}
		want := strings.Join([]string{
			"[user]",
			"\tname = \"Ada \\\"A\\\" Lovelace\"",
			"\temail = \"ada@example.com\"",
			"[checkout]",
			"\tworkers = 8",
			"[safe]",
			"\tdirectory = \"/workspace\"",
			"\tdirectory = \"/workspace/b\\\\c\"",
			"",
		}, "\n")
		if got := read(t, filepath.Join(home, ".gitconfig")); got != want {
			t.Fatalf("got\n%s", got)
		}
		wantArgs := []string{
			"-S", "/tmp/yaac-tmux/server",
			"set-environment", "-g", "EMPTY", "", ";",
			"set-environment", "-g", "TZ", "Europe/Paris", ";",
			"set-environment", "-g", "YAAC_PORT_3000", "3000", ";",
			"new-session", "-d", "-s", "yaac", "-n", "_yaac-starting", "-x", "500", "-y", "200", "-c", "/workspace/app", "sleep infinity", ";",
			"set-option", "-t", "yaac", "status-right-length", "80", ";",
			"set-option", "-t", "yaac", "status-right", "ports: 3000",
		}
		if len(r.calls) != 1 || r.calls[0].cmd != "tmux" || !slices.Equal(r.calls[0].args, wantArgs) {
			t.Fatalf("got %q", r.calls)
		}
		// No npm registry asked for, so no ~/.npmrc.
		if _, err := os.Stat(filepath.Join(home, ".npmrc")); err == nil {
			t.Fatal("wrote ~/.npmrc")
		}
	})

	// tmux takes an argument ending in `;` as a separator, so these are the
	// values it would otherwise cut short or reject. Run for real: the
	// escaping is tmux's rule, not ours.
	t.Run("gets every value through tmux's argument parser intact, and gives streamd's own environment the variables", func(t *testing.T) {
		if _, err := exec.LookPath("tmux"); err != nil {
			t.Skip("no tmux")
		}
		home, r := t.TempDir(), newRecorder()
		req := baseRequest()
		req.Env = map[string]string{"SEMI": ";", "ENDS": "x;", "ESCAPED": `p\;`, "BRACE": "{", "LINES": "a\nb", "AFTER": "set"}
		req.Cwd = filepath.Join(t.TempDir(), "cwd;")
		req.StatusRight = "ends;"
		if err := os.Mkdir(req.Cwd, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := claimWorkspace(req, r.deps(home)); err != nil {
			t.Fatal(err)
		}
		socket := filepath.Join(home, "tmux")
		args := slices.Clone(r.calls[0].args)
		args[1] = socket
		tmux := func(a ...string) string {
			out, err := exec.Command("tmux", a...).Output()
			if err != nil {
				t.Fatalf("tmux %q: %v", a, err)
			}
			return string(out)
		}
		tmux(append([]string{"-f", "/dev/null"}, args...)...)
		defer func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() }()
		shown := tmux("-S", socket, "show-environment", "-g")
		for name, value := range req.Env {
			if !strings.Contains(shown, name+"="+value+"\n") {
				t.Errorf("%s=%q missing from %q", name, value, shown)
			}
		}
		if got := tmux("-S", socket, "display", "-p", "-t", "yaac", "#{session_path}"); got != req.Cwd+"\n" {
			t.Errorf("session path %q", got)
		}
		if got := tmux("-S", socket, "show-option", "-v", "-t", "yaac", "status-right"); got != "ends;\n" {
			t.Errorf("status-right %q", got)
		}
		wantEnv := map[string]string{"KEPT": "yes"}
		for k, v := range req.Env {
			wantEnv[k] = v
		}
		if len(r.env) != len(wantEnv) {
			t.Fatalf("environment %q", r.env)
		}
		for k, v := range wantEnv {
			if r.env[k] != v {
				t.Fatalf("environment %q", r.env)
			}
		}
	})

	t.Run("adds the npm cache only where ~/.npmrc names no registry", func(t *testing.T) {
		home, r := t.TempDir(), newRecorder()
		npmrc := filepath.Join(home, ".npmrc")
		req := baseRequest()
		req.NpmRegistry = ptr("http://cache.yaac/")
		write(t, npmrc, "fund=false\n")
		if err := claimWorkspace(req, r.deps(home)); err != nil {
			t.Fatal(err)
		}
		if got := read(t, npmrc); got != "fund=false\nregistry=http://cache.yaac/\n" {
			t.Fatalf("got %q", got)
		}
		write(t, npmrc, "registry=https://mine.example/\n")
		if err := claimWorkspace(req, r.deps(home)); err != nil {
			t.Fatal(err)
		}
		if got := read(t, npmrc); got != "registry=https://mine.example/\n" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("restores opencode's working copy from its checkpoint, saving a newer working copy first", func(t *testing.T) {
		home, r := t.TempDir(), newRecorder()
		data := filepath.Join(home, ".local/share/opencode")
		ckpt := filepath.Join(home, ".yaac/opencode-checkpoint")
		for _, d := range []string{data, filepath.Join(ckpt, "storage")} {
			if err := os.MkdirAll(d, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		write(t, filepath.Join(ckpt, "opencode.db"), "saved")
		write(t, filepath.Join(ckpt, "storage", "part"), "p")
		write(t, filepath.Join(ckpt, ".hidden"), "h")
		write(t, filepath.Join(ckpt, ".tmp-1.db"), "partial")
		old := time.Unix(1000, 0)
		if err := os.Chtimes(filepath.Join(ckpt, "opencode.db"), old, old); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(data, "opencode.db"), "newer")
		write(t, filepath.Join(data, "leftover"), "x")
		deps := r.deps(home)
		run := deps.run
		// The checkpoint can leave files of its own in the working copy.
		deps.run = func(cmd string, args ...string) error {
			if cmd == "yaac-opencode-checkpoint" {
				write(t, filepath.Join(data, "opencode.db-shm"), "s")
			}
			return run(cmd, args...)
		}

		if err := claimWorkspace(baseRequest(), deps); err != nil {
			t.Fatal(err)
		}

		if got := r.cmds(); !slices.Equal(got, []string{"yaac-opencode-checkpoint", "tmux"}) {
			t.Fatalf("calls %q", got)
		}
		entries, _ := os.ReadDir(data)
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		if !slices.Equal(names, []string{".hidden", "opencode.db", "storage"}) {
			t.Fatalf("restored %q", names)
		}
		if got := read(t, filepath.Join(data, "opencode.db")); got != "saved" {
			t.Fatalf("db %q", got)
		}
		if got := read(t, filepath.Join(data, "storage", "part")); got != "p" {
			t.Fatalf("nested %q", got)
		}
		// The next claim compares against these times.
		if st, _ := os.Stat(filepath.Join(data, "opencode.db")); !st.ModTime().Equal(old) {
			t.Fatalf("modification time %v", st.ModTime())
		}
	})

	t.Run("waits for the started marker, and gives up past its deadline", func(t *testing.T) {
		home, r := t.TempDir(), newRecorder()
		marker := filepath.Join(home, "started.life")
		req := baseRequest()
		req.StartedMarker, req.WaitMs = ptr(marker), 60_000
		done := make(chan error, 1)
		go func() { done <- claimWorkspace(req, r.deps(home)) }()
		// It cannot finish without the marker; several looks go by.
		time.Sleep(4 * markerPoll)
		select {
		case err := <-done:
			t.Fatalf("finished without the marker: %v", err)
		default:
		}
		if _, err := os.Stat(filepath.Join(home, ".gitconfig")); err == nil || len(r.cmds()) != 0 {
			t.Fatal("went on before the marker")
		}
		write(t, marker, "")
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if got := r.cmds(); !slices.Equal(got, []string{"tmux"}) {
			t.Fatalf("calls %q", got)
		}

		req.StartedMarker, req.WaitMs = ptr(filepath.Join(home, "never")), 0
		if err := claimWorkspace(req, r.deps(home)); err == nil || !strings.Contains(err.Error(), "not ready") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("opens the session and the windows `open` names in one tmux, before waiting for the files, and writes them only after", func(t *testing.T) {
		home, r := t.TempDir(), newRecorder()
		marker := filepath.Join(home, "started.life")
		req := baseRequest()
		req.Env["QUOTED"], req.Env["ENDS"] = "it's", "a;"
		req.StartedMarker, req.WaitMs = ptr(marker), 60_000
		req.Open = ptr(`new-window -d -n agent 'exec acpd' \; set-option -t =yaac:=agent remain-on-exit on`)
		done := make(chan error, 1)
		go func() { done <- claimWorkspace(req, r.deps(home)) }()
		// The session and the agents' windows are up while the tree fills.
		waitFor(t, func() bool { return slices.Equal(r.cmds(), []string{"sh"}) })
		if _, err := os.Stat(filepath.Join(home, ".gitconfig")); err == nil {
			t.Fatal("wrote the files before the marker")
		}
		write(t, marker, "")
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		// The session is not opened a second time.
		if got := r.cmds(); !slices.Equal(got, []string{"sh"}) {
			t.Fatalf("calls %q", got)
		}

		// The shell hands one tmux every argument as it was, then `open`'s.
		bin := t.TempDir()
		if err := os.WriteFile(filepath.Join(bin, "tmux"), []byte("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		sh := exec.Command("/bin/sh", r.calls[0].args...)
		sh.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
		out, err := sh.Output()
		if err != nil {
			t.Fatal(err)
		}
		argv := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
		if !slices.Equal(argv[:2], []string{"-S", "/tmp/yaac-tmux/server"}) {
			t.Fatalf("argv %q", argv)
		}
		after := func(name string) string { return argv[slices.Index(argv, name)+1] }
		if after("QUOTED") != "it's" || after("ENDS") != `a\;` {
			t.Fatalf("argv %q", argv)
		}
		wantTail := []string{";", "new-window", "-d", "-n", "agent", "exec acpd", ";", "set-option", "-t", "=yaac:=agent", "remain-on-exit", "on"}
		if !slices.Equal(argv[len(argv)-len(wantTail):], wantTail) {
			t.Fatalf("argv %q", argv)
		}
	})

	t.Run("refuses a git value with a line break", func(t *testing.T) {
		home, r := t.TempDir(), newRecorder()
		req := baseRequest()
		req.Git.Name = "a\n[core]"
		if err := claimWorkspace(req, r.deps(home)); err == nil || !strings.Contains(err.Error(), "line break") {
			t.Fatalf("got %v", err)
		}
		if len(r.calls) != 0 {
			t.Fatalf("calls %q", r.calls)
		}
	})
}

// Over a stream: the request rides with the handshake, and a failure is
// the reply's error.
func TestClaimStream(t *testing.T) {
	home, r := t.TempDir(), newRecorder()
	port := startDaemon(t, func(c *config) { c.claim = r.deps(home) })
	body, _ := json.Marshal(map[string]any{
		"git": map[string]any{"name": "Ada", "email": "ada@example.com"},
		"env": map[string]string{"A": "1"}, "cwd": "/workspace",
	})
	c := open(t, port, map[string]any{"token": testToken, "kind": "claim", "bytes": len(body)}, body...).mustOK()
	if got := c.reply(); !got.OK {
		t.Fatalf("got %+v", got)
	}
	if got := r.cmds(); !slices.Equal(got, []string{"tmux"}) || r.env["A"] != "1" {
		t.Fatalf("calls %q, environment %q", got, r.env)
	}

	bad := []byte(`{"git":{"name":"a\n"}}`)
	c = open(t, port, map[string]any{"token": testToken, "kind": "claim", "bytes": len(bad)}, bad...).mustOK()
	if got := c.reply(); got.OK || !strings.Contains(got.Error, "line break") {
		t.Fatalf("got %+v", got)
	}

	if got := open(t, port, map[string]any{"token": testToken, "kind": "claim", "bytes": 0}).reply(); got.Error != "claim: bytes must be a size" {
		t.Fatalf("got %+v", got)
	}
}
