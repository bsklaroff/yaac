//go:build !linux

package main

import "os"

// macOS has no fdatasync, so do a full sync.
func fdatasync(f *os.File) error {
	return f.Sync()
}
