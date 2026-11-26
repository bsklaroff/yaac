// relay is netd's network half (docs/workspace-egress.md "The relay, and
// the rest of netd"): on each node it binds the egress socket of
// every workspace and builder pod there and carries what arrives to the
// proxy, and it carries the server's streams and the site router's
// requests into those pods through their ingress sockets. The socket work
// is internal/sockets; this program is the Kubernetes glue around it.
package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"strconv"
	"strings"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "relay: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var cfg config
	var secretFile, dirMode string
	flag.StringVar(&cfg.root, "root", "/s", "the install's socket root, here")
	flag.StringVar(&cfg.nodeRoot, "node-root", "", "the install's socket root, on the node")
	flag.StringVar(&cfg.proxy, "proxy", "", "host:port of the proxy's socket ingress")
	flag.StringVar(&secretFile, "secret-file", "", "the proxy auth secret")
	flag.StringVar(&cfg.streamListen, "stream-listen", ":10262", "where the server's stream dials land")
	flag.StringVar(&cfg.siteListen, "site-listen", ":10263", "where the site router's dials land")
	flag.IntVar(&cfg.streamPort, "stream-port", 10300, "streamd's port inside a workspace")
	flag.StringVar(&cfg.readyFile, "ready-file", "", "written once the relay serves")
	flag.StringVar(&dirMode, "dir-mode", "0700", "mode of each unit's directory")
	flag.Parse()
	if cfg.nodeRoot == "" || cfg.proxy == "" || secretFile == "" {
		return fmt.Errorf("-node-root, -proxy and -secret-file are required")
	}
	var err error
	if cfg.dirMode, err = parseMode(dirMode); err != nil {
		return err
	}
	secret, err := os.ReadFile(secretFile)
	if err != nil {
		return err
	}
	cfg.secret = strings.TrimSpace(string(secret))
	cfg.namespace, cfg.node = os.Getenv("POD_NAMESPACE"), os.Getenv("NODE_NAME")
	if cfg.secret == "" || cfg.namespace == "" || cfg.node == "" {
		return fmt.Errorf("a secret, POD_NAMESPACE and NODE_NAME are required")
	}
	rc, err := rest.InClusterConfig()
	if err != nil {
		return err
	}
	client, err := kubernetes.NewForConfig(rc)
	if err != nil {
		return err
	}
	if err := newRelay(cfg, client).start(context.Background()); err != nil {
		return err
	}
	log.Printf("relay: up on node %s: streams %s, sites %s, proxy %s", cfg.node, cfg.streamListen, cfg.siteListen, cfg.proxy)
	select {}
}

func parseMode(s string) (fs.FileMode, error) {
	m, err := strconv.ParseUint(s, 8, 32)
	if err != nil || m == 0 || m > 0o777 {
		return 0, fmt.Errorf("bad mode %q", s)
	}
	return fs.FileMode(m), nil
}
