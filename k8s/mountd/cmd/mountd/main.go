// mountd is the privileged half of a k8s install's per-node DaemonSet
// (docs/generic-workspace-pods.md "mountd"): it mounts a workspace's things
// under its pod's node-mounts directory and binds them inside its sandbox,
// taking trees from the arborist beside it.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	fail(run())
}

func run() error {
	var cfg config
	var tokenFile, tiers string
	flag.StringVar(&cfg.listen, "listen", ":10340", "address to serve on")
	flag.StringVar(&tokenFile, "token-file", "", "the bearer token the server sends")
	flag.StringVar(&cfg.build, "build", "", "the server build this mountd belongs to")
	flag.StringVar(&cfg.nmRoot, "node-mounts", "/node-mounts-root", "the node-mounts root, here")
	flag.StringVar(&cfg.nmRootNode, "node-mounts-on-node", "", "the node-mounts root, on the node")
	flag.StringVar(&cfg.nodeLocal, "node-local", "/node-local", "the node-local root, here")
	flag.StringVar(&tiers, "tiers", "", "storage tiers a mount may come from, name=dir,...")
	flag.StringVar(&cfg.hostRun, "host-run", "/host/run", "the node's /run")
	flag.StringVar(&cfg.runsc, "runsc", "/host/bin/runsc", "the node's runsc")
	flag.StringVar(&cfg.arboristURL, "arborist", "http://127.0.0.1:10341", "the arborist")
	flag.StringVar(&cfg.helper, "helper", "/usr/local/bin/sandbox-bind", "sandbox-bind, which pods' sandboxes run")
	flag.IntVar(&cfg.uid, "uid", 0, "the install uid")
	flag.IntVar(&cfg.gid, "gid", 0, "the install gid")
	flag.Parse()
	token, err := os.ReadFile(tokenFile)
	if err != nil {
		return err
	}
	cfg.token = strings.TrimSpace(string(token))
	if cfg.token == "" || cfg.nmRootNode == "" {
		return fmt.Errorf("a token and the node-mounts root on the node are required")
	}
	cfg.namespace, cfg.node = os.Getenv("POD_NAMESPACE"), os.Getenv("NODE_NAME")
	cfg.tiers = map[string]string{"node": cfg.nodeLocal}
	for _, t := range strings.Split(tiers, ",") {
		if name, dir, ok := strings.Cut(t, "="); ok {
			cfg.tiers[name] = dir
		}
	}
	return serve(cfg)
}

func fail(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "mountd: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}
