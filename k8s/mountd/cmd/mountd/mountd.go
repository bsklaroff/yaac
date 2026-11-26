package main

// mountd (docs/generic-workspace-pods.md "mountd"):
// privileged, in the host's pid namespace, with the node-mounts root and the
// node-local root under bidirectional propagation, so a mount it makes there
// reaches the node and from there the pod it is for. It never reads
// repository content.
//
//	POST /bind    make a pod its workspace's: take its trees, make its
//	              node-local folders, mount each entry under its node-mounts
//	              directory, write the list the tree container binds from,
//	              and bind the workspace container's entries from inside it
//	GET  /report  its build, whether the arborist answers, free space
//	              for trees, the trees kept ready, directories it could not
//	              release
//
// Only the server may call it (a network policy, and a bearer token derived
// from the install's proxy secret). Take, bind and release for one pod hold
// that pod's lock, and a bind answered once is answered the same way again,
// so a retried request is safe. A pod's node-mounts directory is released
// once no pod in a fresh list of the node's pods mounts it.

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"yaac-mountd/internal/wire"
)

type config struct {
	listen      string
	token       string
	build       string
	namespace   string
	node        string
	nmRoot      string // the node-mounts root, as this container sees it
	nmRootNode  string // and as the node does (what pods' hostPath volumes name)
	nodeLocal   string
	tiers       map[string]string // tier name -> its root here
	hostRun     string
	runsc       string
	helper      string // sandbox-bind, handed to sandboxes
	arboristURL string
	uid, gid    int
}

// bindMount is one mount of a workspace.
type bindMount struct {
	Tier string `json:"tier"`
	Path string `json:"path"`
	// Where the workspace container sees it, and where the tree container
	// does; either may be empty.
	Workspace string `json:"workspace,omitempty"`
	Tree      string `json:"tree,omitempty"`
	ReadOnly  bool   `json:"readOnly,omitempty"`
}

// treeTake is one checkout's tree: built (or kept) at Commit, moved to Dest
// and its index to Index, both relative to the node-local root.
type treeTake struct {
	wire.TreeKey
	Dest  string `json:"dest"`
	Index string `json:"index"`
}

type bindRequest struct {
	// The claim's own token: a retry carrying it gets the first answer.
	Token       string      `json:"token"`
	Pod         string      `json:"pod"`
	WorkspaceID string      `json:"workspaceId"`
	Dir         string      `json:"dir"`
	Life        string      `json:"life"`
	Trees       []treeTake  `json:"trees"`
	Dirs        []string    `json:"dirs"`
	Mounts      []bindMount `json:"mounts"`
	// Folders of the pod's own volumes bound where the workspace container
	// asks: the scratch dirs, and any `emptyDir` it names.
	Folders []folderBind      `json:"folders"`
	Roots   map[string]string `json:"roots"`
}

type folderBind struct {
	From   string `json:"from"`
	Target string `json:"target"`
}

type mounter struct {
	cfg     config
	pods    *nodePods
	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	done    map[string]string // node-mounts dir -> the token of the bind that finished
	stuck   map[string]string
	http    *http.Client
	release chan struct{}
}

func (m *mounter) lock(dir string) func() {
	m.mu.Lock()
	l, ok := m.locks[dir]
	if !ok {
		l = &sync.Mutex{}
		m.locks[dir] = l
	}
	m.mu.Unlock()
	l.Lock()
	return l.Unlock
}

var dirNamePattern = wire.IDPattern

