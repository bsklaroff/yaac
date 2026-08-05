#!/usr/bin/env python3
"""Try to take an exclusive lock without blocking. Usage: locktry.py <file> <mode>
Prints ACQUIRED (no conflicting lock was visible) or BLOCKED (conflict seen)."""
import errno, fcntl, os, struct, sys

path, mode = sys.argv[1], sys.argv[2]
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
try:
    if mode == "flock":
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    else:
        fcntl.fcntl(fd, fcntl.F_SETLK,
                    struct.pack("hhllhh", fcntl.F_WRLCK, 0, 0, 0, 0, 0))
    print("ACQUIRED")
except OSError as e:
    if e.errno in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK):
        print("BLOCKED")
    else:
        print("ERROR %s" % e)
