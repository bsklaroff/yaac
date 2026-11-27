package main

import "syscall"

// The signal names Linux adds, as Node's os.constants.signals lists them.
func init() {
	signals["SIGPWR"] = syscall.SIGPWR
	signals["SIGSTKFLT"] = syscall.SIGSTKFLT
	signalAliases["SIGIOT"] = syscall.SIGIOT
	signalAliases["SIGPOLL"] = syscall.SIGIO
}
