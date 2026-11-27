package main

// The claim kind: everything a pod is told when it becomes one workspace's,
// done in streamd's own process (docs/generic-workspace-pods.md "A claim").
// Each process started inside a gVisor sandbox costs 12 to 50 ms, so files
// are written here rather than by commands, and tmux is told everything in
// one invocation.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	// Keep in sync with CONTAINER_TMUX_SOCK (packages/shared/src/paths.ts).
	tmuxSocket = "/tmp/yaac-tmux/server"
	// Keep in sync with KEEPER_STARTING in the server's driver contract
	// (packages/server/src/drivers/contract.ts); the server renames the
	// keeper window to `_yaac` once its setup is done.
	keeperStarting = "_yaac-starting"
	// Between looks for the tree container's started marker.
	markerPoll = 25 * time.Millisecond
	// How often the running pod checkpoints opencode's history; a killed
	// pod loses at most this much (docs/workspace-storage.md "opencode").
	opencodeCheckpointIntervalSeconds = 300
	// Cap on a claim's request, which carries the workspace's environment.
	claimMaxBytes = 4 * 1024 * 1024
)

// What a claim needs from the pod, which tests replace.
type claimDeps struct {
	home string
	// Runs a command to its end; fails with its stderr on a nonzero exit.
	run    func(cmd string, args ...string) error
	setenv func(name, value string) error
	// Whether to start opencode's checkpoint loop.
	checkpointLoop bool
}

// The request. `env` goes into tmux's global environment and into
// streamd's own, so every window and every later exec or pty sees it.
type claimRequest struct {
	// Wait for the tree container to report the workspace's files ready
	// before anything reads them.
	StartedMarker *string `json:"startedMarker"`
	WaitMs        float64 `json:"waitMs"`
	Git           struct {
		Name            string   `json:"name"`
		Email           string   `json:"email"`
		SafeDirectories []string `json:"safeDirectories"`
	} `json:"git"`
	// The install's npm cache, when the workspace uses it.
	NpmRegistry *string           `json:"npmRegistry"`
	Env         map[string]string `json:"env"`
	Cwd         string            `json:"cwd"`
	StatusRight string            `json:"statusRight"`
	// tmux commands that open the workspace's agent windows, written as a
	// shell passes them to one tmux (`\;` between commands). With it the
	// session and those windows open first, in one tmux, so the agents boot
	// while the files are made ready; the server holds them off the files
	// until then (`holdAcpHandshakes`). Without it the session opens last.
	Open *string `json:"open"`
}

// `{kind: "claim", bytes: n}`, then n bytes of JSON; the reply is one JSON
// line, {ok} or {ok: false, error}.
func claimKind(d *daemon, s *stream, p params) (func(), string) {
	n, ok := integer(p["bytes"])
	if !ok || n <= 0 || n > claimMaxBytes {
		return nil, "claim: bytes must be a size"
	}
	return func() {
		body := make([]byte, n)
		if _, err := io.ReadFull(s.r, body); err != nil {
			return
		}
		var req claimRequest
		err := json.Unmarshal(body, &req)
		if err == nil {
			err = claimWorkspace(req, d.cfg.claim)
		}
		if err != nil {
			_ = s.writeJSON(reply{Error: err.Error()})
		} else {
			_ = s.writeJSON(reply{OK: true})
		}
		s.endAndDrain()
	}, ""
}

