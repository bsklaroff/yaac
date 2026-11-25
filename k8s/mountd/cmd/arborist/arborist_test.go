package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"yaac-mountd/internal/wire"
)

// A main clone at <repos>/<id>/.git with one commit; returns the commit.
func mainClone(t *testing.T, repos, id string) string {
	t.Helper()
	dir := filepath.Join(repos, id)
	git := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "HOME="+repos, "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@a")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	_ = os.MkdirAll(dir, 0o755)
	git("init", "-q")
	_ = os.WriteFile(filepath.Join(dir, "f.txt"), []byte("hi"), 0o644)
	git("add", "-A")
	git("commit", "-qm", "c")
	return git("rev-parse", "HEAD")
}

// A start's take builds at once under a name of its own; a kept tree is
// taken by renaming it out of the kept set, which the converge loop then
// rebuilds; an unwanted kept tree is removed.
func TestArboristTakeAndKeep(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repos, ready := t.TempDir(), t.TempDir()
	commit := mainClone(t, repos, "r1")
	a := newArborist(repos, ready)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	name, err := a.take(ctx, wire.TreeKey{Repo: "r1", Commit: commit})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(name, ".start-") {
		t.Fatalf("named %q", name)
	}
	if b, _ := os.ReadFile(filepath.Join(ready, name, "tree", "f.txt")); string(b) != "hi" {
		t.Errorf("tree holds %q", b)
	}
	if _, err := os.Stat(filepath.Join(ready, name, "index")); err != nil {
		t.Error("no index")
	}

	go a.converge(ctx)
	a.mu.Lock()
	a.want = []wire.TreeKey{{Repo: "r1", Commit: commit}}
	a.mu.Unlock()
	a.notifyWant()
	waitFor(t, func() bool { k, _ := a.kept(); return len(k[wire.TreeKey{Repo: "r1", Commit: commit}]) == 1 })

	taken, err := a.take(ctx, wire.TreeKey{Repo: "r1", Commit: commit})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(ready, taken, "tree", "f.txt")); err != nil {
		t.Error("the kept tree was not handed over")
	}
	waitFor(t, func() bool { k, _ := a.kept(); return len(k[wire.TreeKey{Repo: "r1", Commit: commit}]) == 1 })

	a.mu.Lock()
	a.want = nil
	a.mu.Unlock()
	a.notifyWant()
	waitFor(t, func() bool { k, _ := a.kept(); return len(k) == 0 })

	if _, err := a.take(ctx, wire.TreeKey{Repo: "r1", Commit: strings.Repeat("0", 40)}); err == nil {
		t.Error("built a commit the clone lacks")
	}
	if err := (wire.TreeKey{Repo: "../x", Commit: commit}).Check(); err == nil {
		t.Error("a repo id with a slash passed")
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatal("condition never held")
}
