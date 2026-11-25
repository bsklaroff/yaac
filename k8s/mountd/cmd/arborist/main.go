// arborist builds working trees from a node's main clones ahead of time and
// on demand, as the install uid with no capability, for mountd to take
// (docs/generic-workspace-pods.md "Trees").
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	listen := flag.String("listen", "127.0.0.1:10341", "address to serve on")
	repos := flag.String("repos", "", "the main clones' directory, at the server's own path")
	ready := flag.String("ready", "/ready", "the ready trees' directory")
	flag.Parse()
	if err := runArborist(*listen, *repos, *ready); err != nil {
		fmt.Fprintf(os.Stderr, "arborist: %v\n", err)
		os.Exit(1)
	}
}
