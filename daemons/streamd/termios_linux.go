package main

import (
	"os"
	"syscall"
	"unsafe"
)

// setTerminalFlags turns on what a new terminal in a pod lacks and a
// terminal emulator's has: input taken as UTF-8, so a line editor's
// backspace removes a whole character; a hang-up on last close; BREAK as
// an interrupt; any key restarting stopped output; a bell for a full input
// queue.
func setTerminalFlags(tty *os.File) error {
	var t syscall.Termios
	fd := tty.Fd()
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCGETS, uintptr(unsafe.Pointer(&t))); e != 0 {
		return e
	}
	t.Iflag |= syscall.IUTF8 | syscall.BRKINT | syscall.IXANY | syscall.IMAXBEL
	t.Cflag |= syscall.HUPCL
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCSETS, uintptr(unsafe.Pointer(&t))); e != 0 {
		return e
	}
	return nil
}
