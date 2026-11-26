package sockets

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// shortRoot is a scratch root with a short path: a unix socket's path is
// capped at 107 bytes.
func shortRoot(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "s")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// echoID answers each connection with its unit's id.
func echoID(id string, c net.Conn) {
	c.Write([]byte(id))
	c.Close()
}

func units(us ...Unit) func() ([]Unit, error) {
	return func() ([]Unit, error) { return us, nil }
}

func dialID(t *testing.T, path string) string {
	t.Helper()
	c, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	b, err := io.ReadAll(c)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestBindAndRebind(t *testing.T) {
	root := shortRoot(t)
	s := New(root, echoID, Options{Logf: t.Logf})
	defer s.Close()
	// A unit whose directory kubelet made, with a stale file at the path.
	os.Mkdir(filepath.Join(root, "a"), 0o755)
	os.WriteFile(filepath.Join(root, "a", EgressName), nil, 0o644)
	if err := s.Reconcile(units(Unit{"a", "id-a"}, Unit{"b", "id-b"})); err != nil {
		t.Fatal(err)
	}
	for dir, id := range map[string]string{"a": "id-a", "b": "id-b"} {
		p := filepath.Join(root, dir, EgressName)
		if got := dialID(t, p); got != id {
			t.Errorf("%s answered %q", dir, got)
		}
		di, _ := os.Stat(filepath.Join(root, dir))
		if di.Mode().Perm() != 0o700 {
			t.Errorf("%s dir mode %o", dir, di.Mode().Perm())
		}
	}

	// A deleted socket comes back at the next pass.
	os.Remove(filepath.Join(root, "a", EgressName))
	if err := s.Reconcile(units(Unit{"a", "id-a"}, Unit{"b", "id-b"})); err != nil {
		t.Fatal(err)
	}
	if got := dialID(t, filepath.Join(root, "a", EgressName)); got != "id-a" {
		t.Errorf("after rebind a answered %q", got)
	}
	// One replaced by another socket is bound over too.
	p := filepath.Join(root, "b", EgressName)
	os.Remove(p)
	other, err := net.Listen("unix", p)
	if err != nil {
		t.Fatal(err)
	}
	other.(*net.UnixListener).SetUnlinkOnClose(false)
	defer other.Close()
	if err := s.Reconcile(units(Unit{"a", "id-a"}, Unit{"b", "id-b"})); err != nil {
		t.Fatal(err)
	}
	if got := dialID(t, p); got != "id-b" {
		t.Errorf("after replacement b answered %q", got)
	}
}

func TestRemovesGoneUnits(t *testing.T) {
	root := shortRoot(t)
	s := New(root, echoID, Options{Logf: t.Logf})
	defer s.Close()
	if err := s.Reconcile(units(Unit{"a", "id-a"}, Unit{"b", "id-b"})); err != nil {
		t.Fatal(err)
	}
	// netshim's socket beside the relay's, and a directory nothing should
	// hold.
	os.WriteFile(filepath.Join(root, "a", IngressName), nil, 0o600)
	os.MkdirAll(filepath.Join(root, "b", "sub"), 0o700)

	// A failed list changes nothing.
	if err := s.Reconcile(func() ([]Unit, error) { return nil, errors.New("no list") }); err == nil {
		t.Error("a failed list passed")
	}
	if _, err := os.Stat(filepath.Join(root, "a")); err != nil {
		t.Errorf("a failed list removed a: %v", err)
	}

	if err := s.Reconcile(units()); err == nil {
		t.Error("a directory holding a directory was not reported")
	}
	if _, err := os.Stat(filepath.Join(root, "a")); !os.IsNotExist(err) {
		t.Errorf("a gone unit's directory stayed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "b", "sub")); err != nil {
		t.Errorf("a subdirectory was not left: %v", err)
	}
	if _, err := net.Dial("unix", filepath.Join(root, "b", EgressName)); err == nil {
		t.Error("a gone unit still answers")
	}
}

func TestDialIngress(t *testing.T) {
	root := shortRoot(t)
	s := New(root, echoID, Options{Logf: t.Logf})
	// The real socket, and others a link could point at.
	real, decoy := filepath.Join(root, "a"), filepath.Join(root, "decoy")
	os.Mkdir(real, 0o700)
	os.Mkdir(decoy, 0o700)
	serve := func(p, answer string) net.Listener {
		ln, err := net.Listen("unix", p)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Write([]byte(answer))
				c.Close()
			}
		}()
		t.Cleanup(func() { ln.Close() })
		return ln
	}
	serve(filepath.Join(real, IngressName), "real")
	serve(filepath.Join(decoy, "other.sock"), "decoy")

	c, err := s.DialIngress("a")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(c)
	c.Close()
	if string(b) != "real" {
		t.Errorf("real socket answered %q", b)
	}

	for name, plant := range map[string]func(p string){
		"link":      func(p string) { os.Symlink(filepath.Join(decoy, "other.sock"), p) },
		"file":      func(p string) { os.WriteFile(p, nil, 0o600) },
		"directory": func(p string) { os.Mkdir(p, 0o700) },
	} {
		d := filepath.Join(root, name)
		os.Mkdir(d, 0o700)
		plant(filepath.Join(d, IngressName))
		if c, err := s.DialIngress(name); err == nil {
			c.Close()
			t.Errorf("%s at ingress.sock was connected to", name)
		}
	}
	// A linked unit directory is refused too.
	os.Symlink(real, filepath.Join(root, "linked"))
	if c, err := s.DialIngress("linked"); err == nil {
		c.Close()
		t.Error("a linked directory was followed")
	}
	for _, bad := range []string{"", ".", "..", "a/b"} {
		if _, err := s.DialIngress(bad); err == nil {
			t.Errorf("%q passed", bad)
		}
	}
}

