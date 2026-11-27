//go:build !linux

package main

import "os"

// streamd runs only on Linux; elsewhere its tests take the platform's
// defaults.
func setTerminalFlags(*os.File) error {
	return nil
}
