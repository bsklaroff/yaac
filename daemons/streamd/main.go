// streamd is the daemon in every k8s workspace pod that the server's
// streams end at (docs/stream-relay.md): terminals, the status watcher's
// tmux control stream, forwarded ports, ACP sockets, one-shot commands and
// the claim that makes a pod one workspace's.
//
//	YAAC_STREAM_TOKEN=<token> [YAAC_STREAM_PORT=<port>] streamd
//
// The pod's postStart hook starts it from the server build's helpers folder
// (workspace-bin/yaac-workspace-init), as the status watcher's revive does
// (`bootStreamd`). It is a static binary so a pod starts it at once and it
// costs a few megabytes; `pnpm build:daemons` cross-compiles one per Linux
// architecture into daemons/streamd/bin.
package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
)

func main() {
	resetInheritedSignals()
	token := os.Getenv("YAAC_STREAM_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "[streamd] YAAC_STREAM_TOKEN is required")
		os.Exit(1)
	}
	port, err := strconv.Atoi(os.Getenv("YAAC_STREAM_PORT"))
	if err != nil || port <= 0 {
		port = defaultPort
	}
	// IPv4 only: netshim dials it at 127.0.0.1 (docs/workspace-egress.md
	// "netshim").
	ln, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		// An earlier streamd already serves this pod (a repeated boot).
		if errors.Is(err, syscall.EADDRINUSE) {
			fmt.Printf("[streamd] :%d already served, exiting\n", port)
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "[streamd] listen failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[streamd] listening on :%d\n", port)
	newDaemon(defaultConfig(token)).serve(ln)
}

// resetInheritedSignals undoes the SIGINT ignore that the shell starting
// streamd in the background hands it (and a SIGHUP ignore, should a
// starter add one). Go keeps an inherited ignore of these two, unlike
// every other signal, and passes it on to each child, so a terminal's
// Ctrl-C, or a pty's hang-up, would not reach a program that keeps its
// dispositions. Catching them gives each child the default instead, and
// streamd itself still ends on either, as it would by default.
func resetInheritedSignals() {
	caught := make(chan os.Signal, 1)
	signal.Notify(caught, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		sig := <-caught
		os.Exit(128 + int(sig.(syscall.Signal)))
	}()
}
