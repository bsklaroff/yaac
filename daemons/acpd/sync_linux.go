package main

import (
	"os"
	"syscall"
)

// Flush a file's data, and only the metadata needed to read it back.
func fdatasync(f *os.File) error {
	return syscall.Fdatasync(int(f.Fd()))
}
