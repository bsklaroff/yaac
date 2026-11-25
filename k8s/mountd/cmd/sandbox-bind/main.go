// sandbox-bind binds a pod's node-mounts entries inside its gVisor sandbox,
// onto the paths tools expect (docs/generic-workspace-pods.md "A claim").
// It is static, so it runs in whatever image the container runs.
//
//	sandbox-bind binds <json>              in the workspace container
//	sandbox-bind tree-start -- <argv...>   in the tree container
//
// `binds` is started by mountd through `runsc exec`, with the binary handed
// in by descriptor and an exact process spec, so nothing it runs or reads
// comes from the workspace's image. Its request is its one argument.
//
// `tree-start` runs in the tree container, which yaac's base image runs: it
// binds that container's entries from the list in the node-mounts
// directory, gives up CAP_SYS_ADMIN for good, and executes the rest of its
// arguments. It runs again whenever the container restarts, since a
// restarted container's mounts are its own and start empty.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fail(fmt.Errorf("usage: sandbox-bind binds <json> | tree-start -- <argv...>"))
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "binds":
		if len(args) != 1 {
			fail(fmt.Errorf("binds takes one argument"))
		}
		fail(runBinds(args[0]))
	case "tree-start":
		if len(args) > 0 && args[0] == "--" {
			args = args[1:]
		}
		fail(runTreeStart(args))
	default:
		fail(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

func fail(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "sandbox-bind: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}