func (r *bindRequest) check() error {
	if r.Token == "" || r.Pod == "" || r.WorkspaceID == "" || r.Life == "" {
		return errors.New("token, pod, workspaceId and life are required")
	}
	if !dirNamePattern.MatchString(r.Dir) || !dirNamePattern.MatchString(r.Life) {
		return errors.New("dir and life must be plain names")
	}
	for _, t := range r.Trees {
		if err := t.Check(); err != nil {
			return err
		}
		for _, p := range []string{t.Dest, t.Index} {
			if _, err := cleanRel(p); err != nil || p == "." || p == "" {
				return fmt.Errorf("tree path %q: not a relative path", p)
			}
		}
	}
	for _, d := range r.Dirs {
		if _, err := cleanRel(d); err != nil {
			return err
		}
	}
	for _, mnt := range r.Mounts {
		if _, err := cleanRel(mnt.Path); err != nil {
			return err
		}
		for _, t := range []string{mnt.Workspace, mnt.Tree} {
			if t != "" && (!filepath.IsAbs(t) || filepath.Clean(t) != t) {
				return fmt.Errorf("target %q is not a clean absolute path", t)
			}
		}
	}
	for _, f := range r.Folders {
		if _, ok := r.Roots[f.From]; !ok {
			return fmt.Errorf("a folder of %q, which names no volume", f.From)
		}
		if !filepath.IsAbs(f.Target) || filepath.Clean(f.Target) != f.Target {
			return fmt.Errorf("folder target %q is not a clean absolute path", f.Target)
		}
	}
	return nil
}

// target is the pod the request names, checked against it: on this node,
// its workspace's, sandboxed, running its workspace container, with the
// node-mounts directory the request names.
func (m *mounter) target(ctx context.Context, r *bindRequest) (string, error) {
	p, err := m.pods.get(ctx, r.Pod)
	if err != nil {
		return "", err
	}
	switch {
	case p.Spec.NodeName != m.cfg.node:
		return "", fmt.Errorf("pod %s is not on node %s", r.Pod, m.cfg.node)
	case p.Labels["yaac.workspace-id"] != r.WorkspaceID:
		return "", fmt.Errorf("pod %s is not workspace %s's", r.Pod, r.WorkspaceID)
	case p.Spec.RuntimeClassName == nil || *p.Spec.RuntimeClassName == "":
		return "", fmt.Errorf("pod %s runs in no sandbox", r.Pod)
	case p.DeletionTimestamp != nil:
		return "", fmt.Errorf("pod %s is being deleted", r.Pod)
	}
	if dir, ok := hostPathUnder(p, m.cfg.nmRootNode); !ok || dir != r.Dir {
		return "", fmt.Errorf("pod %s does not mount node-mounts directory %s", r.Pod, r.Dir)
	}
	id, ok := runningContainer(p, "workspace")
	if !ok {
		return "", fmt.Errorf("pod %s's workspace container is not running", r.Pod)
	}
	return id, nil
}

// takeTree asks the arborist for a tree and moves it into place.
func (m *mounter) takeTree(ctx context.Context, t treeTake, rootFd int) error {
	body, _ := json.Marshal(t.TreeKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.arboristURL+"/take", bytes.NewReader(body))
	if err != nil {
		return err
	}
	res, err := m.http.Do(req)
	if err != nil {
		return fmt.Errorf("arborist: %w", err)
	}
	defer res.Body.Close()
	var answer struct{ Dir, Error string }
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&answer); err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("arborist: %s", answer.Error)
	}
	if !strings.HasPrefix(answer.Dir, ".start-") || strings.Contains(answer.Dir, "/") {
		return fmt.Errorf("arborist named %q", answer.Dir)
	}
	readyFd, err := openBeneath(rootFd, "ready", unix.O_PATH|unix.O_DIRECTORY)
	if err != nil {
		return err
	}
	defer unix.Close(readyFd)
	takenFd, err := openBeneath(readyFd, answer.Dir, unix.O_PATH|unix.O_DIRECTORY)
	if err != nil {
		return err
	}
	defer unix.Close(takenFd)
	for _, move := range []struct{ from, to string }{{"index", t.Index}, {"tree", t.Dest}} {
		parentFd, err := mkdirAllOwned(rootFd, filepath.Dir(move.to), m.cfg.uid, m.cfg.gid)
		if err != nil {
			return err
		}
		err = unix.Renameat2(takenFd, move.from, parentFd, filepath.Base(move.to), unix.RENAME_NOREPLACE)
		unix.Close(parentFd)
		if err != nil {
			return fmt.Errorf("moving the tree to %s: %w", move.to, err)
		}
	}
	return unix.Unlinkat(readyFd, answer.Dir, unix.AT_REMOVEDIR)
}

