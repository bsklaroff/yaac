/**
 * The step the builder appends to every untrusted Dockerfile
 * (docs/arbitrary-uid-images.md "The normalize step"). A pod may run as any
 * uid and reaches the image's files through group 0, so after the
 * Dockerfile's last instruction this step gives everything under
 * /home/yaac to yaac, group 0, with the owner's bits for the group, and does
 * the same for files yaac owns elsewhere. It covers what the base image's
 * umask cannot: installers that pick their own modes, exec-form `RUN`s, a
 * Dockerfile with its own `SHELL`, and a `COPY` with no `--chown`.
 *
 * It runs as root through sudo when the final user has it, else as that
 * user, fixing what it owns. Only paths that need a change are touched, and
 * they are printed with their size, since fixing a file in a later layer
 * copies it; its own list file is left out of the search. A shebang keeps
 * the Dockerfile's own `SHELL` out of it, and octal `-perm` and `du -k`
 * keep it portable to busybox.
 *
 * Its text is part of every untrusted layer's tag (image-tags.ts), so a
 * change to it rebuilds them.
 */
export const NORMALIZE_STEP = `
# yaac: make the image usable at any uid (docs/arbitrary-uid-images.md)
RUN <<'YAAC_NORMALIZE'
#!/bin/sh
set -eu
if ! id -u yaac >/dev/null 2>&1; then echo 'yaac normalize: no yaac user, nothing to do'; exit 0; fi
as=
if [ "$(id -u)" != 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then as='sudo -n'
  else echo "yaac normalize: no sudo, so only what $(id -un) owns is fixed"; fi
fi
list=$(mktemp)
mismatch='( ! -group 0 -o ( -perm -0400 ! -perm -0040 ) -o ( -perm -0200 ! -perm -0020 ) -o ( -perm -0100 ! -perm -0010 ) )'
# shellcheck disable=SC2086
$as find /home/yaac -xdev ! -type l ! -path "$list" \\( ! -user yaac -o $mismatch \\) -print0 > "$list" 2>/dev/null || true
# shellcheck disable=SC2086
$as find / -xdev -path /home/yaac -prune -o ! -type l ! -path "$list" -user yaac $mismatch -print0 >> "$list" 2>/dev/null || true
n=$(tr -cd '\\000' < "$list" | wc -c | tr -d ' ')
if [ "$n" = 0 ]; then echo 'yaac normalize: nothing to fix'; rm -f "$list"; exit 0; fi
kib=$(xargs -0 du -ck < "$list" 2>/dev/null | tail -n 1 | cut -f 1)
echo "yaac normalize: fixing $n path(s), $kib KiB. Add --chown to the COPY or fix modes in the step that wrote them to avoid the copy:"
tr '\\000' '\\n' < "$list" | head -n 50
[ "$n" -le 50 ] || echo "... and $((n - 50)) more"
$as xargs -0 chown -h yaac:0 < "$list" 2>/dev/null || echo 'yaac normalize: some paths could not be given to yaac'
$as xargs -0 chmod g=u < "$list" 2>/dev/null || echo 'yaac normalize: some modes could not be changed'
rm -f "$list"
YAAC_NORMALIZE
`
