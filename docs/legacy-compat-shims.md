# Legacy-compat shims in the tree

This lists the shims, backfills, compatibility windows and legacy prose that
exist only because an older install may still be out there. Each gets an
entry when it is added, so a cleanup pass starts from this list instead of a
grep, and shims with an ordering constraint are removed in the right order.

There is no version-floor scheme, and none is wanted: nothing records which
version last wrote a data dir or set up a cluster. Shims are deleted as they
come up. An install that skips many releases may lose data or need a manual
step. That cost is accepted, and the entries say which shims carry it.

Each entry says what the shim reads, what breaks silently if it is deleted
too early, and how to tell it is safe to remove, plus any required order.

No test can catch a shim going stale. The suite runs on a database and disk it
just created, where every shim is already a no-op, so a green run says nothing
about them. That is why this is a list and not a check.

There are no shims in the tree at present.