// bindPhases records how long each part of a bind took, for its log line.
type bindPhases []string

func (p *bindPhases) mark(name string, since *time.Time) {
	*p = append(*p, fmt.Sprintf("%s %s", name, time.Since(*since).Round(time.Millisecond)))
	*since = time.Now()
}

func (m *mounter) bind(ctx context.Context, r *bindRequest, phases *bindPhases) error {
	at := time.Now()
	if err := r.check(); err != nil {
		return err
	}
	unlock := m.lock(r.Dir)
	defer unlock()
	m.mu.Lock()
	finished := m.done[r.Dir]
	m.mu.Unlock()
	if finished == r.Token {
		return nil
	}
	if finished != "" {
		return fmt.Errorf("node-mounts directory %s was bound by another claim", r.Dir)
	}
	container, err := m.target(ctx, r)
	if err != nil {
		return err
	}

	phases.mark("check", &at)
	nodeFd, err := openRoot(m.cfg.nodeLocal)
	if err != nil {
		return err
	}
	defer unix.Close(nodeFd)
	for _, t := range r.Trees {
		if err := m.takeTree(ctx, t, nodeFd); err != nil {
			return fmt.Errorf("tree of %s: %w", t.Repo, err)
		}
	}
	phases.mark("trees", &at)
	for _, d := range r.Dirs {
		fd, err := mkdirAllOwned(nodeFd, d, m.cfg.uid, m.cfg.gid)
		if err != nil {
			return fmt.Errorf("folder %s: %w", d, err)
		}
		unix.Close(fd)
	}

	nmFd, err := openRoot(m.cfg.nmRoot)
	if err != nil {
		return err
	}
	defer unix.Close(nmFd)
	dirFd, err := openBeneath(nmFd, r.Dir, unix.O_PATH|unix.O_DIRECTORY)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)
	var workspace, tree []wire.Bind
	for n, mnt := range r.Mounts {
		root, ok := m.cfg.tiers[mnt.Tier]
		if !ok {
			return fmt.Errorf("no storage tier %q", mnt.Tier)
		}
		rootFd, err := openRoot(root)
		if err != nil {
			return err
		}
		srcFd, err := openBeneath(rootFd, mnt.Path, unix.O_PATH)
		unix.Close(rootFd)
		if err != nil {
			return err
		}
		err = bindInto(srcFd, mnt.ReadOnly, dirFd, strconv.Itoa(n))
		unix.Close(srcFd)
		if err != nil {
			return fmt.Errorf("mount %s %s: %w", mnt.Tier, mnt.Path, err)
		}
		if mnt.Workspace != "" {
			workspace = append(workspace, wire.Bind{N: n, Target: mnt.Workspace, ReadOnly: mnt.ReadOnly})
		}
		if mnt.Tree != "" {
			tree = append(tree, wire.Bind{N: n, Target: mnt.Tree, ReadOnly: mnt.ReadOnly})
		}
	}
	// The tree container runs sandbox-bind from here to make its binds.
	helperFd, err := unix.Open(m.cfg.helper, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	err = bindInto(helperFd, true, dirFd, wire.Helper)
	unix.Close(helperFd)
	if err != nil {
		return fmt.Errorf("mount the tree container's program: %w", err)
	}
	list, _ := json.Marshal(wire.List{Life: r.Life, Tree: tree})
	if err := writeFileAt(dirFd, wire.ListFile, list); err != nil {
		return err
	}
	phases.mark("mounts", &at)
	counts := map[string]int{}
	for _, f := range r.Folders {
		workspace = append(workspace, wire.Bind{N: counts[f.From], From: f.From, Target: f.Target})
		counts[f.From]++
	}
	inside, err := m.enter(ctx, container, wire.Request{Binds: workspace, Roots: r.Roots, UID: m.cfg.uid, GID: m.cfg.gid})
	if err != nil {
		return err
	}
	enter := "enter"
	if inside != "" {
		enter = fmt.Sprintf("enter (inside %s, %d binds)", inside, len(workspace))
	}
	phases.mark(enter, &at)
	m.mu.Lock()
	m.done[r.Dir] = r.Token
	m.mu.Unlock()
	return nil
}

