import type { EgressAllowlist } from '@yaac/shared/types'
import { parseGitRemote } from '@yaac/shared/git-remote'

/*
 * The egress allowlist's default hosts and how a pattern matches a host
 * (docs/workspace-egress.md). Shared so the webapp can tell, before a repo
 * is added, whether the server will have to allow its host.
 */

// Default allowed host patterns for the proxy URL allowlist.
// Based on https://code.claude.com/docs/en/claude-code-on-the-web#default-allowed-domains

export const DEFAULT_ALLOWED_HOSTS: string[] = [
  // Anthropic services
  'api.anthropic.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'docs.claude.com',
  'platform.claude.com',
  'code.claude.com',
  'claude.com',
  'www.claude.com',
  'claude.ai',
  'downloads.claude.ai',

  // OpenAI services
  'api.openai.com',
  'openai.com',
  'cdn.openai.com',
  'auth.openai.com',
  'chatgpt.com',
  'ab.chatgpt.com',

  // OpenCode / OpenRouter / NeuralWatt / Pi / Oh My Pi
  'openrouter.ai',
  'api.neuralwatt.com',
  'opencode.ai',
  // v2's models.dev mirror, which it refreshes its catalog from in the background
  'models.opencode.ai',
  'pi.dev',
  // omp's model catalog, which it refreshes at startup
  'catalog.stencil.so',
  // Exa MCP — backs opencode's websearch tool
  'mcp.exa.ai',

  // Version control — GitHub
  'github.com',
  'www.github.com',
  'api.github.com',
  'uploads.github.com',
  'cli.github.com',
  'npm.pkg.github.com',
  'raw.githubusercontent.com',
  'pkg-npm.githubusercontent.com',
  'objects.githubusercontent.com',
  'pkg-containers.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
  'avatars.githubusercontent.com',
  'camo.githubusercontent.com',
  'gist.github.com',
  // Sigstore trust roots `gh attestation verify` fetches over TUF: GitHub's
  // own instance (private-repo attestations) and the public-good instance
  'tuf-repo.github.com',
  'tuf-repo-cdn.sigstore.dev',
  // Actions blob storage (job summaries and logs)
  'productionresultssa*.blob.core.windows.net',

  // Version control — GitLab & Bitbucket
  'gitlab.com',
  'www.gitlab.com',
  'registry.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org',
  'api.bitbucket.org',

  // Container registries
  'hub.docker.com',
  'www.docker.com',
  'download.docker.com',
  'podman.io',
  'gcr.io',
  '*.gcr.io',
  'ghcr.io',
  'mcr.microsoft.com',
  '*.data.mcr.microsoft.com',
  'public.ecr.aws',

  // Cloud platforms — Google
  'cloud.google.com',
  'accounts.google.com',
  'gcloud.google.com',
  '*.googleapis.com',
  'storage.googleapis.com',
  'compute.googleapis.com',
  'container.googleapis.com',

  // Cloud platforms — Azure / Microsoft
  'azure.com',
  'portal.azure.com',
  'microsoft.com',
  'www.microsoft.com',
  '*.microsoftonline.com',
  'packages.microsoft.com',
  'dotnet.microsoft.com',
  'dot.net',
  'visualstudio.com',
  'dev.azure.com',

  // Cloud platforms — AWS
  '*.amazonaws.com',
  '*.api.aws',

  // Cloud platforms — Oracle / Java
  'oracle.com',
  'www.oracle.com',
  'java.com',
  'www.java.com',
  'java.net',
  'www.java.net',
  'download.oracle.com',
  'yum.oracle.com',

  // JavaScript / Node package managers
  'registry.npmjs.org',
  'www.npmjs.com',
  'www.npmjs.org',
  'npmjs.com',
  'npmjs.org',
  'yarnpkg.com',
  'registry.yarnpkg.com',

  // Python package managers
  'pypi.org',
  'www.pypi.org',
  'files.pythonhosted.org',
  'pythonhosted.org',
  'test.pypi.org',
  'pypi.python.org',
  'pypa.io',
  'www.pypa.io',

  // Ruby package managers
  'rubygems.org',
  'www.rubygems.org',
  'api.rubygems.org',
  'index.rubygems.org',
  'ruby-lang.org',
  'www.ruby-lang.org',
  'rubyforge.org',
  'www.rubyforge.org',
  'rubyonrails.org',
  'www.rubyonrails.org',
  'rvm.io',
  'get.rvm.io',

  // Rust package managers
  'crates.io',
  'www.crates.io',
  'index.crates.io',
  'static.crates.io',
  'rustup.rs',
  'static.rust-lang.org',
  'www.rust-lang.org',

  // Go package managers
  'proxy.golang.org',
  'sum.golang.org',
  'index.golang.org',
  'golang.org',
  'www.golang.org',
  'goproxy.io',
  'pkg.go.dev',

  // JVM package managers
  'maven.org',
  'repo.maven.org',
  'central.maven.org',
  'repo1.maven.org',
  'repo.maven.apache.org',
  'jcenter.bintray.com',
  'gradle.org',
  'www.gradle.org',
  'services.gradle.org',
  'plugins.gradle.org',
  'kotlinlang.org',
  'www.kotlinlang.org',
  'spring.io',
  'repo.spring.io',

  // PHP Composer
  'packagist.org',
  'www.packagist.org',
  'repo.packagist.org',

  // .NET NuGet
  'nuget.org',
  'www.nuget.org',
  'api.nuget.org',

  // Dart / Flutter
  'pub.dev',
  'api.pub.dev',

  // Elixir / Erlang
  'hex.pm',
  'www.hex.pm',

  // Perl CPAN
  'cpan.org',
  'www.cpan.org',
  'metacpan.org',
  'www.metacpan.org',
  'api.metacpan.org',

  // iOS / macOS
  'cocoapods.org',
  'www.cocoapods.org',
  'cdn.cocoapods.org',

  // Haskell
  'haskell.org',
  'www.haskell.org',
  'hackage.haskell.org',

  // Swift
  'swift.org',
  'www.swift.org',

  // Linux distributions
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'ubuntu.com',
  'www.ubuntu.com',
  '*.ubuntu.com',
  'deb.debian.org',
  'ppa.launchpad.net',
  'launchpad.net',
  'www.launchpad.net',
  '*.nixos.org',
  'download.opensuse.org',

  // Kubernetes
  'dl.k8s.io',
  'pkgs.k8s.io',
  'k8s.io',
  'www.k8s.io',

  // HashiCorp
  'releases.hashicorp.com',
  'apt.releases.hashicorp.com',
  'rpm.releases.hashicorp.com',
  'archive.releases.hashicorp.com',
  'hashicorp.com',
  'www.hashicorp.com',

  // Anaconda / Conda
  'repo.anaconda.com',
  'conda.anaconda.org',
  'anaconda.org',
  'www.anaconda.com',
  'anaconda.com',
  'continuum.io',

  // Apache
  'apache.org',
  'www.apache.org',
  'archive.apache.org',
  'downloads.apache.org',

  // Eclipse
  'eclipse.org',
  'www.eclipse.org',
  'download.eclipse.org',

  // Node.js
  'nodejs.org',
  'www.nodejs.org',

  // Other dev tools
  'developer.apple.com',
  'developer.android.com',
  'developers.openai.com',
  'pkg.stainless.com',
  'binaries.prisma.sh',
  'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com',

  // Cloud services and monitoring
  'statsig.com',
  'www.statsig.com',
  'api.statsig.com',
  'sentry.io',
  '*.sentry.io',
  'downloads.sentry-cdn.com',
  'http-intake.logs.datadoghq.com',
  '*.datadoghq.com',
  '*.datadoghq.eu',
  'api.honeycomb.io',

  // Content delivery and mirrors
  'sourceforge.net',
  '*.sourceforge.net',
  'packagecloud.io',
  '*.packagecloud.io',
  'fonts.googleapis.com',
  'fonts.gstatic.com',

  // Schema and configuration
  'json-schema.org',
  'www.json-schema.org',
  'json.schemastore.org',
  'www.schemastore.org',

  // Model Context Protocol
  '*.modelcontextprotocol.io',

  // Container image storage
  'docker-images-prod.*.r2.cloudflarestorage.com',
]