// claimWorkspace makes this pod one workspace's. opencode's history is
// restored before any window opens, since an agent may be opencode.
func claimWorkspace(req claimRequest, deps claimDeps) error {
	names := sortedKeys(req.Env)
	for _, name := range names {
		if err := deps.setenv(name, req.Env[name]); err != nil {
			return err
		}
	}
	opencode, err := restoreOpencode(deps.home, deps.run)
	if err != nil {
		return err
	}
	args := tmuxClaimArgs(names, req.Env, req.Cwd, req.StatusRight)
	if req.Open != nil {
		quoted := make([]string, len(args))
		for i, a := range args {
			quoted[i] = shellQuote(a)
		}
		if err := deps.run("sh", "-c", "tmux "+strings.Join(quoted, " ")+` \; `+*req.Open); err != nil {
			return err
		}
	}
	if req.StartedMarker != nil {
		if err := awaitMarker(*req.StartedMarker, time.Duration(req.WaitMs)*time.Millisecond); err != nil {
			return err
		}
	}
	gitconfig, err := gitConfigText(req.Git.Name, req.Git.Email, req.Git.SafeDirectories)
	if err != nil {
		return err
	}
	if err := writeWhole(filepath.Join(deps.home, ".gitconfig"), gitconfig); err != nil {
		return err
	}
	if req.NpmRegistry != nil {
		if err := writeNpmRegistry(deps.home, *req.NpmRegistry); err != nil {
			return err
		}
	}
	if req.Open == nil {
		if err := deps.run("tmux", args...); err != nil {
			return err
		}
	}
	if opencode && deps.checkpointLoop {
		// Its own session under the pod's init, so it outlives this stream;
		// the pod's preStop hook runs the same script one last time with
		// `stop`.
		loop := exec.Command("setsid", "sh", "-c",
			fmt.Sprintf("while sleep %d; do yaac-opencode-checkpoint; done", opencodeCheckpointIntervalSeconds))
		if loop.Start() == nil {
			go func() { _ = loop.Wait() }()
		}
	}
	return nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// gitConfigText is `~/.gitconfig`: the identity, each checkout trusted,
// and checkouts written by 8 processes at once (keep in sync with
// CHECKOUT_WORKERS in packages/server/src/domain/git/repo.ts). Written
// whole: the image's home holds none, and nothing writes it before the
// claim.
func gitConfigText(name, email string, safeDirectories []string) (string, error) {
	lines := []string{"[user]"}
	for _, kv := range [][2]string{{"name", name}, {"email", email}} {
		v, err := gitValue(kv[1])
		if err != nil {
			return "", err
		}
		lines = append(lines, "\t"+kv[0]+" = "+v)
	}
	lines = append(lines, "[checkout]", "\tworkers = 8")
	if len(safeDirectories) > 0 {
		lines = append(lines, "[safe]")
		for _, d := range safeDirectories {
			v, err := gitValue(d)
			if err != nil {
				return "", err
			}
			lines = append(lines, "\tdirectory = "+v)
		}
	}
	return strings.Join(lines, "\n") + "\n", nil
}

// gitValue quotes a git config value, so any character but a line break
// survives.
func gitValue(v string) (string, error) {
	if strings.ContainsAny(v, "\n\r\x00") {
		return "", errors.New("a git config value cannot hold a line break")
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v) + `"`, nil
}

// writeWhole replaces a file through a temp file renamed over it.
func writeWhole(file, text string) error {
	tmp := fmt.Sprintf("%s.yaac-%d", file, os.Getpid())
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

var npmRegistryLine = regexp.MustCompile(`(?m)^registry=`)

// writeNpmRegistry makes the install's npm cache the default registry, at
// user-config precedence: pnpm and npm read `~/.npmrc` below a project's
// own `.npmrc`, so a project that names a registry keeps it, which an env
// var would override. Skipped when the file already names one.
func writeNpmRegistry(home, url string) error {
	file := filepath.Join(home, ".npmrc")
	text, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if npmRegistryLine.Match(text) {
		return nil
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	_, err = f.WriteString("registry=" + url + "\n")
	return errors.Join(err, f.Close())
}

var checkpointScratch = regexp.MustCompile(`^\.tmp-.*\.db$`)

// restoreOpencode restores the node-local working copy of opencode's history
// from the global checkpoint, the only source of truth. A working copy
// whose database (or its WAL) is newer than the checkpoint's is
// checkpointed first, so an unclean stop on a node that survived costs
// nothing. It reports whether the pod keeps a working copy, which the
// checkpoint loop then saves. Keep the paths in sync with
// CONTAINER_OPENCODE_DATA and CONTAINER_OPENCODE_CHECKPOINT
// (packages/shared/src/paths.ts) and with yaac-opencode-checkpoint.
func restoreOpencode(home string, run func(string, ...string) error) (bool, error) {
	data := filepath.Join(home, ".local/share/opencode")
	checkpoint := filepath.Join(home, ".yaac/opencode-checkpoint")
	if !exists(data) {
		return false, nil
	}
	hasCheckpoint := exists(checkpoint)
	if hasCheckpoint {
		entries, err := os.ReadDir(data)
		if err != nil {
			return false, err
		}
		if i := slices.IndexFunc(entries, func(e fs.DirEntry) bool { return strings.HasSuffix(e.Name(), ".db") }); i >= 0 {
			db := entries[i].Name()
			var saved time.Time
			if st, err := os.Stat(filepath.Join(checkpoint, db)); err == nil {
				saved = st.ModTime()
			}
			for _, name := range []string{db, db + "-wal"} {
				if st, err := os.Stat(filepath.Join(data, name)); err == nil && st.ModTime().After(saved) {
					_ = run("yaac-opencode-checkpoint")
					break
				}
			}
		}
	}
	// Listed after the checkpoint, which can leave files of its own there.
	entries, err := os.ReadDir(data)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(data, e.Name())); err != nil {
			return false, err
		}
	}
	if !hasCheckpoint {
		return false, nil
	}
	saved, err := os.ReadDir(checkpoint)
	if err != nil {
		return false, err
	}
	for _, e := range saved {
		if checkpointScratch.MatchString(e.Name()) {
			continue
		}
		if err := copyTree(filepath.Join(checkpoint, e.Name()), filepath.Join(data, e.Name())); err != nil {
			return false, err
		}
	}
	return true, nil
}

// copyTree copies a file, a link or a directory tree, keeping each file's
// mode and modification time: the next claim's "newer than the checkpoint"
// test reads them.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		info, err := e.Info()
		if err != nil {
			return err
		}
		switch {
		case e.IsDir():
			return os.MkdirAll(target, info.Mode().Perm())
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		default:
			if err := copyFile(path, target, info.Mode().Perm()); err != nil {
				return err
			}
			return os.Chtimes(target, info.ModTime(), info.ModTime())
		}
	})
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	return errors.Join(err, out.Close())
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// awaitMarker waits for `file` to exist, or fails after `wait`.
func awaitMarker(file string, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for !exists(file) {
		if time.Now().After(deadline) {
			return fmt.Errorf("the workspace's files were not ready after %.0fs", wait.Seconds())
		}
		time.Sleep(markerPoll)
	}
	return nil
}

