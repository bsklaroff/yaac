// Package sockets keeps one directory of unix sockets per sandbox under a
// root directory (docs/workspace-egress.md "The relay, and the rest of netd"). For each unit
// it is told about, it binds `egress.sock`, through which the sandbox's
// every outbound connection arrives, and it opens the sandbox's own
// `ingress.sock` on request. A connection's identity is the directory it
// arrived in, which nothing inside a sandbox can reach but its own.
//
// It knows nothing of yaac or Kubernetes: the caller says which units
// exist, by directory name and id, and gets each connection with the id of
// its unit.
package sockets

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// Socket names inside a unit's directory.
const (
	EgressName  = "egress.sock"
	IngressName = "ingress.sock"
)

// Unit is one sandbox: the name of its directory directly under the root,
// and the id its connections are handed over with.
type Unit struct {
	Dir, ID string
}

// Options tunes a Server. A zero DirMode takes the default: only the owner
// (the relay, as root) may open a unit's directory, which is what gates who
// can connect to its sockets. The socket itself is never chmodded: code in
// the sandbox owns the directory and could rename a link over the socket
// between the bind and a chmod by path, steering the chmod anywhere the
// relay can name, the socket root included.
type Options struct {
	DirMode fs.FileMode
	Logf    func(format string, args ...any)
}

// Server binds the egress sockets of the units under one root.
type Server struct {
	root   string
	handle func(id string, c net.Conn)
	opts   Options

	mu    sync.Mutex
	bound map[string]*binding
}

type binding struct {
	id  string
	ln  *net.UnixListener
	ino uint64
}

// New makes a Server for root, which hands every egress connection to
// handle with its unit's id. handle owns the connection.
func New(root string, handle func(id string, c net.Conn), opts Options) *Server {
	if opts.DirMode == 0 {
		opts.DirMode = 0o700
	}
	if opts.Logf == nil {
		opts.Logf = log.Printf
	}
	return &Server{root: root, handle: handle, opts: opts, bound: map[string]*binding{}}
}

// validDir says whether name is one path component.
func validDir(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsRune(name, '/') && !strings.ContainsRune(name, 0)
}

// Reconcile brings the bound sockets in line with the units list returns.
// It reads the root's directories before calling list, so a directory it
// saw belongs to a pod that list already holds if that pod still exists,
// and only then removes the directories no unit names. A failed read or
// list changes nothing. Bound sockets whose path no longer holds what was
// bound are bound again, so the caller repairs a deleted socket by calling
// Reconcile periodically. The error is the first bind or removal that
// failed; the rest of the pass still runs.
func (s *Server) Reconcile(list func() ([]Unit, error)) error {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	units, err := list()
	if err != nil {
		return err
	}
	want := map[string]string{}
	for _, u := range units {
		if validDir(u.Dir) {
			want[u.Dir] = u.ID
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	var first error
	note := func(err error) {
		if err != nil {
			s.opts.Logf("sockets: %v", err)
			if first == nil {
				first = err
			}
		}
	}
	for dir, b := range s.bound {
		if id, ok := want[dir]; !ok || id != b.id {
			b.ln.Close()
			delete(s.bound, dir)
		}
	}
	for dir, id := range want {
		if b, ok := s.bound[dir]; ok && s.intact(dir, b) {
			continue
		} else if ok {
			b.ln.Close()
			delete(s.bound, dir)
		}
		b, err := s.bind(dir, id)
		note(err)
		if err == nil {
			s.bound[dir] = b
		}
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, ok := want[e.Name()]; !ok {
			note(s.remove(e.Name()))
		}
	}
	return first
}

// intact says whether a unit's egress path still holds the socket bound.
func (s *Server) intact(dir string, b *binding) bool {
	var st unix.Stat_t
	if err := unix.Lstat(filepath.Join(s.root, dir, EgressName), &st); err != nil {
		return false
	}
	return st.Mode&unix.S_IFMT == unix.S_IFSOCK && st.Ino == b.ino
}

// bind makes a unit's directory if kubelet has not yet, tightens its mode
// through a descriptor opened with no link followed, and binds its egress
// socket over whatever was at the path.
func (s *Server) bind(dir, id string) (*binding, error) {
	d := filepath.Join(s.root, dir)
	if err := os.Mkdir(d, s.opts.DirMode); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, fmt.Errorf("unit %s: %w", dir, err)
	}
	dfd, err := unix.Open(d, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("unit %s: %w", dir, err)
	}
	err = unix.Fchmod(dfd, uint32(s.opts.DirMode.Perm()))
	unix.Close(dfd)
	if err != nil {
		return nil, fmt.Errorf("unit %s: %w", dir, err)
	}
	p := filepath.Join(d, EgressName)
	if err := unix.Unlink(p); err != nil && !errors.Is(err, unix.ENOENT) {
		return nil, fmt.Errorf("unit %s: clearing %s: %w", dir, EgressName, err)
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("unit %s: %w", dir, err)
	}
	// Closing must never unlink by path: a rebind closes a listener whose
	// path may by then hold something else.
	ln.SetUnlinkOnClose(false)
	// Whatever is at the path now, read without following a link: a link
	// renamed over the socket is no binding, and the next pass rebinds.
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFSOCK {
		ln.Close()
		return nil, fmt.Errorf("unit %s: %s is not the socket just bound (%v)", dir, EgressName, err)
	}
	b := &binding{id: id, ln: ln, ino: st.Ino}
	go s.serve(b)
	return b, nil
}

func (s *Server) serve(b *binding) {
	for {
		c, err := b.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.opts.Logf("sockets: accept for %s: %v", b.id, err)
			continue
		}
		go s.handle(b.id, c)
	}
}

