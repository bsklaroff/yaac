package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// indexOf builds a version 2 index of the given paths, each entry's stat
// fields zero, followed by one extension.
func indexOf(paths []string, ext []byte) []byte {
	var b bytes.Buffer
	b.WriteString("DIRC")
	_ = binary.Write(&b, binary.BigEndian, uint32(2))
	_ = binary.Write(&b, binary.BigEndian, uint32(len(paths)))
	for _, p := range paths {
		entry := make([]byte, entryStatBytes+sha1.Size+2)
		binary.BigEndian.PutUint32(entry[24:], 0o100644)
		copy(entry[entryStatBytes:], bytes.Repeat([]byte{0xab}, sha1.Size))
		binary.BigEndian.PutUint16(entry[entryStatBytes+sha1.Size:], uint16(len(p)))
		entry = append(entry, p...)
		for pad := 8 - len(entry)%8; pad > 0; pad-- {
			entry = append(entry, 0)
		}
		b.Write(entry)
	}
	b.Write(ext)
	sum := sha1.Sum(b.Bytes())
	return append(b.Bytes(), sum[:]...)
}

func TestRewriteIndex(t *testing.T) {
	ext := append([]byte("TREE"), 0, 0, 0, 3, 'x', 'y', 'z')
	in := indexOf([]string{"a.txt", "dir/twelve-chars"}, ext)
	seen := []string{}
	out, err := rewriteIndex(in, sha1.Size, func(path string, mode uint32) (*unix.Stat_t, error) {
		seen = append(seen, path)
		if mode != 0o100644 {
			t.Errorf("mode %o", mode)
		}
		return &unix.Stat_t{Mtim: unix.Timespec{Sec: 100, Nsec: 7}, Ctim: unix.Timespec{Sec: 200}, Ino: 42, Dev: 9, Uid: 1000, Gid: 1000, Size: 5}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(seen, ",") != "a.txt,dir/twelve-chars" {
		t.Fatalf("visited %v", seen)
	}
	if len(out) != len(in) {
		t.Fatalf("length %d, want %d", len(out), len(in))
	}
	first := out[12:]
	for at, want := range map[int]uint32{0: 200, 8: 100, 12: 7, 16: 9, 20: 42, 28: 1000, 32: 1000, 36: 5} {
		if got := binary.BigEndian.Uint32(first[at:]); got != want {
			t.Errorf("field at %d = %d, want %d", at, got, want)
		}
	}
	// The object id, the extension and a valid checksum survive.
	if !bytes.Equal(first[entryStatBytes:entryStatBytes+sha1.Size], bytes.Repeat([]byte{0xab}, sha1.Size)) {
		t.Error("object id changed")
	}
	if !bytes.Contains(out, ext) {
		t.Error("extension lost")
	}
	sum := sha1.Sum(out[:len(out)-sha1.Size])
	if !bytes.Equal(sum[:], out[len(out)-sha1.Size:]) {
		t.Error("checksum not recomputed")
	}
}

func TestRewriteIndexRefusals(t *testing.T) {
	keep := func(string, uint32) (*unix.Stat_t, error) { return nil, nil }
	good := indexOf([]string{"a"}, nil)
	corrupt := append([]byte(nil), good...)
	corrupt[20] ^= 1
	v4 := append([]byte(nil), good...)
	binary.BigEndian.PutUint32(v4[4:], 4)
	sum := sha1.Sum(v4[:len(v4)-sha1.Size])
	copy(v4[len(v4)-sha1.Size:], sum[:])
	for name, data := range map[string][]byte{"checksum": corrupt, "version 4": v4, "not an index": []byte("hello, world, this is not an index")} {
		if _, err := rewriteIndex(data, sha1.Size, keep); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := rewriteIndex(good, 31, keep); err == nil {
		t.Error("an object id length of 31 was accepted")
	}
}

// A real build: git accepts the rewritten index, finds the tree clean
// without hashing, and every file is older than the index.
func TestBackdateTreeWithGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(env []string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Env = append(os.Environ(), append([]string{"GIT_CONFIG_NOSYSTEM=1", "HOME=" + dir, "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@a"}, env...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	repo := filepath.Join(dir, "repo")
	run(nil, "init", "-q", repo)
	for name, body := range map[string]string{"a.txt": "a", "sub/b.txt": "bb", "link": ""} {
		p := filepath.Join(repo, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if name == "link" {
			_ = os.Symlink("a.txt", p)
		} else {
			_ = os.WriteFile(p, []byte(body), 0o644)
		}
	}
	run(nil, "-C", repo, "add", "-A")
	run(nil, "-C", repo, "commit", "-qm", "c")
	commit := run(nil, "-C", repo, "rev-parse", "HEAD")

	tree, index := filepath.Join(dir, "tree"), filepath.Join(dir, "index")
	_ = os.Mkdir(tree, 0o755)
	env := []string{"GIT_DIR=" + filepath.Join(repo, ".git"), "GIT_WORK_TREE=" + tree, "GIT_INDEX_FILE=" + index}
	run(env, "-c", "index.version=2", "read-tree", "-u", "--reset", commit)
	at := time.Now().Add(-2 * time.Second)
	if err := backdateTree(index, tree, sha1.Size, at); err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	_ = unix.Lstat(filepath.Join(tree, "sub/b.txt"), &st)
	if st.Mtim.Sec != at.Unix() {
		t.Errorf("mtime %d, want %d", st.Mtim.Sec, at.Unix())
	}
	// No entry is racy, and nothing differs from the index.
	run(env, "diff-files", "--quiet")
	if out := run(env, "status", "--porcelain", "--untracked-files=no"); out != "" {
		t.Errorf("status: %q", out)
	}
	if run(env, "write-tree") != run(nil, "-C", repo, "rev-parse", "HEAD^{tree}") {
		t.Error("write-tree differs from the commit's tree")
	}
}