// writeFileAt writes name inside dirFd whole, through a temporary name, so
// a reader sees it complete or not at all.
func writeFileAt(dirFd int, name string, data []byte) error {
	tmp := "." + name + ".tmp"
	fd, err := unix.Openat(dirFd, tmp, unix.O_CREAT|unix.O_TRUNC|unix.O_WRONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o644)
	if err != nil {
		return err
	}
	_, err = unix.Write(fd, data)
	unix.Close(fd)
	if err != nil {
		return err
	}
	return unix.Renameat(dirFd, tmp, dirFd, name)
}

// runscRoot finds the runsc state directory holding container id: kind and
// a k3s on the host's containerd keep it under containerd's, k3s's own
// containerd under k3s's.
func (m *mounter) runscRoot(id string) (string, error) {
	for _, root := range []string{"containerd/runsc/k8s.io", "k3s/containerd/runsc/k8s.io"} {
		dir := filepath.Join(m.cfg.hostRun, root)
		if found, _ := filepath.Glob(filepath.Join(dir, id+"_sandbox:*.state")); len(found) > 0 {
			return dir, nil
		}
	}
	return "", fmt.Errorf("no runsc state for container %s under %s", id, m.cfg.hostRun)
}

// enterTimeout bounds one entry into a sandbox, so a program that hangs
// holds only its own pod's lock.
const enterTimeout = 30 * time.Second

// enter runs `sandbox-bind binds` inside the workspace container:
// handed in by descriptor, so nothing is read from the image, with an
// exact process spec (environment, user, capabilities), and its request as
// data. What comes back is the project's report and nothing more: capped,
// and only ever quoted. On success it answers how long the program's own
// work took, as it reported it, or "" when it reported none.
func (m *mounter) enter(ctx context.Context, container string, req wire.Request) (string, error) {
	if len(req.Binds) == 0 {
		return "", nil
	}
	root, err := m.runscRoot(container)
	if err != nil {
		return "", err
	}
	arg, _ := json.Marshal(req)
	caps := []string{"CAP_SYS_ADMIN", "CAP_DAC_OVERRIDE", "CAP_CHOWN"}
	spec, _ := json.Marshal(map[string]any{
		"user":            map[string]int{"uid": 0, "gid": 0},
		"args":            []string{"sandbox-bind", "binds", string(arg)},
		"env":             []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"},
		"cwd":             "/",
		"noNewPrivileges": true,
		"capabilities":    map[string][]string{"bounding": caps, "effective": caps, "permitted": caps},
	})
	specFile, err := os.CreateTemp("", "process-*.json")
	if err != nil {
		return "", err
	}
	defer os.Remove(specFile.Name())
	if _, err := specFile.Write(spec); err != nil {
		specFile.Close()
		return "", err
	}
	specFile.Close()
	helper, err := os.Open(m.cfg.helper)
	if err != nil {
		return "", err
	}
	defer helper.Close()
	ctx, cancel := context.WithTimeout(ctx, enterTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, m.cfg.runsc, "--root", root, "exec", "--process", specFile.Name(), "--exec-fd", "3", container)
	cmd.ExtraFiles = []*os.File{helper}
	out := &cappedBuffer{max: 16 * 1024}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("binding in the workspace container: %w: %q", err, out.String())
	}
	// Only a duration is taken from the report, never its text.
	if took, ok := strings.CutPrefix(strings.TrimSpace(out.String()), "took "); ok {
		if d, err := time.ParseDuration(took); err == nil {
			return d.String(), nil
		}
	}
	return "", nil
}

