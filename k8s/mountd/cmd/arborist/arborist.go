package main

// The arborist (docs/generic-workspace-pods.md "Trees"): builds working
// trees natively from the main clones, as the install uid with no
// capability. It reads the main clones, mounted read-only at the server's
// own path (a fork's main clone borrows from its upstream's by that path),
// and writes only `ready/`. mountd moves a finished tree to where
// its workspace mounts it.
//
//	ready/<repo>/<commit>.<n>/{tree,index}   kept ready (the server's ready set)
//	ready/.start-<random>/{tree,index}       taken by one start
//	ready/.tmp-<random>/                     being built
//	ready/.trash-<random>/                   being removed
//
// A directory with a final name is complete: a build writes under a
// temporary one and renames. A start takes a tree with `POST /take`, which
// renames a kept one out of the kept set, or builds one, under a name of
// its own that nothing here touches again; mountd then moves it.
// A kept tree is removed by renaming it to trash first, under the same
// lock, so a take never finds one half removed.
//
// A start's build runs at once, beside any others. Builds ahead of time
// run one at a time and wait while any start's build runs, so many base
// branches moving together never crowd a start.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"yaac-mountd/internal/wire"
)

// backdateBy is how far a built tree's files are set back, so none is in
// the same second as the index that describes it.
const backdateBy = 2 * time.Second

type arborist struct {
	repos, ready string
	// Starts' builds under way; ahead-of-time builds wait for zero.
	mu       sync.Mutex
	starts   int
	idle     *sync.Cond
	want     []wire.TreeKey
	wantSet  chan struct{}
	building map[wire.TreeKey]bool
}

func newArborist(repos, ready string) *arborist {
	a := &arborist{repos: repos, ready: ready, wantSet: make(chan struct{}, 1), building: map[wire.TreeKey]bool{}}
	a.idle = sync.NewCond(&a.mu)
	return a
}

