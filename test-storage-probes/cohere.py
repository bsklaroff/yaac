#!/usr/bin/env python3
"""Observe how long an externally-made change takes to become visible.

Usage:
  cohere.py watch-content <file> <timeout_s>   # poll until file content changes
  cohere.py watch-appear  <dir> <name> <t_s>   # poll until a new dir entry appears
  cohere.py watch-vanish  <file> <timeout_s>   # poll until the file disappears
  cohere.py watch-size    <file> <timeout_s>   # poll until st_size changes

The external writer stamps time.time() into the file (or into a sidecar
'.stamp' for appear/vanish), so the printed delta is producer->consumer
visibility latency, not just poll overhead. Same host clock on both sides.
"""
import os
import sys
import time

op = sys.argv[1]

def stamp_of(text):
    try:
        return float(text.strip().split()[0])
    except Exception:
        return None

if op == "watch-content":
    path, timeout = sys.argv[2], float(sys.argv[3])
    with open(path) as f:
        before = f.read()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(path) as f:
                cur = f.read()
        except FileNotFoundError:
            cur = before
        # A writer that opens with "w" truncates before it writes, so a poll can
        # land in the window where the file is empty. That is not the change we
        # are timing; skip it rather than report a stampless observation.
        if cur != before and cur.strip():
            now = time.time()
            w = stamp_of(cur)
            print("OBSERVED after %.1f ms" % ((now - w) * 1000.0) if w
                  else "OBSERVED (no stamp)")
            sys.exit(0)
        time.sleep(0.001)
    print("TIMEOUT after %.1fs -- change never became visible" % timeout)
    sys.exit(1)

elif op == "watch-appear":
    d, name, timeout = sys.argv[2], sys.argv[3], float(sys.argv[4])
    deadline = time.time() + timeout
    while time.time() < deadline:
        if name in os.listdir(d):
            now = time.time()
            try:
                with open(os.path.join(d, name)) as f:
                    w = stamp_of(f.read())
            except Exception:
                w = None
            print("OBSERVED after %.1f ms" % ((now - w) * 1000.0) if w
                  else "OBSERVED (no stamp)")
            sys.exit(0)
        time.sleep(0.001)
    print("TIMEOUT after %.1fs -- new entry never appeared" % timeout)
    sys.exit(1)

elif op == "watch-vanish":
    path, timeout = sys.argv[2], float(sys.argv[3])
    stampf = path + ".stamp"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not os.path.exists(path):
            now = time.time()
            try:
                with open(stampf) as f:
                    w = stamp_of(f.read())
            except Exception:
                w = None
            print("OBSERVED after %.1f ms" % ((now - w) * 1000.0) if w
                  else "OBSERVED (no stamp)")
            sys.exit(0)
        time.sleep(0.001)
    print("TIMEOUT after %.1fs -- entry never disappeared" % timeout)
    sys.exit(1)

elif op == "watch-size":
    path, timeout = sys.argv[2], float(sys.argv[3])
    before = os.stat(path).st_size
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.stat(path).st_size != before:
            now = time.time()
            with open(path) as f:
                w = stamp_of(f.readlines()[-1])
            print("OBSERVED after %.1f ms" % ((now - w) * 1000.0) if w
                  else "OBSERVED (no stamp)")
            sys.exit(0)
        time.sleep(0.001)
    print("TIMEOUT after %.1fs -- size never changed" % timeout)
    sys.exit(1)
