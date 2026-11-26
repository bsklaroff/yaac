// acpd supervises one ACP agent process (see daemon.go), and dials one
// agent's socket for the server (see dial.go).
//
//	acpd --sock <path> [--log <path>] [--cwd <path>] [--wait-for <path>]... -- <agent argv...>
//	acpd dial <sock>
//
// The server starts it inside a tmux window (`acpDriver.launchCmd` in
// packages/server/src/runtime/agents/acp-driver.ts), so tmux supervises it
// like a TUI agent. It is a static binary so it starts at once and costs
// a few megabytes per agent: the image builds it for its own platform, and
// `pnpm build` cross-compiles one per supported host into
// dockerfiles/acpd/bin for the containerless driver.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const usageLine = "usage: acpd --sock <path> [--log <path>] [--cwd <path>] [--wait-for <path>]... -- <agent argv...>\n" +
	"       acpd dial <sock>"

func usage(msg string) {
	fmt.Fprintf(os.Stderr, "[acpd] %s\n[acpd] %s\n", msg, usageLine)
	os.Exit(2)
}

// The daemon's options, up to the `--` before the agent's argv.
// `--wait-for` may repeat, once per checkout a launch is still writing.
func parseArgs(args []string) (config, error) {
	var cfg config
	sep := -1
	for i := 0; i < len(args); i += 2 {
		if args[i] == "--" {
			sep = i
			break
		}
		if i+1 >= len(args) {
			return cfg, fmt.Errorf("%s needs a value", args[i])
		}
		switch args[i] {
		case "--sock":
			cfg.sock = args[i+1]
		case "--log":
			cfg.logPath = args[i+1]
		case "--cwd":
			cfg.cwd = args[i+1]
		case "--wait-for":
			cfg.waitFor = append(cfg.waitFor, args[i+1])
		default:
			return cfg, fmt.Errorf("unknown option %s", args[i])
		}
	}
	switch {
	case sep < 0:
		return cfg, errors.New("missing `--` separator before the agent argv")
	case cfg.sock == "":
		return cfg, errors.New("--sock is required")
	case sep+1 == len(args):
		return cfg, errors.New("no agent command given")
	}
	cfg.argv = args[sep+1:]
	return cfg, nil
}

func main() {
	// A write to a closed stdout or stderr (a pane gone, a dial's stream
	// closed) returns an error rather than killing acpd. Caught rather than
	// ignored, so the agent does not inherit an ignored SIGPIPE.
	signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE)
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "dial" {
		if len(args) != 2 {
			usage("dial takes exactly one socket path")
		}
		os.Exit(dial(args[1], os.Stdin, os.Stdout))
	}

	cfg, err := parseArgs(args)
	if err != nil {
		usage(err.Error())
	}
	cfg.logOut = os.Stderr
	d := newDaemon(cfg)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		d.close()
	}()
	if err := d.listen(); err != nil {
		fmt.Fprintf(os.Stderr, "[acpd] listen failed: %v\n", err)
		os.Exit(1)
	}
	os.Exit(d.wait())
}