// runCommand runs a command to its end; it fails with its stderr on a
// nonzero exit.
func runCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("%s exited %d: %s", name, exit.ExitCode(), strings.TrimSpace(stderr.String()))
	}
	return err
}

// shellQuote makes `s` one shell word.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// tmuxArg is one argument as tmux reads it from argv. tmux takes an
// argument ending in `;` as a command separator, keeping what comes before
// it, and one ending in `\;` as that text ending in a plain `;`. So a value
// whose last character is `;` gets a backslash before it, and every other
// value passes through unchanged.
func tmuxArg(v string) string {
	if strings.HasSuffix(v, ";") {
		return v[:len(v)-1] + `\;`
	}
	return v
}

// tmuxClaimArgs is the one tmux invocation of a claim: the workspace's
// environment set on the server before its session exists, so every window
// inherits it, then the session on its keeper window at the workspace's
// cwd, and its status line.
//
// `-x`/`-y` give every window a size larger than any terminal, so tmux
// shrinks it to fit on attach; a TUI that renders at tmux's default 80x24
// before the first attach can otherwise stay stuck there.
func tmuxClaimArgs(names []string, env map[string]string, cwd, statusRight string) []string {
	args := []string{"-S", tmuxSocket}
	for _, name := range names {
		args = append(args, "set-environment", "-g", name, tmuxArg(env[name]), ";")
	}
	return append(args,
		"new-session", "-d", "-s", "yaac", "-n", keeperStarting, "-x", "500", "-y", "200", "-c", tmuxArg(cwd), "sleep infinity", ";",
		"set-option", "-t", "yaac", "status-right-length", "80", ";",
		"set-option", "-t", "yaac", "status-right", tmuxArg(statusRight),
	)
}
