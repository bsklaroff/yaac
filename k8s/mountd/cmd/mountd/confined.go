// Mounts and paths by descriptor. Every path mountd acts on is opened
// beneath a root it holds open, refusing any symlink on the way, and every
// mount is made from and onto descriptors, so nothing a workspace can write
// (a link planted in a folder it owns) redirects one.

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// cleanRel checks that p is a relative path that stays beneath its root.
func cleanRel(p string) (string, error) {
	if p == "" {
		return ".", nil
	}
	if filepath.IsAbs(p) || filepath.Clean(p) != p || p == ".." || strings.HasPrefix(p, "../") {
		return "", fmt.Errorf("%q is not a plain relative path", p)
	}
	return p, nil
}

// openBeneath opens rel beneath the directory rootFd refers to, following
// no symlink, magic link or `..` out of it.
func openBeneath(rootFd int, rel string, flags int) (int, error) {
	rel, err := cleanRel(rel)
	if err != nil {
		return -1, err
	}
	how := unix.OpenHow{
		Flags:   uint64(flags | unix.O_CLOEXEC),
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
	}
	fd, err := unix.Openat2(rootFd, rel, &how)
	if err != nil {
		return -1, fmt.Errorf("open %s: %w", rel, err)
	}
	return fd, nil
}

// openRoot opens an absolute directory mountd's own spec mounted.
func openRoot(dir string) (int, error) {
	return unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
}

// mkdirAllOwned makes rel beneath rootFd, each missing component owned by
// uid:gid, and returns the last one open.
func mkdirAllOwned(rootFd int, rel string, uid, gid int) (int, error) {
	rel, err := cleanRel(rel)
	if err != nil {
		return -1, err
	}
	fd, err := unix.Dup(rootFd)
	if err != nil {
		return -1, err
	}
	if rel == "." {
		return fd, nil
	}
	for _, part := range strings.Split(rel, "/") {
		err := unix.Mkdirat(fd, part, 0o755)
		made := err == nil
		if err != nil && !errors.Is(err, unix.EEXIST) {
			unix.Close(fd)
			return -1, fmt.Errorf("mkdir %s: %w", part, err)
		}
		next, err := openBeneath(fd, part, unix.O_PATH|unix.O_DIRECTORY)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
		if made {
			if err := unix.Fchownat(fd, "", uid, gid, unix.AT_EMPTY_PATH); err != nil {
				unix.Close(fd)
				return -1, err
			}
		}
	}
	return fd, nil
}

// bindInto attaches a copy of the mount at srcFd (a path opened beneath a
// root) as `name` inside the directory dirFd, read-only if asked. A
// read-only copy is made read-only before it is attached, so no peer it
// propagates to ever holds a writable one.
func bindInto(srcFd int, readOnly bool, dirFd int, name string) error {
	var st unix.Stat_t
	if err := unix.Fstat(srcFd, &st); err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		if err := unix.Mkdirat(dirFd, name, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			return err
		}
	} else {
		f, err := unix.Openat(dirFd, name, unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_WRONLY, 0o644)
		if err != nil && !errors.Is(err, unix.EEXIST) {
			return err
		}
		if err == nil {
			unix.Close(f)
		}
	}
	tree, err := unix.OpenTree(srcFd, "", unix.OPEN_TREE_CLONE|unix.OPEN_TREE_CLOEXEC|unix.AT_EMPTY_PATH)
	if err != nil {
		return fmt.Errorf("clone: %w", err)
	}
	defer unix.Close(tree)
	if readOnly {
		if err := unix.MountSetattr(tree, "", unix.AT_EMPTY_PATH, &unix.MountAttr{Attr_set: unix.MOUNT_ATTR_RDONLY}); err != nil {
			return fmt.Errorf("read-only: %w", err)
		}
	}
	if err := unix.MoveMount(tree, "", dirFd, name, unix.MOVE_MOUNT_F_EMPTY_PATH); err != nil {
		return fmt.Errorf("attach: %w", err)
	}
	return nil
}

// mountPointsUnder lists the mount points at or under dir in this mount
// namespace's table, deepest first.
func mountPointsUnder(mountinfo, dir string) ([]string, error) {
	f, err := os.Open(mountinfo)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var found []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 5 {
			continue
		}
		mp := unescapeMountinfo(fields[4])
		if mp == dir || strings.HasPrefix(mp, dir+"/") {
			found = append(found, mp)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(found, func(i, j int) bool {
		return strings.Count(found[i], "/") > strings.Count(found[j], "/")
	})
	return found, nil
}

// unescapeMountinfo decodes the octal escapes (\040 for a space) the kernel
// writes in mountinfo paths.
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// releaseDir undoes one pod's node-mounts directory: every mount under it,
// found in the mount table and lazily unmounted deepest first, then its
// entries removed one at a time without following a link, and the
// directory itself. Nothing is removed recursively, so a mount the table
// missed is left in place, with its directory, and reported.
func releaseDir(mountinfo, root, name string) error {
	dir := filepath.Join(root, name)
	mps, err := mountPointsUnder(mountinfo, dir)
	if err != nil {
		return err
	}
	for _, mp := range mps {
		if mp == dir {
			continue
		}
		if err := unix.Unmount(mp, unix.MNT_DETACH|unix.UMOUNT_NOFOLLOW); err != nil && !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("unmount %s: %w", mp, err)
		}
	}
	rootFd, err := openRoot(root)
	if err != nil {
		return err
	}
	defer unix.Close(rootFd)
	dirFd, err := openBeneath(rootFd, name, unix.O_RDONLY|unix.O_DIRECTORY)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	d := os.NewFile(uintptr(dirFd), dir)
	names, err := d.Readdirnames(-1)
	if err != nil {
		d.Close()
		return err
	}
	var stuck []string
	for _, n := range names {
		var st unix.Stat_t
		if err := unix.Fstatat(dirFd, n, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			stuck = append(stuck, n)
			continue
		}
		flag := 0
		if st.Mode&unix.S_IFMT == unix.S_IFDIR {
			flag = unix.AT_REMOVEDIR
		}
		if err := unix.Unlinkat(dirFd, n, flag); err != nil {
			stuck = append(stuck, n)
		}
	}
	d.Close()
	if len(stuck) > 0 {
		return fmt.Errorf("%s still holds %s", dir, strings.Join(stuck, ", "))
	}
	if err := unix.Unlinkat(rootFd, name, unix.AT_REMOVEDIR); err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	return nil
}
