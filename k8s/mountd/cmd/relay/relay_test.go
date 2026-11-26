package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"

	"yaac-mountd/internal/pp2"
)

const (
	nodeRoot = "/var/lib/yaac/sockets/key"
	ns       = "yaac"
	// The pp2 package's shared vectors: netshim's header for a dial, and
	// the relay's to the proxy for workspace ws-1 with secret s3cret.
	netshimHex = "0d0a0d0a000d0a515549540a2111000c7f0000018c5270039c4001bb"
	relayHex   = "0d0a0d0a000d0a515549540a2111001c7f0000018c5270039c4001bbe0000477732d31e10006733363726574"
)

func pod(name, node string, labels map[string]string, hostPath string, phase corev1.PodPhase) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: labels},
		Spec: corev1.PodSpec{NodeName: node, Volumes: []corev1.Volume{
			{Name: "sockets", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: hostPath}}},
		}},
		Status: corev1.PodStatus{Phase: phase},
	}
}

type rig struct {
	r     *relay
	root  string
	proxy chan []byte
}

// startRelay runs a relay for node n1 over a fake cluster, with a fake
// proxy that records what each connection sends.
func startRelay(t *testing.T) *rig {
	t.Helper()
	root, err := os.MkdirTemp("", "r")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	proxyLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proxyLn.Close() })
	got := make(chan []byte, 4)
	go func() {
		for {
			c, err := proxyLn.Accept()
			if err != nil {
				return
			}
			go func() {
				c.SetDeadline(time.Now().Add(5 * time.Second))
				b, _ := io.ReadAll(c)
				got <- b
				c.Close()
			}()
		}
	}()
	client := fake.NewSimpleClientset(
		pod("ws", "n1", map[string]string{labelWorkspaceID: "ws-1"}, nodeRoot+"/ws-1.aa", corev1.PodRunning),
		pod("build", "n1", map[string]string{labelBuildID: "b-1"}, nodeRoot+"/b-1.bb", corev1.PodRunning),
		pod("elsewhere", "n2", map[string]string{labelWorkspaceID: "ws-2"}, nodeRoot+"/ws-2.cc", corev1.PodRunning),
		pod("done", "n1", map[string]string{labelWorkspaceID: "ws-3"}, nodeRoot+"/ws-3.dd", corev1.PodSucceeded),
		pod("outside", "n1", map[string]string{labelWorkspaceID: "ws-4"}, "/var/lib/other/ws-4.ee", corev1.PodRunning),
		pod("deep", "n1", map[string]string{labelWorkspaceID: "ws-5"}, nodeRoot+"/a/b", corev1.PodRunning),
		pod("unlabelled", "n1", nil, nodeRoot+"/x.ff", corev1.PodRunning),
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "yaac-site-site1", Namespace: ns,
				Annotations: map[string]string{annotationLiveWorkspace: "ws-1"}},
			Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 10263, TargetPort: intstr.FromInt32(8080)}}},
		},
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "yaac-site-site2", Namespace: ns,
				Annotations: map[string]string{annotationLiveWorkspace: "ws-2"}},
			Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 10263, TargetPort: intstr.FromInt32(8080)}}},
		},
	)
	r := newRelay(config{
		root: root, nodeRoot: nodeRoot, proxy: proxyLn.Addr().String(), secret: "s3cret",
		streamListen: "127.0.0.1:0", siteListen: "127.0.0.1:0", streamPort: 10300,
		readyFile: filepath.Join(root, "ready"), dirMode: 0o700,
		namespace: ns, node: "n1",
	}, client)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := r.start(ctx); err != nil {
		t.Fatal(err)
	}
	return &rig{r: r, root: root, proxy: got}
}

