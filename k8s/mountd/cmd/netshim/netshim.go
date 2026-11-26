package main

// What netshim does with a connection. Every TCP dial the sandbox makes to
// an address off loopback is redirected to the TCP listener, which reads
// the address dialed and carries the connection to the relay through
// egress.sock behind a PROXY protocol v2 header naming it. Every DNS query
// is redirected to the stub, which answers with the sinkhole, so no name
// resolves to a real address. The relay reaches the sandbox through
// ingress.sock, naming the loopback port to connect to.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"yaac-mountd/internal/pp2"
	"yaac-mountd/internal/sockets"
)

type config struct {
	tcpListen string
	dnsListen string
	egress    string
	ingress   string
	sinkhole  netip.Addr
	podIP     string
}

type shim struct {
	cfg config
	// origDst reads the address a redirected connection was dialed to.
	origDst func(c *net.TCPConn) (netip.AddrPort, error)
}

// How long a peer may take before its connection is dropped, and the TTL
// of the stub's answers.
const (
	dialTimeout     = 5 * time.Second
	preambleTimeout = 10 * time.Second
	dnsTTL          = 5
)

// setupCommands are the commands that route every address to loopback and
// redirect TCP and DNS to the listeners. They write the sandbox's netstack,
// not this container, so they outlive a restart, and each is safe to
// repeat. The route is spelled 0.0.0.0/0 because netstack refuses
// `default`, and gVisor has no nftables, so iptables is the legacy backend.
// The pod's own address goes on loopback, and is left unredirected, so a
// program that binds or dials its own hostname works. So does a link-local
// IPv6 address: getaddrinfo's AI_ADDRCONFIG, which Node's net.connect
// passes, answers `localhost` with ::1 only while some IPv6 address other
// than ::1 is configured, and a server bound to ::1 (a dev server on
// `localhost`) would otherwise be unreachable by that name.
func setupCommands(podIP string, tcpPort, dnsPort int) [][]string {
	cmds := [][]string{
		{"ip", "route", "replace", "0.0.0.0/0", "dev", "lo"},
		{"ip", "-6", "addr", "replace", "fe80::1/64", "dev", "lo"},
	}
	if podIP != "" {
		cmds = append(cmds, []string{"ip", "addr", "replace", podIP + "/32", "dev", "lo"})
	}
	cmds = append(cmds, []string{"iptables-legacy", "-t", "nat", "-F", "OUTPUT"})
	if podIP != "" {
		cmds = append(cmds, []string{"iptables-legacy", "-t", "nat", "-A", "OUTPUT", "-d", podIP + "/32", "-j", "RETURN"})
	}
	return append(cmds,
		[]string{"iptables-legacy", "-t", "nat", "-A", "OUTPUT", "-p", "tcp", "!", "-d", "127.0.0.0/8",
			"-j", "REDIRECT", "--to-ports", strconv.Itoa(tcpPort)},
		[]string{"iptables-legacy", "-t", "nat", "-A", "OUTPUT", "-p", "udp", "!", "-d", "127.0.0.0/8",
			"--dport", "53", "-j", "REDIRECT", "--to-ports", strconv.Itoa(dnsPort)},
	)
}

// setup runs the commands, stopping at the first that fails.
func setup(run func(argv []string) error, cmds [][]string) error {
	for _, c := range cmds {
		if err := run(c); err != nil {
			return fmt.Errorf("%v: %w", c, err)
		}
	}
	return nil
}

func portOf(addr string) (int, error) {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(p)
}

// listeners holds what netshim serves on.
type listeners struct {
	tcp     net.Listener
	dns     net.PacketConn
	ingress net.Listener
}

// listen binds the two loopback listeners, then the ingress socket, whose
// presence is what the pod's startup probe waits for.
func (s *shim) listen() (*listeners, error) {
	tcp, err := net.Listen("tcp4", s.cfg.tcpListen)
	if err != nil {
		return nil, err
	}
	dns, err := net.ListenPacket("udp4", s.cfg.dnsListen)
	if err != nil {
		tcp.Close()
		return nil, err
	}
	if err := os.Remove(s.cfg.ingress); err != nil && !errors.Is(err, os.ErrNotExist) {
		tcp.Close()
		dns.Close()
		return nil, err
	}
	in, err := net.Listen("unix", s.cfg.ingress)
	if err == nil {
		// Only the relay, as root, connects here.
		err = os.Chmod(s.cfg.ingress, 0o600)
	}
	if err != nil {
		tcp.Close()
		dns.Close()
		return nil, err
	}
	return &listeners{tcp: tcp, dns: dns, ingress: in}, nil
}

func (s *shim) serve(l *listeners) {
	go s.serveDNS(l.dns)
	go s.serveIngress(l.ingress)
	s.serveTCP(l.tcp)
}

