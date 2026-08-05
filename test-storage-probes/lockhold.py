#!/usr/bin/env python3
"""Take an exclusive lock on a file and hold it. Usage: lockhold.py <file> <mode> <seconds>
mode: flock | fcntl"""
import fcntl, os, struct, sys, time

path, mode, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
if mode == "flock":
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
else:
    fcntl.fcntl(fd, fcntl.F_SETLK, struct.pack("hhllhh", fcntl.F_WRLCK, 0, 0, 0, 0, 0))
print("HELD %s %s" % (mode, path), flush=True)
time.sleep(secs)
