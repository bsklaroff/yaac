package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const procHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"

// procRow is one /proc/net/tcp-shaped row for a local address in a state.
func procRow(localHex, portHex, state string) string {
	return fmt.Sprintf("   0: %s:%s 00000000:0000 %s 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0", localHex, portHex, state)
}

func procFile(rows ...string) string {
	return strings.Join(append([]string{procHeader}, rows...), "\n") + "\n"
}

func TestIsLoopbackOrWildcardHex(t *testing.T) {
	for addr, want := range map[string]bool{
		"0100007F":                         true,  // 127.0.0.1
		"0A00007F":                         true,  // 127.0.0.10
		"00000000":                         true,  // 0.0.0.0
		"0101A8C0":                         false, // 192.168.1.1
		"0F02000A":                         false, // 10.0.2.15
		"00000000000000000000000001000000": true,  // ::1
		"00000000000000000000000000000000": true,  // ::
		"0000000000000000FFFF00000100007F": true,  // ::ffff:127.0.0.1
		"0000000000000000FFFF00000101A8C0": false, // ::ffff:192.168.1.1
		"FE80000000000000021CB3FFFE1D2E3F": false, // link-local
		"":                                 false,
		"zznotahexstring":                  false,
		"0100007F00":                       false, // wrong length
	} {
		if got := isLoopbackOrWildcardHex(addr); got != want {
			t.Errorf("isLoopbackOrWildcardHex(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestParseProcTCPPorts(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
		want []int
	}{
		{"keeps LISTEN rows on loopback and wildcard binds only", procFile(
			procRow("0100007F", "1F90", "0A"), // 127.0.0.1:8080 LISTEN
			procRow("00000000", "1F91", "0A"), // 0.0.0.0:8081 LISTEN
			procRow("0101A8C0", "1F92", "0A"), // 192.168.1.1:8082, unreachable
			procRow("0100007F", "1F93", "01"), // 127.0.0.1:8083 ESTABLISHED
		), []int{8080, 8081}},
		{"reads tcp6 rows", procFile(
			procRow("00000000000000000000000001000000", "1F90", "0A"), // [::1]:8080
			procRow("00000000000000000000000000000000", "1F91", "0A"), // [::]:8081
			procRow("FE80000000000000021CB3FFFE1D2E3F", "1F92", "0A"), // link-local
		), []int{8080, 8081}},
		{"skips torn and malformed rows", procFile(
			"garbage line",
			"   0: brokenrow",
			procRow("0100007F", "ZZZZ", "0A"), // not hex
			procRow("0100007F", "0000", "0A"), // port 0
			procRow("0100007F", "1F90", "0A"),
		) + "   1: 0100007F:1F91 00000000:00", []int{8080}}, // a torn last row
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseProcTCPPorts(tc.text); !slices.Equal(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("bounds hostile input by row count", func(t *testing.T) {
		rows := make([]string, 20_000)
		for i := range rows {
			rows[i] = procRow("0100007F", fmt.Sprintf("%04X", 1024+i%60_000), "0A")
		}
		if got := parseProcTCPPorts(procFile(rows...)); len(got) > maxProcRows {
			t.Fatalf("%d ports", len(got))
		}
	})
}

func TestReadListeningPorts(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "tcp"), procFile(
		procRow("0100007F", "1F92", "0A"), // 8082
		procRow("00000000", "1F90", "0A"), // 8080
	))
	write(t, filepath.Join(dir, "tcp6"), procFile(
		procRow("00000000000000000000000000000000", "1F90", "0A"), // 8080 again
		procRow("00000000000000000000000001000000", "1F91", "0A"), // 8081
	))
	if got := readListeningPorts(dir); !slices.Equal(got, []int{8080, 8081, 8082}) {
		t.Fatalf("got %v", got)
	}
	if got := readListeningPorts(filepath.Join(dir, "missing")); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func write(t *testing.T, file, text string) {
	t.Helper()
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPortsStream(t *testing.T) {
	procDir := t.TempDir()
	write(t, filepath.Join(procDir, "tcp"), procFile())
	port := startDaemon(t, func(c *config) {
		c.procNetDir = procDir
		c.portsPoll = 50 * time.Millisecond
		c.portsKeepalive = 400 * time.Millisecond
	})
	// The daemon's own port is left out.
	write(t, filepath.Join(procDir, "tcp"), procFile(
		procRow("0100007F", "1F90", "0A"), // 8080
		procRow("0100007F", fmt.Sprintf("%04X", port), "0A"),
	))
	c := open(t, port, map[string]any{"token": testToken, "kind": "ports"}).mustOK()
	next := func() []int {
		var msg struct{ Ports []int }
		if err := json.Unmarshal([]byte(c.line()), &msg); err != nil {
			t.Fatal(err)
		}
		return msg.Ports
	}
	if got := next(); !slices.Equal(got, []int{8080}) {
		t.Fatalf("first push %v", got)
	}
	write(t, filepath.Join(procDir, "tcp"), procFile(
		procRow("0100007F", "1F90", "0A"),
		procRow("00000000", "1F95", "0A"), // 8085
	))
	if got := next(); !slices.Equal(got, []int{8080, 8085}) {
		t.Fatalf("after the change %v", got)
	}
	// With no change, the same set comes again as a keepalive.
	start := time.Now()
	if got := next(); !slices.Equal(got, []int{8080, 8085}) {
		t.Fatalf("keepalive %v", got)
	}
	if time.Since(start) < 200*time.Millisecond {
		t.Fatal("an unchanged set was sent before its keepalive")
	}
}
