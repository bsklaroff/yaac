// netshim is the network of a sandbox that has no interface
// (docs/workspace-egress.md "netshim"). It runs as a container of its
// own in each workspace, release and builder pod, as root with only
// CAP_NET_ADMIN and CAP_NET_RAW, and is the only container that mounts the
// pod's socket directory at /run/yaac. At start it routes every address to
// loopback and redirects TCP and DNS to itself; then it carries each
// outbound connection to netd's relay over egress.sock and each inbound
// one from ingress.sock to a loopback port.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/netip"
	"os"
	"os/exec"
	"strings"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "netshim: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var cfg config
	var sinkhole string
	flag.StringVar(&cfg.tcpListen, "tcp", "127.0.0.1:10301", "where redirected TCP lands")
	flag.StringVar(&cfg.dnsListen, "dns", "127.0.0.1:10302", "where redirected DNS lands")
	flag.StringVar(&cfg.egress, "egress", "/run/yaac/egress.sock", "the relay's socket")
	flag.StringVar(&cfg.ingress, "ingress", "/run/yaac/ingress.sock", "the socket the relay reaches the sandbox through")
	flag.StringVar(&sinkhole, "sinkhole", "198.18.0.1", "the address every name resolves to")
	flag.Parse()
	addr, err := netip.ParseAddr(sinkhole)
	if err != nil || !addr.Is4() {
		return fmt.Errorf("bad sinkhole %q", sinkhole)
	}
	cfg.sinkhole = addr
	cfg.podIP = os.Getenv("POD_IP")
	tcpPort, err := portOf(cfg.tcpListen)
	if err != nil {
		return err
	}
	dnsPort, err := portOf(cfg.dnsListen)
	if err != nil {
		return err
	}
	if err := setup(execute, setupCommands(cfg.podIP, tcpPort, dnsPort)); err != nil {
		return err
	}
	s := &shim{cfg: cfg, origDst: originalDst}
	l, err := s.listen()
	if err != nil {
		return err
	}
	log.Printf("netshim: up: tcp %s, dns %s, ingress %s", cfg.tcpListen, cfg.dnsListen, cfg.ingress)
	s.serve(l)
	return nil
}

func execute(argv []string) error {
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