type cappedBuffer struct {
	bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// releaseGone releases every node-mounts directory no pod on this node
// mounts, by a fresh list of them; when the list fails, nothing.
func (m *mounter) releaseGone(ctx context.Context) {
	pods, err := m.pods.list(ctx)
	if err != nil {
		log.Printf("release: listing the node's pods: %v", err)
		return
	}
	live := map[string]bool{}
	for i := range pods {
		if dir, ok := hostPathUnder(&pods[i], m.cfg.nmRootNode); ok {
			live[dir] = true
		}
	}
	entries, err := os.ReadDir(m.cfg.nmRoot)
	if err != nil {
		log.Printf("release: %v", err)
		return
	}
	for _, e := range entries {
		dir := e.Name()
		if live[dir] || !e.IsDir() {
			continue
		}
		unlock := m.lock(dir)
		err := releaseDir("/proc/self/mountinfo", m.cfg.nmRoot, dir)
		m.mu.Lock()
		if err != nil {
			m.stuck[dir] = err.Error()
			log.Printf("release %s: %v", dir, err)
		} else {
			delete(m.stuck, dir)
			delete(m.done, dir)
		}
		m.mu.Unlock()
		unlock()
	}
}

func (m *mounter) releaseLoop(ctx context.Context) {
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-m.pods.changed:
		case <-time.After(30 * time.Second):
		}
		m.releaseGone(ctx)
	}
}

type report struct {
	Build      string         `json:"build"`
	Arborist   bool           `json:"arborist"`
	FreeBytes  uint64         `json:"freeBytes"`
	TotalBytes uint64         `json:"totalBytes"`
	Trees      []wire.TreeKey `json:"trees"`
	Stuck      []string       `json:"stuck,omitempty"`
}

func (m *mounter) report(ctx context.Context) report {
	r := report{Build: m.cfg.build, Trees: []wire.TreeKey{}}
	var fs unix.Statfs_t
	if unix.Statfs(m.cfg.nodeLocal, &fs) == nil {
		r.FreeBytes = fs.Bavail * uint64(fs.Bsize)
		r.TotalBytes = fs.Blocks * uint64(fs.Bsize)
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, m.cfg.arboristURL+"/ready", nil)
	if res, err := m.http.Do(req); err == nil {
		if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&r.Trees) == nil {
			r.Arborist = true
		}
		res.Body.Close()
	}
	m.mu.Lock()
	for dir := range m.stuck {
		r.Stuck = append(r.Stuck, dir)
	}
	m.mu.Unlock()
	return r
}

func (m *mounter) authorized(r *http.Request) bool {
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(m.cfg.token)) == 1
}

func (m *mounter) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /report", func(w http.ResponseWriter, r *http.Request) {
		wire.WriteJSON(w, m.report(r.Context()))
	})
	mux.HandleFunc("POST /bind", func(w http.ResponseWriter, r *http.Request) {
		var req bindRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil {
			wire.Error(w, http.StatusBadRequest, err)
			return
		}
		started := time.Now()
		var phases bindPhases
		if err := m.bind(r.Context(), &req, &phases); err != nil {
			log.Printf("bind %s: %v", req.Pod, err)
			wire.Error(w, http.StatusUnprocessableEntity, err)
			return
		}
		log.Printf("bound %s in %s (%s)", req.Pod, time.Since(started).Round(time.Millisecond), strings.Join(phases, ", "))
		wire.WriteJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("PUT /ready", func(w http.ResponseWriter, r *http.Request) {
		// Passed to the arborist, which only this container can reach.
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodPut, m.cfg.arboristURL+"/ready", io.LimitReader(r.Body, 1<<20))
		res, err := m.http.Do(req)
		if err != nil {
			wire.Error(w, http.StatusBadGateway, err)
			return
		}
		res.Body.Close()
		w.WriteHeader(res.StatusCode)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.authorized(r) {
			wire.Error(w, http.StatusUnauthorized, errors.New("no valid token"))
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func serve(cfg config) error {
	pods, err := newNodePods(cfg.namespace, cfg.node)
	if err != nil {
		return err
	}
	m := &mounter{
		cfg:   cfg,
		pods:  pods,
		locks: map[string]*sync.Mutex{},
		done:  map[string]string{},
		stuck: map[string]string{},
		http:  &http.Client{Timeout: 10 * time.Minute},
	}
	ctx := context.Background()
	if err := m.pods.watch(ctx); err != nil {
		return err
	}
	go m.releaseLoop(ctx)
	log.Printf("mountd %s on %s: listening on %s", cfg.build, cfg.node, cfg.listen)
	return (&http.Server{Addr: cfg.listen, Handler: m.handler(), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe()
}
