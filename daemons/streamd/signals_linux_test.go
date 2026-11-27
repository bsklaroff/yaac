package main

import (
	"syscall"
	"testing"
)

// Linux's further names, as Node's os.constants.signals lists them.
func TestLinuxSignalNames(t *testing.T) {
	for name, want := range map[string]syscall.Signal{
		"SIGPWR": syscall.SIGPWR, "SIGSTKFLT": syscall.SIGSTKFLT,
		"SIGIOT": syscall.SIGABRT, "SIGPOLL": syscall.SIGIO,
	} {
		if sig, ok := signalByName(name); !ok || sig != want {
			t.Errorf("%s: got %v, %v", name, sig, ok)
		}
	}
	for range 20 {
		if signalName(syscall.SIGPWR) != "SIGPWR" || signalName(syscall.SIGIO) != "SIGIO" {
			t.Fatal("an exec's reply must name a signal by its main name")
		}
	}
}