func (s *shim) serveTCP(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("netshim: accept: %v", err)
			continue
		}
		go s.egress(c.(*net.TCPConn))
	}
}

// egress carries one redirected connection to the relay.
func (s *shim) egress(c *net.TCPConn) {
	dst, err := s.origDst(c)
	if err != nil {
		log.Printf("netshim: original destination: %v", err)
		c.Close()
		return
	}
	src := c.RemoteAddr().(*net.TCPAddr).AddrPort()
	h := pp2.Header{Src: netip.AddrPortFrom(src.Addr().Unmap(), src.Port()), Dst: netip.AddrPortFrom(dst.Addr().Unmap(), dst.Port())}
	head, err := h.Encode()
	if err != nil {
		log.Printf("netshim: header for %v: %v", dst, err)
		c.Close()
		return
	}
	u, err := net.DialTimeout("unix", s.cfg.egress, dialTimeout)
	if err != nil {
		log.Printf("netshim: egress: %v", err)
		c.Close()
		return
	}
	if _, err := u.Write(head); err != nil {
		c.Close()
		u.Close()
		return
	}
	sockets.Splice(c, u)
}

func (s *shim) serveIngress(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("netshim: ingress accept: %v", err)
			continue
		}
		go ingress(c)
	}
}

// ingress reads the two-byte port the relay names and connects the stream
// to it on loopback.
func ingress(c net.Conn) {
	var p [2]byte
	c.SetReadDeadline(time.Now().Add(preambleTimeout))
	if _, err := io.ReadFull(c, p[:]); err != nil {
		c.Close()
		return
	}
	c.SetReadDeadline(time.Time{})
	port := binary.BigEndian.Uint16(p[:])
	t, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))), dialTimeout)
	if err != nil {
		c.Close()
		return
	}
	sockets.Splice(c, t)
}

func (s *shim) serveDNS(pc net.PacketConn) {
	buf := make([]byte, 1500)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if r, ok := dnsAnswer(buf[:n], s.cfg.sinkhole); ok {
			pc.WriteTo(r, addr)
		}
	}
}

// dnsAnswer answers a query of one question: an A query with the sinkhole,
// anything else with an empty NOERROR, so a resolver asking for both A and
// AAAA settles on the A answer. It echoes the id, opcode, RD bit and
// question, and drops a response, a query of several questions, and
// anything malformed. The TC bit is never set, so no resolver retries over
// TCP.
func dnsAnswer(q []byte, sink netip.Addr) ([]byte, bool) {
	if len(q) < 12 || q[2]&0x80 != 0 || binary.BigEndian.Uint16(q[4:6]) != 1 {
		return nil, false
	}
	i := 12
	for {
		if i >= len(q) {
			return nil, false
		}
		l := int(q[i])
		if l == 0 {
			i++
			break
		}
		if l > 63 || i+1+l > len(q) {
			return nil, false
		}
		i += 1 + l
	}
	if i+4 > len(q) {
		return nil, false
	}
	qtype, qclass := binary.BigEndian.Uint16(q[i:i+2]), binary.BigEndian.Uint16(q[i+2:i+4])
	end := i + 4
	answer := qtype == 1 && qclass == 1 && sink.Is4()
	r := make([]byte, 12, end+16)
	copy(r[0:2], q[0:2])
	// QR, the query's opcode and RD, and RA; RCODE 0.
	r[2] = 0x80 | q[2]&0x79
	r[3] = 0x80
	r[5] = 1
	if answer {
		r[7] = 1
	}
	r = append(r, q[12:end]...)
	if answer {
		a := sink.As4()
		r = append(r, 0xc0, 0x0c, 0, 1, 0, 1)
		r = binary.BigEndian.AppendUint32(r, dnsTTL)
		r = append(r, 0, 4)
		r = append(r, a[:]...)
	}
	return r, true
}

// originalDst reads SO_ORIGINAL_DST, the address the nat table rewrote, as
// a sockaddr_in.
func originalDst(c *net.TCPConn) (netip.AddrPort, error) {
	rc, err := c.SyscallConn()
	if err != nil {
		return netip.AddrPort{}, err
	}
	const soOriginalDst = 80
	var raw [16]byte
	var serr error
	err = rc.Control(func(fd uintptr) {
		l := uint32(len(raw))
		_, _, e := syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, syscall.SOL_IP, soOriginalDst,
			uintptr(unsafe.Pointer(&raw[0])), uintptr(unsafe.Pointer(&l)), 0)
		if e != 0 {
			serr = e
		}
	})
	if err == nil {
		err = serr
	}
	if err != nil {
		return netip.AddrPort{}, err
	}
	return netip.AddrPortFrom(netip.AddrFrom4([4]byte(raw[4:8])), binary.BigEndian.Uint16(raw[2:4])), nil
}
