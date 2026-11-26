package main

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"yaac-mountd/internal/pp2"
)

func TestSetupCommands(t *testing.T) {
	got := setupCommands("10.244.0.7", 10301, 10302)
	want := []string{
		"ip route replace 0.0.0.0/0 dev lo",
		"ip -6 addr replace fe80::1/64 dev lo",
		"ip addr replace 10.244.0.7/32 dev lo",
		"iptables-legacy -t nat -F OUTPUT",
		"iptables-legacy -t nat -A OUTPUT -d 10.244.0.7/32 -j RETURN",
		"iptables-legacy -t nat -A OUTPUT -p tcp ! -d 127.0.0.0/8 -j REDIRECT --to-ports 10301",
		"iptables-legacy -t nat -A OUTPUT -p udp ! -d 127.0.0.0/8 --dport 53 -j REDIRECT --to-ports 10302",
	}
	var lines []string
	for _, c := range got {
		lines = append(lines, strings.Join(c, " "))
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("commands:\n%s", strings.Join(lines, "\n"))
	}
	if n := len(setupCommands("", 1, 2)); n != 5 {
		t.Errorf("without a pod address: %d commands", n)
	}

	var ran [][]string
	err := setup(func(argv []string) error {
		ran = append(ran, argv)
		if argv[0] == "iptables-legacy" {
			return errors.New("Table does not exist")
		}
		return nil
	}, got)
	if err == nil || len(ran) != 4 {
		t.Errorf("setup went on past a failure: %v, ran %d", err, len(ran))
	}
}

// start runs a shim on loopback with a scratch ingress socket, the egress
// socket at egress, and every connection's original destination dst.
func start(t *testing.T, egress string, dst netip.AddrPort) *listeners {
	t.Helper()
	dir, err := os.MkdirTemp("", "n")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	s := &shim{
		cfg: config{
			tcpListen: "127.0.0.1:0", dnsListen: "127.0.0.1:0",
			egress: egress, ingress: filepath.Join(dir, "ingress.sock"),
			sinkhole: netip.MustParseAddr("198.18.0.1"),
		},
		origDst: func(*net.TCPConn) (netip.AddrPort, error) { return dst, nil },
	}
	l, err := s.listen()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.tcp.Close(); l.dns.Close(); l.ingress.Close() })
	go s.serve(l)
	return l
}

func TestEgress(t *testing.T) {
	dir, _ := os.MkdirTemp("", "e")
	defer os.RemoveAll(dir)
	egress := filepath.Join(dir, "egress.sock")
	relay, err := net.Listen("unix", egress)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	type seen struct {
		h    *pp2.Header
		body string
	}
	got := make(chan seen, 1)
	go func() {
		c, err := relay.Accept()
		if err != nil {
			return
		}
		h, err := pp2.Read(c)
		if err != nil {
			got <- seen{}
			return
		}
		b := make([]byte, 5)
		io.ReadFull(c, b)
		c.Write([]byte("pong"))
		c.Close()
		got <- seen{h, string(b)}
	}()
	dst := netip.MustParseAddrPort("140.82.112.3:443")
	l := start(t, egress, dst)

	c, err := net.Dial("tcp4", l.tcp.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte("hello"))
	c.SetDeadline(time.Now().Add(5 * time.Second))
	answer, _ := io.ReadAll(c)
	s := <-got
	if s.h == nil {
		t.Fatal("the relay got no header")
	}
	local := c.LocalAddr().(*net.TCPAddr).AddrPort()
	if s.h.Dst != dst || s.h.Src.Addr() != netip.MustParseAddr("127.0.0.1") || s.h.Src.Port() != local.Port() || len(s.h.TLVs) != 0 {
		t.Errorf("header %+v", s.h)
	}
	// The bytes on the wire for a fixed source match the shared vector.
	enc, _ := (&pp2.Header{Src: netip.MustParseAddrPort("127.0.0.1:40000"), Dst: dst}).Encode()
	if hex.EncodeToString(enc) != "0d0a0d0a000d0a515549540a2111000c7f0000018c5270039c4001bb" {
		t.Errorf("header bytes %x", enc)
	}
	if s.body != "hello" || string(answer) != "pong" {
		t.Errorf("spliced %q, answered %q", s.body, answer)
	}

	// With no relay listening, the client's connection is closed.
	relay.Close()
	os.Remove(egress)
	c2, err := net.Dial("tcp4", l.tcp.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c2.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c2.Read(make([]byte, 1)); err == nil {
		t.Error("a connection with no relay stayed open")
	}
}

func query(id uint16, flags uint16, qd uint16, name string, qtype uint16) []byte {
	b := binary.BigEndian.AppendUint16(nil, id)
	b = binary.BigEndian.AppendUint16(b, flags)
	b = binary.BigEndian.AppendUint16(b, qd)
	b = append(b, 0, 0, 0, 0, 0, 0)
	for _, l := range strings.Split(name, ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	b = append(b, 0)
	b = binary.BigEndian.AppendUint16(b, qtype)
	return binary.BigEndian.AppendUint16(b, 1)
}

func TestDNS(t *testing.T) {
	l := start(t, "/nonexistent", netip.AddrPort{})
	c, err := net.Dial("udp4", l.dns.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ask := func(q []byte) []byte {
		c.Write(q)
		c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		b := make([]byte, 512)
		n, err := c.Read(b)
		if err != nil {
			return nil
		}
		return b[:n]
	}

	a := query(0x1234, 0x0100, 1, "github.com", 1)
	r := ask(a)
	if r == nil {
		t.Fatal("no answer to A")
	}
	if binary.BigEndian.Uint16(r[0:2]) != 0x1234 || r[2] != 0x81 || r[3] != 0x80 || binary.BigEndian.Uint16(r[6:8]) != 1 {
		t.Errorf("A header %x", r[:12])
	}
	if string(r[12:len(a)]) != string(a[12:]) {
		t.Error("question not echoed")
	}
	rr := r[len(a):]
	if len(rr) != 16 || binary.BigEndian.Uint32(rr[6:10]) != 5 || net.IP(rr[12:16]).String() != "198.18.0.1" {
		t.Errorf("A record %x", rr)
	}

	r = ask(query(7, 0x0100, 1, "github.com", 28))
	if r == nil || binary.BigEndian.Uint16(r[6:8]) != 0 || r[3]&0x0f != 0 {
		t.Errorf("AAAA answer %x", r)
	}
	for name, q := range map[string][]byte{
		"response":    query(8, 0x8100, 1, "x.y", 1),
		"two queries": query(9, 0x0100, 2, "x.y", 1),
		"truncated":   query(10, 0x0100, 1, "x.y", 1)[:15],
	} {
		if r := ask(q); r != nil {
			t.Errorf("%s answered: %x", name, r)
		}
	}
}

func TestIngress(t *testing.T) {
	app, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	go func() {
		c, err := app.Accept()
		if err != nil {
			return
		}
		b, _ := io.ReadAll(c)
		c.Write(append([]byte("app:"), b...))
		c.Close()
	}()
	l := start(t, "/nonexistent", netip.AddrPort{})
	fi, err := os.Stat(l.ingress.Addr().String())
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("ingress socket: %v %v", fi, err)
	}
	c, err := net.Dial("unix", l.ingress.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	port := uint16(app.Addr().(*net.TCPAddr).Port)
	c.Write(binary.BigEndian.AppendUint16(nil, port))
	c.Write([]byte("stream"))
	c.(*net.UnixConn).CloseWrite()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	b, _ := io.ReadAll(c)
	if string(b) != "app:stream" {
		t.Errorf("ingress answered %q", b)
	}
}
