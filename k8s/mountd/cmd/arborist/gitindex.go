package main

// Backdating a freshly built tree and rewriting its git index to match
// (docs/generic-workspace-pods.md "Trees"). git writes every file of a
// native build and the index within one second, so every entry would be
// "racy" (its mtime not older than the index's) and the first `git status`
// would hash every file. Each file's mtime is set two seconds back and each
// index entry's stat fields are rewritten from a fresh lstat, leaving the
// object ids alone. git wrote every file from those ids and nothing has
// touched them since, so the index stays true.
//
// Only index version 2 is read: version 4 compresses paths. The builder asks
// git for version 2.

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

const (
	indexSignature = "DIRC"
	// The fixed part of an entry before its object id: ctime, mtime (each
	// seconds and nanoseconds), dev, ino, mode, uid, gid, size.
	entryStatBytes = 40
	modeGitlink    = 0o160000
	modeTypeMask   = 0o170000
)

// backdateTree sets every file the index names under tree to `at` and
// rewrites the index at indexPath to match. idLen is the object id length:
// 20 for SHA-1 repositories, 32 for SHA-256.
func backdateTree(indexPath, tree string, idLen int, at time.Time) error {
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return err
	}
	out, err := rewriteIndex(data, idLen, func(path string, mode uint32) (*unix.Stat_t, error) {
		if mode&modeTypeMask == modeGitlink {
			return nil, nil
		}
		full := filepath.Join(tree, path)
		ts := []unix.Timespec{unix.NsecToTimespec(at.UnixNano()), unix.NsecToTimespec(at.UnixNano())}
		if err := unix.UtimesNanoAt(unix.AT_FDCWD, full, ts, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, err
		}
		var st unix.Stat_t
		if err := unix.Lstat(full, &st); err != nil {
			return nil, err
		}
		return &st, nil
	})
	if err != nil {
		return err
	}
	tmp := indexPath + ".backdated"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, indexPath)
}

// rewriteIndex returns the index with each entry's stat fields taken from
// stat(path, mode), which may return nil to leave an entry as it is.
// Extensions are kept byte for byte and the trailing checksum recomputed.
func rewriteIndex(data []byte, idLen int, stat func(path string, mode uint32) (*unix.Stat_t, error)) ([]byte, error) {
	var newHash func() hash.Hash
	switch idLen {
	case sha1.Size:
		newHash = sha1.New
	case sha256.Size:
		newHash = sha256.New
	default:
		return nil, fmt.Errorf("object ids of %d bytes", idLen)
	}
	if len(data) < 12+idLen || string(data[:4]) != indexSignature {
		return nil, errors.New("not a git index")
	}
	body := data[:len(data)-idLen]
	sum := newHash()
	sum.Write(body)
	if !bytes.Equal(sum.Sum(nil), data[len(data)-idLen:]) {
		return nil, errors.New("the index's checksum does not match")
	}
	if v := binary.BigEndian.Uint32(data[4:8]); v != 2 {
		return nil, fmt.Errorf("index version %d; only version 2 is read", v)
	}
	count := binary.BigEndian.Uint32(data[8:12])
	out := append([]byte(nil), body...)
	off := 12
	for i := uint32(0); i < count; i++ {
		fixed := entryStatBytes + idLen + 2
		if off+fixed > len(body) {
			return nil, errors.New("the index ends inside an entry")
		}
		flags := binary.BigEndian.Uint16(body[off+entryStatBytes+idLen:])
		if flags&0x4000 != 0 {
			return nil, errors.New("an extended entry flag in a version 2 index")
		}
		nameStart := off + fixed
		nameEnd := bytes.IndexByte(body[nameStart:], 0)
		if nameEnd < 0 {
			return nil, errors.New("an entry's path is not terminated")
		}
		name := string(body[nameStart : nameStart+nameEnd])
		// Entries are NUL-padded to a multiple of 8 bytes, with 1 to 8 NULs.
		entryLen := (fixed + nameEnd + 8) &^ 7
		if off+entryLen > len(body) {
			return nil, errors.New("the index ends inside an entry's padding")
		}
		mode := binary.BigEndian.Uint32(body[off+24:])
		st, err := stat(name, mode)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if st != nil {
			e := out[off:]
			put := func(at int, v uint32) { binary.BigEndian.PutUint32(e[at:], v) }
			put(0, uint32(st.Ctim.Sec))
			put(4, uint32(st.Ctim.Nsec))
			put(8, uint32(st.Mtim.Sec))
			put(12, uint32(st.Mtim.Nsec))
			put(16, uint32(st.Dev))
			put(20, uint32(st.Ino))
			put(28, st.Uid)
			put(32, st.Gid)
			put(36, uint32(st.Size))
		}
		off += entryLen
	}
	sum = newHash()
	sum.Write(out)
	return append(out, sum.Sum(nil)...), nil
}