func randomName(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// git runs git against a main clone with config pinned over anything the
// clone or the environment says: no hooks, no transport, no lazy fetch.
func (a *arborist) git(ctx context.Context, env []string, args ...string) ([]byte, error) {
	full := append([]string{
		"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
		"-c", "safe.directory=*", "-c", "index.version=2", "-c", "core.symlinks=true",
		"-c", "checkout.workers=8", "-c", "checkout.thresholdForParallelism=100",
	}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append([]string{
		"HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1", "GIT_NO_LAZY_FETCH=1", "GIT_TERMINAL_PROMPT=0", "PATH=/usr/bin:/bin",
	}, env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// build writes k's tree and index under a temporary name and renames it to
// dest (a name in ready/), returning dest.
func (a *arborist) build(ctx context.Context, k wire.TreeKey, dest string) error {
	gitDir := filepath.Join(a.repos, k.Repo, ".git")
	tmp := filepath.Join(a.ready, randomName(".tmp-"))
	if err := os.MkdirAll(filepath.Join(tmp, "tree"), 0o755); err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(tmp)
		}
	}()
	env := []string{"GIT_DIR=" + gitDir, "GIT_WORK_TREE=" + filepath.Join(tmp, "tree"), "GIT_INDEX_FILE=" + filepath.Join(tmp, "index")}
	if k.Commit == "" {
		// An empty repository's checkout: no files, an empty index.
		if _, err := a.git(ctx, env, "read-tree", "--empty"); err != nil {
			return err
		}
	} else {
		if _, err := a.git(ctx, env, "read-tree", "-u", "--reset", k.Commit); err != nil {
			return err
		}
		format, err := a.git(ctx, []string{"GIT_DIR=" + gitDir}, "rev-parse", "--show-object-format")
		if err != nil {
			return err
		}
		idLen := 20
		if strings.TrimSpace(string(format)) == "sha256" {
			idLen = 32
		}
		if err := backdateTree(filepath.Join(tmp, "index"), filepath.Join(tmp, "tree"), idLen, time.Now().Add(-backdateBy)); err != nil {
			return fmt.Errorf("backdate: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	ok = true
	return nil
}

// take hands one start a tree of k: a kept one if there is one, else one
// built at once. Returns its name in ready/.
func (a *arborist) take(ctx context.Context, k wire.TreeKey) (string, error) {
	name := randomName(".start-")
	a.mu.Lock()
	have, err := a.kept()
	if err == nil && len(have[k]) > 0 {
		err = os.Rename(filepath.Join(a.ready, have[k][0]), filepath.Join(a.ready, name))
		a.mu.Unlock()
		if err != nil {
			return "", err
		}
		a.notifyWant()
		return name, nil
	}
	a.starts++
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.starts--
		if a.starts == 0 {
			a.idle.Broadcast()
		}
		a.mu.Unlock()
	}()
	if err := a.build(ctx, k, filepath.Join(a.ready, name)); err != nil {
		return "", err
	}
	return name, nil
}

func (a *arborist) notifyWant() {
	select {
	case a.wantSet <- struct{}{}:
	default:
	}
}

// discard removes a kept tree: renamed to trash under the lock, then
// removed outside it.
func (a *arborist) discard(dir string) {
	trash := filepath.Join(a.ready, randomName(".trash-"))
	a.mu.Lock()
	err := os.Rename(filepath.Join(a.ready, dir), trash)
	a.mu.Unlock()
	if err == nil {
		err = os.RemoveAll(trash)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("arborist: removing %s: %v", dir, err)
	}
}

// kept lists the trees kept ready, by key, with their directory names.
func (a *arborist) kept() (map[wire.TreeKey][]string, error) {
	out := map[wire.TreeKey][]string{}
	repos, err := os.ReadDir(a.ready)
	if err != nil {
		return nil, err
	}
	for _, r := range repos {
		if !r.IsDir() || strings.HasPrefix(r.Name(), ".") {
			continue
		}
		trees, err := os.ReadDir(filepath.Join(a.ready, r.Name()))
		if err != nil {
			continue
		}
		for _, t := range trees {
			commit, _, ok := strings.Cut(t.Name(), ".")
			if !ok || strings.HasPrefix(t.Name(), ".") {
				continue
			}
			k := wire.TreeKey{Repo: r.Name(), Commit: commit}
			out[k] = append(out[k], filepath.Join(r.Name(), t.Name()))
		}
	}
	return out, nil
}

// converge keeps one tree for each wanted key and removes the rest, one
// build at a time, each waiting until no start's build runs.
func (a *arborist) converge(ctx context.Context) {
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-a.wantSet:
		case <-time.After(30 * time.Second):
		}
		a.mu.Lock()
		want := append([]wire.TreeKey(nil), a.want...)
		have, err := a.kept()
		a.mu.Unlock()
		if err != nil {
			log.Printf("arborist: reading ready/: %v", err)
			continue
		}
		wanted := map[wire.TreeKey]bool{}
		for _, k := range want {
			wanted[k] = true
		}
		for k, dirs := range have {
			for i, d := range dirs {
				if !wanted[k] || i > 0 {
					a.discard(d)
				}
			}
			// The repo's folder once it is empty.
			_ = os.Remove(filepath.Join(a.ready, k.Repo))
		}
		for _, k := range want {
			if len(have[k]) > 0 {
				continue
			}
			a.mu.Lock()
			for a.starts > 0 {
				a.idle.Wait()
			}
			a.mu.Unlock()
			name := randomName(".ahead-")
			if err := a.build(ctx, k, filepath.Join(a.ready, name)); err != nil {
				log.Printf("arborist: building %s at %s: %v", k.Repo, k.Commit, err)
				continue
			}
			// Named into the kept set under the lock, so a take sees it whole.
			a.mu.Lock()
			err := os.MkdirAll(filepath.Join(a.ready, k.Repo), 0o755)
			if err == nil {
				err = os.Rename(filepath.Join(a.ready, name), filepath.Join(a.ready, k.Repo, fmt.Sprintf("%s.%d", k.Commit, time.Now().UnixNano())))
			}
			a.mu.Unlock()
			if err != nil {
				log.Printf("arborist: keeping %s at %s: %v", k.Repo, k.Commit, err)
				_ = os.RemoveAll(filepath.Join(a.ready, name))
			}
		}
	}
}

// clearLeftovers removes what an earlier run left: builds and removals cut
// short, and trees taken for starts whose requests then failed (the
// mountd moves a taken tree before its request answers).
func (a *arborist) clearLeftovers() {
	entries, err := os.ReadDir(a.ready)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			_ = os.RemoveAll(filepath.Join(a.ready, e.Name()))
		}
	}
}

func (a *arborist) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("POST /take", func(w http.ResponseWriter, r *http.Request) {
		var k wire.TreeKey
		if err := json.NewDecoder(r.Body).Decode(&k); err != nil {
			wire.Error(w, http.StatusBadRequest, err)
			return
		}
		if err := k.Check(); err != nil {
			wire.Error(w, http.StatusBadRequest, err)
			return
		}
		name, err := a.take(r.Context(), k)
		if err != nil {
			wire.Error(w, http.StatusInternalServerError, err)
			return
		}
		wire.WriteJSON(w, map[string]string{"dir": name})
	})
	mux.HandleFunc("PUT /ready", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Want []wire.TreeKey `json:"want"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			wire.Error(w, http.StatusBadRequest, err)
			return
		}
		for _, k := range body.Want {
			if err := k.Check(); err != nil {
				wire.Error(w, http.StatusBadRequest, err)
				return
			}
		}
		a.mu.Lock()
		a.want = body.Want
		a.mu.Unlock()
		a.notifyWant()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, _ *http.Request) {
		a.mu.Lock()
		have, err := a.kept()
		a.mu.Unlock()
		if err != nil {
			wire.Error(w, http.StatusInternalServerError, err)
			return
		}
		out := []wire.TreeKey{}
		for k := range have {
			out = append(out, k)
		}
		wire.WriteJSON(w, out)
	})
	return mux
}

func runArborist(listen, repos, ready string) error {
	a := newArborist(repos, ready)
	a.clearLeftovers()
	go a.converge(context.Background())
	log.Printf("arborist: listening on %s", listen)
	return (&http.Server{Addr: listen, Handler: a.handler(), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe()
}