/**
 * Check if a hostname matches a pattern: exact, `*.suffix`, or label by label
 * where a label is `*` or contains `*` (`productionresultssa*`), which stands
 * for `[a-z0-9_-]*` and never crosses a dot. The match is linear rather than a
 * regex, since a label is chosen by the workspace and patterns reach it
 * unvalidated. Keep in step with `hostMatches` in k8s/proxy/injection.ts,
 * which cannot import this module.
 */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true
  if (!pattern.includes('*')) return false
  if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
    const suffix = pattern.slice(1) // e.g. ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  const patternParts = pattern.split('.')
  const hostParts = hostname.split('.')
  if (patternParts.length !== hostParts.length) return false
  return patternParts.every((p, i) => labelMatches(hostParts[i], p))
}

function labelMatches(label: string, pattern: string): boolean {
  if (pattern === '*' || pattern === label) return true
  if (!pattern.includes('*') || !/^[a-z0-9_-]*$/.test(label)) return false
  const [first, ...rest] = pattern.split('*')
  const last = rest.pop()!
  if (label.length < first.length + last.length || !label.startsWith(first) || !label.endsWith(last)) return false
  let at = first.length
  for (const piece of rest) {
    at = label.indexOf(piece, at)
    if (at === -1 || at + piece.length > label.length - last.length) return false
    at += piece.length
  }
  return true
}

