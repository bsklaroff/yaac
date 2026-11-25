package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"

	"yaac-mountd/internal/wire"
)

func TestCleanRel(t *testing.T) {
	for _, ok := range []string{"a", "a/b", "projects/p/trees/w/l/tree", ""} {
		if _, err := cleanRel(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"/abs", "..", "../x", "a/../b", "a//b", "a/", "./a"} {
		if _, err := cleanRel(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A symlink a workspace planted in a folder it owns never redirects a path
// opened beneath a root: not as the last component, not on the way.
func TestOpenBeneathRefusesLinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "real/inner"), 0o755)
	_ = os.Symlink(outside, filepath.Join(root, "real/escape"))
	_ = os.Symlink("inner", filepath.Join(root, "real/sibling"))
	rootFd, err := openRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(rootFd)
	if fd, err := openBeneath(rootFd, "real/inner", unix.O_PATH); err != nil {
		t.Errorf("a plain path refused: %v", err)
	} else {
		unix.Close(fd)
	}
	for _, p := range []string{"real/escape", "real/escape/x", "real/sibling", "../" + filepath.Base(outside)} {
		if fd, err := openBeneath(rootFd, p, unix.O_PATH); err == nil {
			unix.Close(fd)
			t.Errorf("%q opened", p)
		}
	}
}

func TestMkdirAllOwned(t *testing.T) {
	root := t.TempDir()
	rootFd, _ := openRoot(root)
	defer unix.Close(rootFd)
	fd, err := mkdirAllOwned(rootFd, "a/b/c", os.Getuid(), os.Getgid())
	if err != nil {
		t.Fatal(err)
	}
	unix.Close(fd)
	if st, err := os.Stat(filepath.Join(root, "a/b/c")); err != nil || !st.IsDir() {
		t.Fatalf("not made: %v", err)
	}
	// A link on the way is refused, not followed.
	_ = os.Symlink(t.TempDir(), filepath.Join(root, "a/link"))
	if _, err := mkdirAllOwned(rootFd, "a/link/d", os.Getuid(), os.Getgid()); err == nil {
		t.Error("followed a link")
	}
}

func TestMountPointsUnder(t *testing.T) {
	info := filepath.Join(t.TempDir(), "mountinfo")
	_ = os.WriteFile(info, []byte(strings.Join([]string{
		"1 0 8:1 / / rw - ext4 /dev/sda1 rw",
		"2 1 8:1 /x /nm/pod.a rw - ext4 /dev/sda1 rw",
		"3 2 8:1 /y /nm/pod.a/0 rw - ext4 /dev/sda1 rw",
		"4 3 8:1 /z /nm/pod.a/0/deep\\040dir rw - ext4 /dev/sda1 rw",
		"5 1 8:1 /w /nm/pod.ab/0 rw - ext4 /dev/sda1 rw",
	}, "\n")+"\n"), 0o644)
	got, err := mountPointsUnder(info, "/nm/pod.a")
	if err != nil {
		t.Fatal(err)
	}
	want := "/nm/pod.a/0/deep dir,/nm/pod.a/0,/nm/pod.a"
	if strings.Join(got, ",") != want {
		t.Errorf("got %v, want %s", got, want)
	}
}

// Release removes what the mountd left in a directory one entry at a
// time. A mount the table still holds that cannot be undone stops it
// before anything is removed, and a directory that is not empty is left,
// never deleted through.
func TestReleaseDir(t *testing.T) {
	root := t.TempDir()
	pod := filepath.Join(root, "pod.a")
	_ = os.MkdirAll(filepath.Join(pod, "0"), 0o755)
	_ = os.WriteFile(filepath.Join(pod, wire.ListFile), []byte("{}"), 0o644)
	_ = os.WriteFile(filepath.Join(pod, "sandbox-bind"), nil, 0o644)
	info := filepath.Join(t.TempDir(), "mountinfo")

	// The table names a bind under it that this process cannot unmount.
	_ = os.WriteFile(info, []byte("1 0 8:1 / "+filepath.Join(pod, "0")+" rw - ext4 /dev/sda1 rw\n"), 0o644)
	if os.Getuid() != 0 {
		if err := releaseDir(info, root, "pod.a"); err == nil {
			t.Error("released over a bind it could not undo")
		}
		if _, err := os.Stat(filepath.Join(pod, wire.ListFile)); err != nil {
			t.Error("removed entries before the bind was undone")
		}
	}

	// With the table clear, a folder holding something stays, and is named.
	_ = os.WriteFile(info, nil, 0o644)
	_ = os.WriteFile(filepath.Join(pod, "0", "data"), []byte("x"), 0o644)
	if err := releaseDir(info, root, "pod.a"); err == nil || !strings.Contains(err.Error(), "0") {
		t.Errorf("err %v", err)
	}
	if _, err := os.Stat(filepath.Join(pod, "0", "data")); err != nil {
		t.Error("deleted through a folder that was not empty")
	}

	_ = os.Remove(filepath.Join(pod, "0", "data"))
	if err := releaseDir(info, root, "pod.a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pod); !os.IsNotExist(err) {
		t.Error("directory left")
	}
}
