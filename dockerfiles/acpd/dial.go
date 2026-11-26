// `acpd dial <sock>`: the server's end of an attach.
//
// The server runs it over a streamd `ctrl` stream (or a host process under
// the containerless driver) to get a raw duplex to one conversation's
// socket; the socket is a UNIX one so it stays out of the auto-forward port
// scan. acpd binds its socket a moment after tmux respawns the window into
// it, so a new window's first dial usually comes early: the dial retries
// until the socket answers, which connects as soon as acpd listens, where a
// failed dial would wait out the server's slower re-dial.
//
// It ends when either side does. acpd keeps a half-closed client attached,
// so a dial that outlived its server would hold the conversation until the
// next attach displaced it.
package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

// 40 retries 50 ms apart: two seconds, generous for a loaded gVisor node.
// Variables so a test can give up sooner.
var (
	dialRetries  = 40
	dialInterval = 50 * time.Millisecond
)

func dial(sock string, in io.Reader, out io.Writer) int {
	var conn net.Conn
	var err error
	for try := 0; ; try++ {
		if conn, err = net.Dial("unix", sock); err == nil {
			break
		}
		if try == dialRetries {
			fmt.Fprintf(os.Stderr, "[acpd] dial %s: %v\n", sock, err)
			return 1
		}
		time.Sleep(dialInterval)
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(conn, in)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(out, conn)
		done <- struct{}{}
	}()
	<-done
	conn.Close()
	return 0
}