// remove deletes a directory no unit names: each entry but a directory is
// unlinked without following a link, and the directory goes once empty. A
// subdirectory is left, with the directory around it, and reported.
func (s *Server) remove(dir string) error {
	rootFd, err := unix.Open(s.root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(rootFd)
	fd, err := unix.Openat(rootFd, dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("removing %s: %w", dir, err)
	}
	f := os.NewFile(uintptr(fd), dir)
	defer f.Close()
	entries, err := f.ReadDir(-1)
	if err != nil {
		return fmt.Errorf("removing %s: %w", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() {
			return fmt.Errorf("removing %s: it holds a directory, %s; left in place", dir, e.Name())
		}
		if err := unix.Unlinkat(fd, e.Name(), 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("removing %s/%s: %w", dir, e.Name(), err)
		}
	}
	if err := unix.Unlinkat(rootFd, dir, unix.AT_REMOVEDIR); err != nil && !errors.Is(err, unix.ENOENT) {
		return fmt.Errorf("removing %s: %w", dir, err)
	}
	return nil
}

// DialIngress connects to a unit's ingress socket. The directory and the
// socket are each opened without following a link, and the socket must be
// one, before the connect goes through the descriptor: a connect by path
// would follow a link planted at it to any socket this process can see.
// A hard link passes these checks, and is ruled out by what a sandbox can
// see: link() across mounts fails, and netshim sees only its own directory,
// so the only socket it could link there is its own.
func (s *Server) DialIngress(dir string) (net.Conn, error) {
	if !validDir(dir) {
		return nil, fmt.Errorf("bad unit directory %q", dir)
	}
	rootFd, err := unix.Open(s.root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(rootFd)
	dirFd, err := unix.Openat(rootFd, dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", dir, err)
	}
	defer unix.Close(dirFd)
	fd, err := unix.Openat(dirFd, IngressName, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("opening %s/%s: %w", dir, IngressName, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFSOCK {
		return nil, fmt.Errorf("%s/%s is not a socket (mode %o)", dir, IngressName, st.Mode&unix.S_IFMT)
	}
	return net.Dial("unix", "/proc/self/fd/"+strconv.Itoa(fd))
}

// Close stops every listener. The sockets stay on disk for the next
// process to bind over.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for dir, b := range s.bound {
		b.ln.Close()
		delete(s.bound, dir)
	}
}

// Splice copies both ways until each side has finished, passing on a
// half-close, then closes both. An error on either side closes both at
// once.
func Splice(a, b net.Conn) {
	var wg sync.WaitGroup
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		_, err := io.Copy(dst, src)
		if err != nil {
			a.Close()
			b.Close()
			return
		}
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
	}
	wg.Add(2)
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}
