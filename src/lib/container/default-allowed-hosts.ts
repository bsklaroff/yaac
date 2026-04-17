import type { YaacConfig } from '@/types'

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
  'claude.ai',
  'downloads.claude.ai',

  // OpenAI services
  'api.openai.com',
  'openai.com',
  'cdn.openai.com',
  'auth.openai.com',
  'chatgpt.com',
  'ab.chatgpt.com',

  // Version control — GitHub
  'github.com',
  'www.github.com',
  'api.github.com',
  'cli.github.com',
  'npm.pkg.github.com',
  'raw.githubusercontent.com',
  'pkg-npm.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
  'avatars.githubusercontent.com',
  'camo.githubusercontent.com',
  'gist.github.com',

  // Version control — GitLab & Bitbucket
  'gitlab.com',
  'www.gitlab.com',
  'registry.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org',
  'api.bitbucket.org',

  // Container registries
  'registry-1.docker.io',
  'auth.docker.io',
  'index.docker.io',
  'hub.docker.com',
  'www.docker.com',
  'production.cloudflare.docker.com',
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

/** Check if a hostname matches a pattern (exact, *.suffix, or interior wildcard). */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true
  if (!pattern.includes('*')) return false
  if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
    const suffix = pattern.slice(1) // e.g. ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  // Interior or multi-segment wildcard: match segment-by-segment
  const patternParts = pattern.split('.')
  const hostParts = hostname.split('.')
  if (patternParts.length !== hostParts.length) return false
  return patternParts.every((p, i) => p === '*' || p === hostParts[i])
}

const CRITICAL_HOSTS = [
  { host: 'api.anthropic.com', label: 'Anthropic API' },
  { host: 'github.com', label: 'GitHub' },
]

/**
 * Resolve the effective allowed hosts list from project config.
 *
 * - Neither field set → DEFAULT_ALLOWED_HOSTS
 * - addAllowedUrls → DEFAULT_ALLOWED_HOSTS + additional
 * - setAllowedUrls → replaces defaults entirely
 */
export function resolveAllowedHosts(config: YaacConfig): string[] {
  if (config.addAllowedUrls && config.setAllowedUrls) {
    throw new Error('addAllowedUrls and setAllowedUrls are mutually exclusive')
  }

  let resolved: string[]
  if (config.setAllowedUrls) {
    resolved = config.setAllowedUrls
  } else if (config.addAllowedUrls) {
    resolved = [...DEFAULT_ALLOWED_HOSTS, ...config.addAllowedUrls]
  } else {
    resolved = DEFAULT_ALLOWED_HOSTS
  }

  // Warn if critical hosts are not reachable
  if (resolved.length === 1 && resolved[0] === '*') {
    return resolved
  }

  for (const { host, label } of CRITICAL_HOSTS) {
    const isAllowed = resolved.some((pattern) => hostMatchesPattern(host, pattern))
    if (!isAllowed) {
      console.warn(
        `Warning: ${label} (${host}) is not in the allowed URL list. ` +
        'Sessions may not function correctly without access to this host.',
      )
    }
  }

  return resolved
}