/** Whether a project's allowlist lets its workspaces reach `host` through
 *  an egress proxy. */
export function allowlistAllows(allowlist: EgressAllowlist, host: string): boolean {
  const allowed = [...(allowlist.defaults ? DEFAULT_ALLOWED_HOSTS : []), ...allowlist.hosts]
  const name = host.toLowerCase()
  return allowed.some((pattern) => pattern === '*' || hostMatchesPattern(name, pattern))
}

/**
 * The host of a git remote that `allowlist` leaves out, which linking the
 * repo adds to the project's allowlist (`allowRepoHost` on the server); null
 * when the list admits it or the remote names no literal hostname. A
 * literal name only, so the list can never be widened by a pattern such as
 * `*`.
 */
export function repoHostToAllow(allowlist: EgressAllowlist, remoteUrl: string): string | null {
  let host: string
  try {
    host = parseGitRemote(remoteUrl).host.toLowerCase()
  } catch {
    return null
  }
  return /^[a-z0-9._-]+$/.test(host) && !allowlistAllows(allowlist, host) ? host : null
}

const CRITICAL_HOSTS = [
  { host: 'api.anthropic.com', label: 'Anthropic API' },
  { host: 'github.com', label: 'GitHub' },
]

/**
 * Resolve a project's allowlist to the patterns the proxy enforces. A list
 * holding `*` keeps its other entries, since only an exact entry admits a
 * non-public destination (k8s/proxy/upstream.ts) and `*` never does.
 */
export function resolveAllowedHosts(allowlist: EgressAllowlist): string[] {
  const resolved = allowlist.defaults
    ? [...DEFAULT_ALLOWED_HOSTS, ...allowlist.hosts.filter((h) => !DEFAULT_ALLOWED_HOSTS.includes(h))]
    : [...allowlist.hosts]
  for (const { host, label } of missingCriticalHosts(allowlist)) {
    console.warn(
      `Warning: ${label} (${host}) is not in the allowed URL list. ` +
      'Sessions may not function correctly without access to this host.',
    )
  }

  return resolved
}

/** The hosts an agent session needs that a project's allowlist leaves
 *  out. */
export function missingCriticalHosts(allowlist: EgressAllowlist): typeof CRITICAL_HOSTS {
  return CRITICAL_HOSTS.filter(({ host }) => !allowlistAllows(allowlist, host))
}
