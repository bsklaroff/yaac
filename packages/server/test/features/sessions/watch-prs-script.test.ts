import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { sessionBinDir } from '#features/sessions/spawn-script'

/**
 * The shipped `yaac-watch-prs` session-bin script, exercised for real: a temp
 * dir gets a stub `gh` on PATH and the script runs `--once` against it, with
 * YAAC_WATCH_PRS_WORKDIR and YAAC_WATCH_PRS_STATE keeping it off /workspace
 * and off the real seen-state.
 *
 * The contract under test is that a *failed* poll is skipped visibly on
 * stderr rather than turned into events. Only stdout lines become
 * notifications (the watcher drives the agent's Monitor tool), so an API
 * outage must leave stdout empty — GitHub answers 5xx with a JSON object,
 * which the `.[]` filters would otherwise iterate into empty-field junk — and
 * must not end the baseline pass, or every pre-existing comment floods out as
 * "new" once GitHub recovers.
 */
const SCRIPT = path.join(sessionBinDir(), 'yaac-watch-prs')
const US = String.fromCharCode(31)
/** The on-disk "baseline pass finished" marker; mirrors BASELINE_MARK. */
const BASELINE_MARK = '#baselined'
/** Probed the way the script itself does, so the skip below matches reality. */
const HAS_JQ = spawnSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0

/**
 * Stub `gh`. It keys each call off argv to a fixture name, and returns
 * whatever the test wrote there — no test data is interpolated into the
 * script, so a fixture containing `$`, a backtick or a quote stays literal.
 * `$FIXTURES` holds the fixture dir, `$FAIL_KEYS` a `:`-delimited list of
 * keys whose calls should fail the way an outage does.
 *
 * With a `.txt` fixture the stub returns its lines verbatim (the US-joined
 * shape gh's `--jq` would have produced). With a `.json` one it runs the
 * script's real `--jq` filter over it via the host jq, so the filters
 * themselves are under test too.
 */
const GH_STUB = `#!/bin/sh
key=unknown
case "$1" in
  api)
    case "$2" in
      *issues/*/comments*) key=issue-comments ;;
      *pulls/*/comments*) key=review-comments ;;
      *pulls/*/reviews*) key=reviews ;;
    esac ;;
  pr)
    case "$2" in
      list) case "$*" in
              *"--json number,headRefName"*) key=pr-list-full ;;
              *) key=pr-list ;;
            esac ;;
      view) key=commits ;;
    esac ;;
esac
case ":\${FAIL_KEYS:-}:" in
  *":$key:"*)
    echo "gh: HTTP 503: Service Unavailable (https://api.github.com)" >&2
    exit 1 ;;
esac
if [ -f "$FIXTURES/$key.txt" ]; then
  cat "$FIXTURES/$key.txt"
  exit 0
fi
if [ -f "$FIXTURES/$key.json" ]; then
  filter=""; prev=""
  for a in "$@"; do
    [ "$prev" = "--jq" ] && filter="$a"
    prev="$a"
  done
  jq -r "$filter" "$FIXTURES/$key.json"
  exit $?
fi
exit 0
`

type Run = { stdout: string; stderr: string; code: number }