func TestSplice(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		// Echo until the client half-closes, then answer and close.
		b, _ := io.ReadAll(c)
		c.Write(append([]byte("got:"), b...))
		c.Close()
	}()
	up, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	// The client's leg is TCP too, so its half-close is carried.
	cl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	go func() {
		c, err := cl.Accept()
		if err != nil {
			return
		}
		Splice(c, up)
	}()
	client, err := net.Dial("tcp", cl.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	client.Write([]byte("hi"))
	client.(*net.TCPConn).CloseWrite()
	client.SetDeadline(time.Now().Add(2 * time.Second))
	b, err := io.ReadAll(client)
	if err != nil || string(b) != "got:hi" {
		t.Errorf("spliced answer %q, %v", b, err)
	}
}

// TestBindNeverFollowsALink races code in the sandbox, which owns its
// directory, renaming a link to the socket root over egress.sock while
// units are bound. Nothing the relay does may change what the link names.
func TestBindNeverFollowsALink(t *testing.T) {
	root := shortRoot(t)
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	s := New(root, echoID, Options{Logf: func(string, ...any) {}})
	defer s.Close()
	os.Mkdir(filepath.Join(root, "u"), 0o700)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		tmp := filepath.Join(root, "u", "t")
		for {
			select {
			case <-stop:
				return
			default:
			}
			os.Symlink("..", tmp)
			os.Rename(tmp, filepath.Join(root, "u", EgressName))
		}
	}()
	for i := 0; i < 200; i++ {
		s.Reconcile(units(Unit{"u", "id-u"}, Unit{"v", "id-v"}))
		os.Remove(filepath.Join(root, "u", EgressName))
	}
	close(stop)
	<-done
	fi, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("the socket root's mode became %o", fi.Mode().Perm())
	}
	if err := s.Reconcile(units(Unit{"u", "id-u"}, Unit{"v", "id-v"})); err != nil {
		t.Fatal(err)
	}
	if got := dialID(t, filepath.Join(root, "v", EgressName)); got != "id-v" {
		t.Fatalf("v answered %q", got)
	}
}
