package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"

	"yaac-mountd/internal/wire"
)

// bindOne binds src onto target, making the target as a directory, or as
// an empty file for a file source, and remounting it writable unless asked
// not to: under a read-only node-mounts directory a bind starts read-only.
func bindOne(src, target string, readOnly bool) error {
	if !filepath.IsAbs(target) {
		return fmt.Errorf("target %q is not absolute", target)
	}
	var st unix.Stat_t
	if err := unix.Stat(src, &st); err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		if err := os.MkdirAll(target, 0o755); err != nil {
			return err
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		f.Close()
	}
	if err := unix.Mount(src, target, "", unix.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind %s: %w", target, err)
	}
	flags := uintptr(unix.MS_BIND | unix.MS_REMOUNT)
	if readOnly {
		flags |= unix.MS_RDONLY
	}
	if err := unix.Mount("", target, "", flags, ""); err != nil {
		return fmt.Errorf("remount %s: %w", target, err)
	}
	return nil
}

// runBinds makes the workspace container's binds its request names.
func runBinds(arg string) error {
	var req wire.Request
	if err := json.Unmarshal([]byte(arg), &req); err != nil {
		return fmt.Errorf("request: %w", err)
	}
	for _, b := range wire.ByDepth(req.Binds) {
		src := filepath.Join(wire.NodeMountsDir, strconv.Itoa(b.N))
		if b.From != "" {
			root, ok := req.Roots[b.From]
			if !ok || !filepath.IsAbs(root) {
				return fmt.Errorf("a bind from %q, which names no volume", b.From)
			}
			src = filepath.Join(root, strconv.Itoa(b.N))
			if err := os.Mkdir(src, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
			if err := os.Lchown(src, req.UID, req.GID); err != nil {
				return err
			}
		}
		if err := bindOne(src, b.Target, b.ReadOnly); err != nil {
			return err
		}
	}
	return nil
}

// runTreeStart binds the tree container's entries, drops CAP_SYS_ADMIN
// from every set, and executes argv.
func runTreeStart(argv []string) error {
	if len(argv) == 0 {
		return errors.New("tree-start: nothing to run")
	}
	data, err := os.ReadFile(filepath.Join(wire.NodeMountsDir, wire.ListFile))
	if err != nil {
		return err
	}
	var list wire.List
	if err := json.Unmarshal(data, &list); err != nil {
		return fmt.Errorf("list: %w", err)
	}
	for _, b := range wire.ByDepth(list.Tree) {
		if err := bindOne(filepath.Join(wire.NodeMountsDir, strconv.Itoa(b.N)), b.Target, b.ReadOnly); err != nil {
			return err
		}
	}
	// CAP_SETPCAP is what lets it drop from the bounding set, so it goes last.
	if err := dropCaps(unix.CAP_SYS_ADMIN, unix.CAP_SETPCAP); err != nil {
		return err
	}
	path := argv[0]
	if !filepath.IsAbs(path) {
		if path, err = lookPath(path); err != nil {
			return err
		}
	}
	return syscall.Exec(path, argv, os.Environ())
}

// dropCaps removes capabilities from the bounding set, in order, so
// nothing this process executes can regain them, then from its own sets.
func dropCaps(capabilities ...int) error {
	for _, c := range capabilities {
		if err := unix.Prctl(unix.PR_CAPBSET_DROP, uintptr(c), 0, 0, 0); err != nil {
			return fmt.Errorf("drop capability %d from the bounding set: %w", c, err)
		}
	}
	if err := unix.Prctl(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0); err != nil {
		return fmt.Errorf("clear ambient: %w", err)
	}
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	if err := unix.Capget(&hdr, &data[0]); err != nil {
		return err
	}
	for _, c := range capabilities {
		word, bit := c/32, uint32(1)<<(c%32)
		data[word].Effective &^= bit
		data[word].Permitted &^= bit
		data[word].Inheritable &^= bit
	}
	return unix.Capset(&hdr, &data[0])
}

func lookPath(name string) (string, error) {
	for _, dir := range strings.Split(os.Getenv("PATH"), ":") {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s is not on PATH", name)
}
