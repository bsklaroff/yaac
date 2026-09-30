import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { workspaceBinDir } from '#domain/workspaces/workspace-bin'

/**
 * Runs the shipped `yaac-watch-prs` script with `--once` against a stub `gh`
 * on PATH. YAAC_WATCH_PRS_WORKDIR and YAAC_WATCH_PRS_STATE keep it off
 * /workspace and the real seen-state.
 *
 * A failed poll must be skipped with a note on stderr, not turned into
 * events. Only stdout lines become notifications, so an API outage must
 * leave stdout empty (GitHub's 5xx JSON body would otherwise be iterated into
 * junk) and must not end the baseline pass, or every existing comment would
 * flood out as new once GitHub recovers.
 */
const SCRIPT = path.join(workspaceBinDir(), 'yaac-watch-prs')
const US = String.fromCharCode(31)
/** The on-disk "baseline pass finished" marker; mirrors BASELINE_MARK. */
const BASELINE_MARK = '#baselined'
/**
 * The script uses gh's built-in `--jq`, not jq. The stub gh uses the host's
 * jq to emulate it, so only the filter suite at the bottom needs jq.
 */
const HAS_JQ = spawnSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0

/**
 * Stub `gh`. It maps each call's argv to a fixture name and returns that
 * fixture's contents, so fixtures containing `$`, backticks or quotes stay
 * literal. `$FIXTURES` is the fixture dir; `$FAIL_KEYS` is a `:`-delimited
 * list of keys whose calls fail like an outage. It records its cwd in
 * `$FIXTURES/gh-cwd`, since that decides which repo gh infers.
 *
 * A `.txt` fixture is returned verbatim (the US-joined output of gh's
 * `--jq`). A `.json` fixture is run through the script's real `--jq` filter
 * via the host jq, so the filters are tested too.
 */
const GH_STUB = `#!/bin/sh
pwd > "$FIXTURES/gh-cwd"
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

  function run(args: string[], env: Record<string, string> = {}, cwd = tmpDir): Promise<Run> {
    return new Promise((resolve, reject) => {
      execFile('sh', [SCRIPT, ...args], {
        cwd,
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
        // A non-zero exit is a result; a signal kill or spawn failure is a
        // harness error.
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

  // gh infers the repo from its cwd. A containerless checkout is not at
  // /workspace, so the default is the top of the caller's current repo.
  it('runs gh from the top of the checkout it was started in', async () => {
    await seedBaseline()
    await fixtureLines('issue-comments', [['7', 'alice', '', 'looks good']])
    // git reports the physical path, and macOS's temp dir is a symlink.
    const repo = await fs.realpath(await fs.mkdtemp(path.join(tmpDir, 'repo-')))
    const sub = path.join(repo, 'packages', 'server')
    await fs.mkdir(sub, { recursive: true })
    expect(spawnSync('git', ['init', repo], { stdio: 'ignore' }).status).toBe(0)

    // An empty override counts as unset.
    const { stdout } = await run(
      ['--pr', '43', '--events', 'comment', '--once'],
      { YAAC_WATCH_PRS_WORKDIR: '' },
      sub,
    )
    expect(stdout).toBe('[comment] PR #43 by alice: looks good\n')
    expect((await fs.readFile(path.join(fixtures, 'gh-cwd'), 'utf8')).trim()).toBe(repo)
  })

  // Outside any repo (e.g. a Monitor command run from `/` in a pod), it
  // falls back to /workspace.
  it.skipIf(spawnSync('sh', ['-c', 'test -d /workspace']).status !== 0)(
    'falls back to /workspace when the cwd is in no repo', async () => {
      await seedBaseline()
      await fixtureLines('issue-comments', [['7', 'alice', '', 'looks good']])

      // tmpDir is a bare temp dir under no git repo.
      await run(['--pr', '43', '--events', 'comment', '--once'], { YAAC_WATCH_PRS_WORKDIR: '' })
      expect((await fs.readFile(path.join(fixtures, 'gh-cwd'), 'utf8')).trim()).toBe('/workspace')
    },
  )

  // The user's host may lack jq, so the script must never call or probe for
  // it. A jq stub that always fails proves nothing calls it; the source check
  // catches a `command -v jq` probe, which a present stub would satisfy.
  it('needs no jq of its own — gh --jq only', async () => {
    await seedBaseline()
    await fixtureLines('issue-comments', [['7', 'alice', '', 'looks good']])
    await fs.writeFile(
      path.join(binDir, 'jq'),
      '#!/bin/sh\necho "jq: not installed" >&2\nexit 127\n',
      { mode: 0o755 },
    )

    const { stdout, code } = await run(['--pr', '43', '--events', 'comment', '--once'])
    expect(code).toBe(0)
    expect(stdout).toBe('[comment] PR #43 by alice: looks good\n')

    const body = (await fs.readFile(SCRIPT, 'utf8'))
      .split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
      .replaceAll('--jq', '')
    expect(body).not.toMatch(/\bjq\b/)
  })

  it('skips the poll — no stdout — when the comment API calls fail', async () => {
    await seedBaseline()
    const fail = { FAIL_KEYS: 'issue-comments:review-comments:reviews' }

    const { stdout, stderr, code } = await run(
      ['--pr', '43', '--events', 'comment', '--once'], fail,
    )
    expect(code).toBe(0)
    expect(stdout).toBe('')
    // Skipped with a note per source plus gh's own error on stderr.
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

  // A failed open-PR listing aborts the poll, while a failed opened-events
  // query skips only its block, so their stderr notes must differ.
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
    // What iterating an error object's values produces: rows with empty
    // author and body fields.
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

  // The baseline pass keeps a new watcher from replaying history. If it
  // ended on a failed poll, nothing would be marked seen and recovery would
  // flood stale notifications.
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

    // A new comment still surfaces afterwards.
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

  // Feed the stub GitHub-shaped JSON and run the script's own `--jq` filters
  // over it with the host's jq.
  describe.skipIf(!HAS_JQ)(
    'the shipped jq filters', () => {
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
        // `user` can be null (deleted GitHub Apps, some legacy reviews); jq
        // renders null.login as "", which the author guard would drop.
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
        // An outage's `{"message": …}` body run through a `.[]` filter.
        // Whether jq errors or yields junk, no event may escape.
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