describe('yaac-watch-prs script', () => {
  let tmpDir: string
  let binDir: string
  let fixtures: string
  let statePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-watch-prs-'))
    binDir = path.join(tmpDir, 'bin')
    fixtures = path.join(tmpDir, 'fixtures')
    statePath = path.join(tmpDir, 'seen')
    await fs.mkdir(binDir)
    await fs.mkdir(fixtures)
    await fs.writeFile(path.join(binDir, 'gh'), GH_STUB, { mode: 0o755 })
    // The script probes for jq at startup, but these tests' fixtures are
    // pre-rendered lines, so a no-op stub keeps them running on a host with
    // no jq. The filter block below drops it to reach the real one.
    await fs.writeFile(path.join(binDir, 'jq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** US-joined lines, as gh's `--jq` would emit them. */
  async function fixtureLines(key: string, lines: string[][]) {
    await fs.writeFile(
      path.join(fixtures, `${key}.txt`),
      lines.map((f) => `${f.join(US)}\n`).join(''),
    )
  }

  function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
      execFile('sh', [SCRIPT, ...args], {
        cwd: tmpDir,
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          YAAC_WATCH_PRS_STATE: statePath,
          YAAC_WATCH_PRS_WORKDIR: tmpDir,
          FIXTURES: fixtures,
          ...env,
        },
      }, (err, stdout, stderr) => {
        // A non-zero exit is a result to assert on; a signal kill (timeout)
        // or a spawn failure is a broken harness, not a script outcome.
        if (!err) return resolve({ stdout, stderr, code: 0 })
        const code = 'code' in err ? err.code : undefined
        if (typeof code !== 'number') {
          reject(new Error(`script did not exit normally: ${err.message}`))
        } else {
          resolve({ stdout, stderr, code })
        }
      })
    })
  }

  /** Mark the baseline pass done so the very next poll emits. */
  async function seedBaseline() {
    await fs.writeFile(statePath, `${BASELINE_MARK}\n`)
  }

  it('uses the baseline marker this test seeds', async () => {
    const source = await fs.readFile(SCRIPT, 'utf8')
    expect(source).toContain(`BASELINE_MARK='${BASELINE_MARK}'`)
  })

  it('emits a comment event for a successful poll', async () => {
    await seedBaseline()
    await fixtureLines('issue-comments', [['7', 'alice', '', 'looks good']])

    const { stdout, code } = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(code).toBe(0)
    expect(stdout).toBe('[comment] PR #43 by alice: looks good\n')
  })

  it('skips the poll — no stdout — when the comment API calls fail', async () => {
    await seedBaseline()
    const fail = { FAIL_KEYS: 'issue-comments:review-comments:reviews' }

    const { stdout, stderr, code } = await run(
      ['--pr', '43', '--events', 'comment', '--once'], fail,
    )
    expect(code).toBe(0)
    expect(stdout).toBe('')
    // Visibly skipped: our note per source plus gh's own error, on stderr.
    expect(stderr).toContain('gh api issues/43/comments failed; retrying next poll')
    expect(stderr).toContain('gh api pulls/43/reviews failed; retrying next poll')
    expect(stderr).toContain('HTTP 503')
  })

  it('skips the poll when the commit call fails', async () => {
    await seedBaseline()

    const { stdout, stderr } = await run(
      ['--pr', '43', '--events', 'commit', '--once'], { FAIL_KEYS: 'commits' },
    )
    expect(stdout).toBe('')
    expect(stderr).toContain('gh pr view #43 failed; retrying next poll')
  })

  // The two `gh pr list` calls have different consequences — the open-PR
  // listing aborts the whole poll, the opened-events one skips only its own
  // block — so their stderr notes have to be told apart.
  it('labels the open-PR listing and the opened-events query distinctly', async () => {
    await seedBaseline()

    const listing = await run(['--events', 'comment', '--once'], { FAIL_KEYS: 'pr-list' })
    expect(listing.stdout).toBe('')
    expect(listing.stderr).toContain('gh pr list (open PRs) failed; retrying next poll')

    const opened = await run(['--events', 'opened', '--once'], { FAIL_KEYS: 'pr-list-full' })
    expect(opened.stdout).toBe('')
    expect(opened.stderr).toContain('gh pr list (opened events) failed; retrying next poll')
  })

  it('drops records with no author or body even when gh exits 0', async () => {
    await seedBaseline()
    // What iterating an error object's values used to produce: fields present
    // positionally, but empty where a real comment has an author and a body.
    await fixtureLines('issue-comments', [['7', '', '', ''], ['', '', '', '']])

    const { stdout, code } = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('resumes emitting after a failed poll, without marking anything seen', async () => {
    await seedBaseline()
    await fixtureLines('issue-comments', [['7', 'alice', '', 'ping']])

    const failed = await run(
      ['--pr', '43', '--events', 'comment', '--once'], { FAIL_KEYS: 'issue-comments' },
    )
    expect(failed.stdout).toBe('')

    const { stdout } = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(stdout).toBe('[comment] PR #43 by alice: ping\n')
  })

  it('baselines the first run and emits only later events', async () => {
    await fixtureLines('issue-comments', [['7', 'alice', '', 'first']])
    const first = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(first.stdout).toBe('')

    await fixtureLines('issue-comments', [
      ['7', 'alice', '', 'first'],
      ['8', 'bob', 'src/a.ts', 'second'],
    ])
    const second = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(second.stdout).toBe('[comment] PR #43 by bob [src/a.ts]: second\n')
  })

  // The baseline pass is what keeps a fresh watcher from replaying history.
  // If it ends on a poll that never reached GitHub, nothing got marked seen,
  // and recovery turns into a burst of stale notifications.
  it('retries the baseline after an outage instead of flooding on recovery', async () => {
    await fixtureLines('issue-comments', [['7', 'alice', '', 'old comment']])

    const outage = await run(
      ['--pr', '43', '--events', 'comment', '--once'], { FAIL_KEYS: 'issue-comments' },
    )
    expect(outage.stdout).toBe('')
    expect(outage.stderr).toContain('baseline incomplete; retrying it next poll')
    expect(await fs.readFile(statePath, 'utf8')).not.toContain(BASELINE_MARK)

    // gh recovers: the pre-existing comment is baselined, not emitted.
    const recovered = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(recovered.stdout).toBe('')
    expect(await fs.readFile(statePath, 'utf8')).toContain(BASELINE_MARK)

    // ...and a genuinely new comment still surfaces afterwards.
    await fixtureLines('issue-comments', [
      ['7', 'alice', '', 'old comment'],
      ['8', 'bob', '', 'new comment'],
    ])
    const after = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(after.stdout).toBe('[comment] PR #43 by bob: new comment\n')
  })

  it('holds the baseline open when only one comment source failed', async () => {
    await fixtureLines('issue-comments', [['7', 'alice', '', 'old comment']])
    const partial = await run(
      ['--pr', '43', '--events', 'comment', '--once'], { FAIL_KEYS: 'reviews' },
    )
    expect(partial.stdout).toBe('')
    expect(await fs.readFile(statePath, 'utf8')).not.toContain(BASELINE_MARK)

    await fixtureLines('reviews', [['9', 'carol', 'APPROVED', 'ship it']])
    const complete = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(complete.stdout).toBe('')
    expect(await fs.readFile(statePath, 'utf8')).toContain(BASELINE_MARK)
  })

  // The jq filters live in the script, so feed the stub real GitHub-shaped
  // JSON and let it run the script's own `--jq` argument over it.
  describe.skipIf(!HAS_JQ)(
    'the shipped jq filters', () => {
      // Drop the no-op stub so the gh stub's `jq` resolves to the real one.
      beforeEach(async () => {
        await fs.rm(path.join(binDir, 'jq'))
      })

      async function fixtureJson(key: string, value: unknown) {
        await fs.writeFile(path.join(fixtures, `${key}.json`), JSON.stringify(value))
      }

      it('renders a comment, folding newlines and tagging inline paths', async () => {
        await seedBaseline()
        await fixtureJson('review-comments', [{
          id: 12, user: { login: 'alice' }, path: 'src/a.ts', body: 'line one\nline two',
        }])

        const { stdout } = await run(['--pr', '43', '--events', 'comment', '--once'])
        expect(stdout).toBe('[comment] PR #43 by alice [src/a.ts]: line one line two\n')
      })

      it('still emits a comment whose user is null, as ghost', async () => {
        await seedBaseline()
        // `user` is nullable on issue comments and reviews (deleted GitHub
        // Apps, some legacy reviews); jq renders null.login as "", which the
        // author guard would otherwise drop silently and forever.
        await fixtureJson('issue-comments', [{ id: 12, user: null, body: 'from a deleted app' }])

        const { stdout } = await run(['--pr', '43', '--events', 'comment', '--once'])
        expect(stdout).toBe('[comment] PR #43 by ghost: from a deleted app\n')
      })

      it('ignores comments with an empty body', async () => {
        await seedBaseline()
        await fixtureJson('issue-comments', [
          { id: 12, user: { login: 'alice' }, body: '' },
          { id: 13, user: { login: 'bob' }, body: 'real' },
        ])

        const { stdout } = await run(['--pr', '43', '--events', 'comment', '--once'])
        expect(stdout).toBe('[comment] PR #43 by bob: real\n')
      })

      it('emits nothing when the response is an error object, not a list', async () => {
        await seedBaseline()
        // The reported bug: an outage's `{"message": …}` body run through a
        // `.[]` filter. Whether jq errors or yields junk, no event may escape.
        await fixtureJson('issue-comments', {
          message: 'Server Error',
          documentation_url: 'https://docs.github.com/rest',
        })

        const { stdout, code } = await run(['--pr', '43', '--events', 'comment', '--once'])
        expect(stdout).toBe('')
        expect(code).toBe(0)
      })
    },
  )
})