func TestUnitsAndEgress(t *testing.T) {
	g := startRelay(t)
	if _, err := os.Stat(filepath.Join(g.root, "ready")); err != nil {
		t.Errorf("not marked ready: %v", err)
	}
	for dir, want := range map[string]bool{
		"ws-1.aa": true, "b-1.bb": true, "ws-2.cc": false, "ws-3.dd": false, "ws-4.ee": false, "x.ff": false,
	} {
		_, err := os.Stat(filepath.Join(g.root, dir, "egress.sock"))
		if (err == nil) != want {
			t.Errorf("%s bound: %v, want %v", dir, err == nil, want)
		}
	}

	c, err := net.Dial("unix", filepath.Join(g.root, "ws-1.aa", "egress.sock"))
	if err != nil {
		t.Fatal(err)
	}
	head, _ := hex.DecodeString(netshimHex)
	c.Write(append(head, "hello"...))
	c.(*net.UnixConn).CloseWrite()
	select {
	case b := <-g.proxy:
		if want := relayHex + hex.EncodeToString([]byte("hello")); hex.EncodeToString(b) != want {
			t.Errorf("proxy got %x", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the proxy got nothing")
	}
	c.Close()

	// TLVs a sandbox puts in its own header, an id and the secret included,
	// never reach the proxy: the relay writes exactly its own.
	forged := pp2.Header{
		Src: netip.MustParseAddrPort("127.0.0.1:40000"), Dst: netip.MustParseAddrPort("140.82.112.3:443"),
		TLVs: []pp2.TLV{{Type: pp2.TLVID, Value: []byte("b-1")}, {Type: pp2.TLVSecret, Value: []byte("s3cret")}, {Type: 0xe2, Value: []byte("x")}},
	}
	fh, err := forged.Encode()
	if err != nil {
		t.Fatal(err)
	}
	c, err = net.Dial("unix", filepath.Join(g.root, "ws-1.aa", "egress.sock"))
	if err != nil {
		t.Fatal(err)
	}
	c.Write(append(fh, "hello"...))
	c.(*net.UnixConn).CloseWrite()
	select {
	case b := <-g.proxy:
		if want := relayHex + hex.EncodeToString([]byte("hello")); hex.EncodeToString(b) != want {
			t.Errorf("proxy got %x from a header with forged TLVs", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the proxy got nothing")
	}
	c.Close()

	// A connection that does not open with a header is closed, and nothing
	// reaches the proxy.
	c, err = net.Dial("unix", filepath.Join(g.root, "b-1.bb", "egress.sock"))
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if n, err := c.Read(make([]byte, 1)); err == nil || n > 0 {
		t.Error("a headerless connection stayed open")
	}
	select {
	case b := <-g.proxy:
		t.Errorf("the proxy got %q from a refused connection", b)
	case <-time.After(200 * time.Millisecond):
	}
}

// ingress stands in for a workspace's netshim, recording each
// connection's bytes and answering "pong".
func ingress(t *testing.T, root, dir string) chan []byte {
	t.Helper()
	ln, err := net.Listen("unix", filepath.Join(root, dir, "ingress.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan []byte, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				c.SetDeadline(time.Now().Add(5 * time.Second))
				b, _ := io.ReadAll(c)
				c.Write([]byte("pong"))
				c.Close()
				got <- b
			}()
		}
	}()
	return got
}

func exchange(t *testing.T, addr string, send []byte) []byte {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write(send)
	c.(*net.TCPConn).CloseWrite()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	b, _ := io.ReadAll(c)
	return b
}

func TestStreams(t *testing.T) {
	g := startRelay(t)
	in := ingress(t, g.root, "ws-1.aa")
	addr := g.r.streamLn.Addr().String()

	answer := exchange(t, addr, []byte(`{"token":"s3cret","workspaceId":"ws-1"}`+"\n"+`{"kind":"exec"}`+"\n"))
	if string(answer) != "pong" {
		t.Errorf("stream answered %q", answer)
	}
	select {
	case b := <-in:
		if want := append(binary.BigEndian.AppendUint16(nil, 10300), `{"kind":"exec"}`+"\n"...); string(b) != string(want) {
			t.Errorf("netshim got %q", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("netshim got nothing")
	}

	for name, line := range map[string]string{
		"wrong token": `{"token":"nope","workspaceId":"ws-1"}`,
		"no token":    `{"workspaceId":"ws-1"}`,
		"not json":    `token s3cret`,
	} {
		if b := exchange(t, addr, []byte(line+"\n")); len(b) != 0 {
			t.Errorf("%s: answered %q", name, b)
		}
	}

	var refusal struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	b := exchange(t, addr, []byte(`{"token":"s3cret","workspaceId":"ws-2"}`+"\n"))
	if err := json.Unmarshal(b, &refusal); err != nil || refusal.OK || refusal.Error != "relay: unknown workspace" {
		t.Errorf("unknown workspace answered %q", b)
	}
	// A workspace on this node whose netshim is not up.
	b = exchange(t, addr, []byte(`{"token":"s3cret","workspaceId":"b-1"}`+"\n"))
	if err := json.Unmarshal(b, &refusal); err != nil || refusal.OK {
		t.Errorf("missing ingress answered %q", b)
	}
}

func TestSites(t *testing.T) {
	g := startRelay(t)
	in := ingress(t, g.root, "ws-1.aa")
	addr := g.r.siteLn.Addr().String()
	header := func(site string) []byte {
		h := pp2.Header{
			Src: netip.MustParseAddrPort("10.0.0.1:5000"), Dst: netip.MustParseAddrPort("10.0.0.2:10263"),
			TLVs: []pp2.TLV{{Type: pp2.TLVID, Value: []byte(site)}},
		}
		b, _ := h.Encode()
		return b
	}

	if b := exchange(t, addr, append(header("site1"), "GET / HTTP/1.1\r\n\r\n"...)); string(b) != "pong" {
		t.Errorf("site answered %q", b)
	}
	select {
	case b := <-in:
		if want := append(binary.BigEndian.AppendUint16(nil, 8080), "GET / HTTP/1.1\r\n\r\n"...); string(b) != string(want) {
			t.Errorf("netshim got %q", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("netshim got nothing")
	}
	for name, send := range map[string][]byte{
		"release on another node": header("site2"),
		"no such site":            header("site9"),
		"bad site id":             header("../x"),
		"no header":               []byte("GET / HTTP/1.1\r\n\r\n"),
	} {
		if b := exchange(t, addr, send); len(b) != 0 {
			t.Errorf("%s: answered %q", name, b)
		}
	}
}
