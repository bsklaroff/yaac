import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installOmpWrapper } from '../omp-homes.js'

/**
 * Installs the wrapper over a prefix laid out as the image and the
 * containerless install leave omp's binary, with a stand-in binary that
 * prints the homes it was given and, for `--help`, "unpacks" the add-on
 * variant it is told to the way omp does, on a CPU that cannot load the
 * modern one. Then moves the prefix, as the containerless install renames
 * its staging prefix.
 */
describe('installOmpWrapper', () => {
  let dir: string
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  /** `unpacks`: the variants it writes when asked to. */
  const standIn = (unpacks: string[]): string => `#!/bin/sh
if [ "$1" = --help ]; then
  variant=\${PI_NATIVE_VARIANT:-baseline}
  case " ${unpacks.join(' ')} " in *" $variant "*)
    mkdir -p "$PI_NATIVES_DIR/1.0.0" && (umask 022; : > "$PI_NATIVES_DIR/1.0.0/addon-$variant.node") ;;
  esac
  [ "$variant" != modern ] || { echo 'cannot load modern' >&2; exit 1; }
  [ -z "$FAIL" ] || { echo "$FAIL" >&2; exit 1; }
  exit 0
fi
echo "$PI_CODING_AGENT_DIR|$PI_CODING_AGENT_SESSION_DIR|$PI_NATIVES_DIR|$*"
`
  const stage = (unpacks = ['modern', 'baseline']): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-omp-homes-'))
    dirs.push(dir)
    const binary = path.join(dir, 'staging', 'lib', 'omp', 'omp')
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, standIn(unpacks), { mode: 0o755 })
    return binary
  }

  it('hands omp the agent dir a workspace names for it and the add-on unpacked beside it, from wherever the prefix ends up', () => {
    installOmpWrapper(stage())
    const prefix = path.join(dir, 'prefix')
    fs.renameSync(path.join(dir, 'staging'), prefix)
    const omp = path.join(prefix, 'bin', 'omp')
    const natives = path.join(prefix, 'lib', 'omp', 'natives')

    // Both x64 variants are unpacked at install, group-writable, since a
    // pod at another uid cannot unpack the one its CPU picks.
    expect(fs.readdirSync(path.join(natives, '1.0.0')).sort()).toEqual(['addon-baseline.node', 'addon-modern.node'])
    for (const f of ['', '1.0.0', '1.0.0/addon-modern.node']) {
      expect(fs.statSync(path.join(natives, f)).mode & 0o020, f).not.toBe(0)
    }

    const run = (env: Record<string, string>): string =>
      execFileSync(omp, ['acp', '--model', 'a b'], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
    const pi = { PI_CODING_AGENT_DIR: '/pi', PI_CODING_AGENT_SESSION_DIR: '/pi-sessions' }
    const [agentDir, sessionDir, nativesDir, args] = run({ ...pi, YAAC_OMP_AGENT_DIR: '/omp/agent' }).trimEnd().split('|')
    // omp then keeps its logs under its agent dir, where its acp server
    // looks for a conversation to load.
    expect([agentDir, sessionDir, args]).toEqual(['/omp/agent', '', 'acp --model a b'])
    // omp ignores a relative natives dir and unpacks into its home instead.
    expect(path.isAbsolute(nativesDir)).toBe(true)
    expect(fs.realpathSync(nativesDir)).toBe(fs.realpathSync(natives))
    // Outside a workspace nothing names omp's homes, and nothing changes.
    expect(run(pi)).toMatch(/^\/pi\|\/pi-sessions\|/)
    // Through PATH, as yaac's launches and a terminal run it, and by a
    // relative path.
    for (const [command, cwd] of [['omp x', dir], ['prefix/bin/omp x', dir]]) {
      const out = execFileSync('sh', ['-c', command], {
        cwd,
        env: { PATH: `${path.dirname(omp)}:${process.env.PATH ?? ''}`, YAAC_OMP_AGENT_DIR: '/omp/agent' },
        encoding: 'utf8',
      }).trimEnd().split('|')
      expect(out[0], command).toBe('/omp/agent')
      expect(fs.realpathSync(out[2]), command).toBe(fs.realpathSync(natives))
    }

    // A second run (a reinstall over it) leaves the same wrapper.
    const first = fs.readFileSync(omp, 'utf8')
    installOmpWrapper(path.join(prefix, 'lib', 'omp', 'omp'))
    expect(fs.readFileSync(omp, 'utf8')).toBe(first)
  })

  it('fails the install when omp leaves out an add-on, rather than leaving a pod to unpack one', () => {
    expect(() => installOmpWrapper(stage([]))).toThrow(/unpacked no \S+ native add-on/)
    // On x64 a pod whose CPU lacks AVX2 could not load omp without baseline.
    if (process.arch === 'x64') expect(() => installOmpWrapper(stage(['modern']))).toThrow(/unpacked no \*-baseline\.node/)
    // Builds other than linux glibc embed baseline alone.
    expect(() => installOmpWrapper(stage(['baseline']))).not.toThrow()
  })

  it('fails the install with omp\'s own words when it cannot run here', () => {
    process.env.FAIL = 'version GLIBC_2.99 not found'
    try {
      expect(() => installOmpWrapper(stage())).toThrow(/omp --help failed: version GLIBC_2\.99 not found/)
    } finally {
      delete process.env.FAIL
    }
  })
})
