/**
 * The builder image outside of install: its content-hash tag, the digest
 * install recorded for it, and the buildkitd config its daemons start
 * with. Building and pushing it is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'
import {
  buildkitdConfig, dockerfileFrontendArgs, ensureBuilderImage, registryRef, resolveBuilderImageTag,
} from '#drivers/k8s/cluster'

beforeEach(() => {
  fakeRegistry.install()
})

describe('resolveBuilderImageTag', () => {
  it('tags the image by its build context, under the install or test prefix', async () => {
    const tag = await resolveBuilderImageTag()
    expect(tag).toMatch(/^yaac-buildkit:[0-9a-f]{16}$/)
    expect(await resolveBuilderImageTag('yaac-test')).toBe(tag.replace('yaac-', 'yaac-test-'))
  })
})

describe('ensureBuilderImage', () => {
  it('answers with the digest install recorded, and names install when it has none', async () => {
    const tag = await resolveBuilderImageTag()
    await expect(ensureBuilderImage()).rejects.toThrow(/builder image .* is missing.*yaac cluster install/)
    fakeRegistry.mirror(tag)
    await expect(ensureBuilderImage()).resolves
      .toBe(registryRef(`yaac-buildkit@${fakeRegistry.digestOf(tag)}`))
  })
})

describe('buildkitdConfig', () => {
  it('turns gateway frontends off and names its plain-HTTP registries', () => {
    const pod = buildkitdConfig({ plainHttp: ['r:5002'] })
    expect(pod).toContain('[frontend."gateway.v0"]\n  enabled = false')
    expect(pod).toContain('snapshotter = "overlayfs"')
    expect(pod).toContain('[registry."r:5002"]\n  http = true')
    // No daemon GC: a pod's state dies with it, and install prunes the
    // host daemon's.
    expect(pod).toContain('gc = false')
  })
})

describe('dockerfileFrontendArgs', () => {
  const check = (dockerfile: string): string | undefined => {
    const args = dockerfileFrontendArgs(dockerfile)
    expect(args.slice(0, 4)).toEqual(['--frontend', 'dockerfile.v0', '--opt', 'cmdline=dockerfile.v0'])
    return args.at(-1)?.replace(/^build-arg:BUILDKIT_DOCKERFILE_CHECK=/, '')
  }

  it('adds the BASE_IMAGE lint rule to the file\'s own check directive, keeping the rest of it', () => {
    const layered = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'
    expect(check(layered)).toBe('skip=InvalidDefaultArgInFrom')
    // BuildKit reads the directive only without the build-arg, so its error
    // and experimental settings and its own skips carry over.
    expect(check(`# check=error=true;experimental=all\n${layered}`))
      .toBe('error=true;experimental=all;skip=InvalidDefaultArgInFrom')
    expect(check(`# check=skip=\n${layered}`)).toBe('skip=InvalidDefaultArgInFrom')
    expect(check(`# check=skip=all\n${layered}`)).toBe('skip=all')
    // BuildKit cuts the value at its first space.
    expect(check(`\uFEFF#!/usr/bin/env buildctl\n# syntax=x\n#CHECK = skip=JSONArgsRecommended ; error=true\n${layered}`))
      .toBe('skip=JSONArgsRecommended,InvalidDefaultArgInFrom')
    expect(check(`# check=skip=all  # quiet\n${layered}`)).toBe('skip=all')
    // A part BuildKit refuses still reaches it.
    expect(check(`# check=error=maybe\n${layered}`)).toBe('error=maybe;skip=InvalidDefaultArgInFrom')
    // Directives end at the first line that is not one BuildKit knows, and
    // a `//` line is never one for `check`.
    for (const before of ['# a comment', '# foo=bar', '// syntax=x']) {
      expect(check(`${before}\n# check=error=true\n${layered}`)).toBe('skip=InvalidDefaultArgInFrom')
    }
    expect(check(`// check=error=true\n${layered}`)).toBe('skip=InvalidDefaultArgInFrom')
    expect(check(`${layered}# check=error=true\n`)).toBe('skip=InvalidDefaultArgInFrom')
  })
})
