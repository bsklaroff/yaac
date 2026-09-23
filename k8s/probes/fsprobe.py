#!/usr/bin/env python3
"""POSIX filesystem semantics probe.

Usage: fsprobe.py <dir>
Exercises the operations the multi-node storage plan calls out for the
NFS-under-gVisor spike: creation ownership, O_EXCL, atomic rename,
hardlinks, and fcntl/flock locking.
"""
import errno
import fcntl
import os
import struct
import sys
import time

root = sys.argv[1]
base = os.path.join(root, "fsprobe-%d" % os.getpid())
os.makedirs(base, exist_ok=True)

results = []


def check(name, fn):
    try:
        detail = fn()
        results.append(("PASS", name, detail or ""))
    except Exception as e:
        results.append(("FAIL", name, "%s: %s" % (type(e).__name__, e)))


def t_ownership():
    p = os.path.join(base, "owned")
    with open(p, "w") as f:
        f.write("x")
    st = os.stat(p)
    want = (os.getuid(), os.getgid())
    got = (st.st_uid, st.st_gid)
    if got != want:
        raise AssertionError("created as %s, process is %s" % (got, want))
    return "uid/gid %d/%d preserved" % got


def t_oexcl():
    p = os.path.join(base, "excl")
    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o644)
    os.close(fd)
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o644)
        os.close(fd)
        raise AssertionError("second O_EXCL create succeeded (not exclusive)")
    except FileExistsError:
        pass
    return "second create correctly EEXIST"


def t_rename():
    src = os.path.join(base, "rn-src")
    dst = os.path.join(base, "rn-dst")
    with open(src, "w") as f:
        f.write("payload-A")
    with open(dst, "w") as f:
        f.write("payload-B")
    os.rename(src, dst)  # atomic replace over an existing file
    with open(dst) as f:
        got = f.read()
    if got != "payload-A":
        raise AssertionError("rename left %r" % got)
    if os.path.exists(src):
        raise AssertionError("source still present after rename")
    return "atomic replace-over-existing OK"


def t_hardlink():
    a = os.path.join(base, "link-a")
    b = os.path.join(base, "link-b")
    with open(a, "w") as f:
        f.write("shared-inode")
    os.link(a, b)
    sa, sb = os.stat(a), os.stat(b)
    if sa.st_ino != sb.st_ino:
        raise AssertionError("inode differs: %d vs %d" % (sa.st_ino, sb.st_ino))
    if sa.st_nlink != 2:
        raise AssertionError("nlink is %d, expected 2" % sa.st_nlink)
    # mutate through one name, observe through the other
    with open(b, "w") as f:
        f.write("mutated")
    with open(a) as f:
        if f.read() != "mutated":
            raise AssertionError("hardlink names not sharing data")
    os.unlink(b)
    if os.stat(a).st_nlink != 1:
        raise AssertionError("nlink did not drop after unlink")
    return "link(2), shared inode, nlink accounting OK"


def t_fcntl_lock():
    p = os.path.join(base, "lockfile")
    fd = os.open(p, os.O_CREAT | os.O_RDWR, 0o644)
    # F_SETLK a write lock on the whole file
    lk = struct.pack("hhllhh", fcntl.F_WRLCK, 0, 0, 0, 0, 0)
    fcntl.fcntl(fd, fcntl.F_SETLK, lk)
    # A second fd in this same process/sandbox: POSIX locks are per-process,
    # so re-locking from the same pid succeeds. Fork to get a real conflict.
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            fd2 = os.open(p, os.O_RDWR)
            fcntl.fcntl(fd2, fcntl.F_SETLK, lk)
            os.write(w, b"acquired")
        except OSError as e:
            if e.errno in (errno.EACCES, errno.EAGAIN):
                os.write(w, b"blocked")
            else:
                os.write(w, b"err:%d" % e.errno)
        os._exit(0)
    os.close(w)
    out = os.read(r, 64)
    os.waitpid(pid, 0)
    os.close(fd)
    if out != b"blocked":
        raise AssertionError("child got %r, expected conflict" % out)
    return "F_SETLK conflict observed across processes"


def t_flock():
    p = os.path.join(base, "flockfile")
    fd = os.open(p, os.O_CREAT | os.O_RDWR, 0o644)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            fd2 = os.open(p, os.O_RDWR)
            fcntl.flock(fd2, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.write(w, b"acquired")
        except OSError:
            os.write(w, b"blocked")
        os._exit(0)
    os.close(w)
    out = os.read(r, 64)
    os.waitpid(pid, 0)
    os.close(fd)
    if out != b"blocked":
        raise AssertionError("child got %r, expected conflict" % out)
    return "LOCK_EX conflict observed across processes"


def t_fsync_durability():
    p = os.path.join(base, "fsynced")
    fd = os.open(p, os.O_CREAT | os.O_WRONLY, 0o644)
    os.write(fd, b"durable")
    os.fsync(fd)
    os.close(fd)
    return "write+fsync returned cleanly"


def t_mmap_shared():
    import mmap
    p = os.path.join(base, "mmapped")
    with open(p, "wb") as f:
        f.write(b"\0" * 4096)
    with open(p, "r+b") as f:
        m = mmap.mmap(f.fileno(), 4096)
        m[0:5] = b"hello"
        m.flush()
        m.close()
    with open(p, "rb") as f:
        if f.read(5) != b"hello":
            raise AssertionError("MAP_SHARED write did not land")
    return "MAP_SHARED write-back OK"


def t_append():
    p = os.path.join(base, "appendlog")
    for i in range(10):
        with open(p, "a") as f:
            f.write("line-%d\n" % i)
    with open(p) as f:
        n = len(f.readlines())
    if n != 10:
        raise AssertionError("expected 10 lines, got %d" % n)
    return "O_APPEND sequence intact"


def t_symlink():
    tgt = os.path.join(base, "sym-target")
    lnk = os.path.join(base, "sym-link")
    with open(tgt, "w") as f:
        f.write("target-data")
    os.symlink("sym-target", lnk)
    with open(lnk) as f:
        if f.read() != "target-data":
            raise AssertionError("symlink did not resolve")
    if os.readlink(lnk) != "sym-target":
        raise AssertionError("readlink mismatch")
    return "symlink create/resolve OK"


def t_xattr_user():
    p = os.path.join(base, "xattrfile")
    with open(p, "w") as f:
        f.write("x")
    try:
        os.setxattr(p, "user.probe", b"v1")
    except OSError as e:
        raise AssertionError("setxattr user.* failed: %s" % e)
    got = os.getxattr(p, "user.probe")
    if got != b"v1":
        raise AssertionError("readback %r" % got)
    return "user.* xattr round-trip OK"


for name, fn in [
    ("creation ownership (uid passthrough)", t_ownership),
    ("O_EXCL exclusive create", t_oexcl),
    ("atomic rename over existing", t_rename),
    ("hardlink / link(2)", t_hardlink),
    ("fcntl POSIX lock (F_SETLK)", t_fcntl_lock),
    ("flock (LOCK_EX)", t_flock),
    ("write + fsync", t_fsync_durability),
    ("mmap MAP_SHARED write-back", t_mmap_shared),
    ("O_APPEND sequence", t_append),
    ("symlink create/resolve", t_symlink),
    ("user.* xattr", t_xattr_user),
]:
    check(name, fn)

width = max(len(n) for _, n, _ in results)
fails = 0
for status, name, detail in results:
    if status == "FAIL":
        fails += 1
    print("%-4s  %-*s  %s" % (status, width, name, detail))
print("\n%d/%d passed" % (len(results) - fails, len(results)))
sys.exit(1 if fails else 0)
