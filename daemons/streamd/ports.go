package main

// The ports kind: the pod's listening TCP ports, for the server's port
// detector (docs/auto-forward-ports.md). Only sockets bound to loopback or
// a wildcard count, since the tcp kind dials localhost.
//
// The agent controls these files, so parsing is bounded in size and rows,
// and every port is checked.

import (
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	// Read cap per file, in case a hostile mount replaces /proc/net.
	maxProcBytes = 2 * 1024 * 1024
	// Row cap per file; rows past it are ignored.
	maxProcRows = 8192
	// The socket-state column's value for LISTEN.
	stateListen = "0A"
)

// A ports stream sends the set once right after {ok}, on every change, and
// at least every keepalive, so the server can tell a quiet pod from a dead
// stream. /proc is read only while one is open.
func portsKind(d *daemon, s *stream, _ params) (func(), string) {
	return func() {
		gone := make(chan struct{})
		go func() {
			_, _ = io.Copy(io.Discard, s.r)
			close(gone)
		}()
		lastKey, lastSent := "", time.Time{}
		emit := func() bool {
			own := int(d.port.Load())
			ports := slices.DeleteFunc(readListeningPorts(d.cfg.procNetDir), func(p int) bool { return p == own })
			key := joinInts(ports)
			if !lastSent.IsZero() && key == lastKey && time.Since(lastSent) < d.cfg.portsKeepalive {
				return true
			}
			lastKey, lastSent = key, time.Now()
			return s.writeJSON(struct {
				Ports []int `json:"ports"`
			}{ports}) == nil
		}
		if !emit() {
			return
		}
		tick := time.NewTicker(d.cfg.portsPoll)
		defer tick.Stop()
		for {
			select {
			case <-gone:
				return
			case <-tick.C:
				if !emit() {
					return
				}
			}
		}
	}, ""
}

func joinInts(ns []int) string {
	parts := make([]string, len(ns))
	for i, n := range ns {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, " ")
}

// readListeningPorts is the pod's loopback-reachable LISTEN ports across tcp
// and tcp6, deduped and ascending. A missing or unreadable file contributes
// nothing (a v4-only network namespace has no tcp6).
func readListeningPorts(procNetDir string) []int {
	ports := []int{}
	for _, name := range []string{"tcp", "tcp6"} {
		text, err := readBounded(filepath.Join(procNetDir, name))
		if err != nil {
			continue
		}
		ports = append(ports, parseProcTCPPorts(text)...)
	}
	slices.Sort(ports)
	return slices.Compact(ports)
}

// readBounded reads a /proc file, which reports no size, up to the cap.
func readBounded(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxProcBytes))
	return string(b), err
}

// parseProcTCPPorts reads one /proc/net/tcp{,6} body. Torn or malformed
// rows are skipped.
func parseProcTCPPorts(text string) []int {
	lines := strings.Split(text[:min(len(text), maxProcBytes)], "\n")
	var ports []int
	// Row 0 is the header.
	for i := 1; i < min(len(lines), maxProcRows); i++ {
		// sl local_address rem_address st ...
		cols := strings.Fields(lines[i])
		if len(cols) < 4 || cols[3] != stateListen {
			continue
		}
		addr := strings.Split(cols[1], ":")
		if len(addr) < 2 || len(addr[1]) < 1 || len(addr[1]) > 4 || !isHex(addr[1]) {
			continue
		}
		port, _ := strconv.ParseUint(addr[1], 16, 32)
		if port < 1 || !isLoopbackOrWildcardHex(addr[0]) {
			continue
		}
		ports = append(ports, int(port))
	}
	return ports
}

// isLoopbackOrWildcardHex reports whether a /proc/net local_address is
// reachable from an in-pod localhost dial: IPv4 or IPv6 loopback or
// wildcard. The kernel prints each 32-bit word little-endian, so 127.0.0.1
// is "0100007F" (any 127/8 address ends in "7F") and ::1 is 24 zeros then
// "01000000"; an IPv4-mapped ::ffff:a.b.c.d carries "FFFF0000" in the third
// word and the IPv4 word last.
func isLoopbackOrWildcardHex(addr string) bool {
	hex := strings.ToUpper(addr)
	if !isHex(hex) {
		return false
	}
	switch len(hex) {
	case 8:
		return hex == "00000000" || strings.HasSuffix(hex, "7F")
	case 32:
		if strings.Trim(hex, "0") == "" || hex == "00000000000000000000000001000000" {
			return true
		}
		if strings.HasPrefix(hex, "0000000000000000FFFF0000") {
			return isLoopbackOrWildcardHex(hex[24:])
		}
	}
	return false
}

func isHex(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}
