import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import * as settingsModule from 'src/platform/settings/settings.js'
import * as gitAvailability from 'src/plugins/gitAvailability.js'
import {
  createPluginId,
  detectEmptyMarketplaceReason,
  extractHostFromSource,
  formatFailureDetails,
  formatMarketplaceLoadingErrors,
  formatSourceForDisplay,
  getBlockedMarketplaces,
  getHostPatternsFromAllowlist,
  getMarketplaceSourceDisplay,
  getPluginTrustMessage,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
  loadMarketplacesWithGracefulDegradation,
} from 'src/plugins/marketplaceHelpers.js'
import * as marketplaceManager from 'src/plugins/marketplaceManager.js'
import type { KnownMarketplace, MarketplaceSource } from 'src/plugins/schemas.js'

// Policy is read through getSettingsForSource('policySettings'); the spy below
// stands in for the managed-settings file so every case states the policy it
// runs under. Nothing here touches disk or the network.

type Policy = {
  strictKnownMarketplaces?: MarketplaceSource[]
  blockedMarketplaces?: MarketplaceSource[]
  pluginTrustMessage?: string
}

let policy: Policy | null = null
const spies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  policy = null
  spies.push(
    spyOn(settingsModule, 'getSettingsForSource').mockImplementation(source =>
      source === 'policySettings'
        ? (policy as ReturnType<typeof settingsModule.getSettingsForSource>)
        : null,
    ),
  )
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

const gh = (repo: string, extra: { ref?: string; path?: string } = {}): MarketplaceSource => ({
  source: 'github',
  repo,
  ...extra,
})
const git = (url: string, extra: { ref?: string; path?: string } = {}): MarketplaceSource => ({
  source: 'git',
  url,
  ...extra,
})
const url = (u: string): MarketplaceSource => ({ source: 'url', url: u })
const npm = (pkg: string): MarketplaceSource => ({ source: 'npm', package: pkg })
const file = (path: string): MarketplaceSource => ({ source: 'file', path })
const dir = (path: string): MarketplaceSource => ({ source: 'directory', path })
const hostPattern = (p: string): MarketplaceSource => ({ source: 'hostPattern', hostPattern: p })
const pathPattern = (p: string): MarketplaceSource => ({ source: 'pathPattern', pathPattern: p })
const settingsSrc = (name: string, plugins: unknown[] = []): MarketplaceSource =>
  ({ source: 'settings', name, plugins }) as unknown as MarketplaceSource

describe('formatFailureDetails', () => {
  const failures = [
    { name: 'a', reason: 'bad manifest' },
    { name: 'b', error: 'ENOENT' },
    { name: 'c' },
  ]

  test('with reasons: first two, "; "-joined, reason then error then a fallback', () => {
    expect(formatFailureDetails(failures, true)).toBe(
      'a (bad manifest); b (ENOENT) and 1 more',
    )
    expect(formatFailureDetails([{ name: 'c' }], true)).toBe('c (unknown error)')
  })

  test('without reasons: names only, ", "-joined', () => {
    expect(formatFailureDetails(failures, false)).toBe('a, b and 1 more')
    expect(formatFailureDetails(failures.slice(0, 2), false)).toBe('a, b')
  })
})

describe('getMarketplaceSourceDisplay', () => {
  test('shows the field that identifies each source type', () => {
    expect(getMarketplaceSourceDisplay(gh('o/r'))).toBe('o/r')
    expect(getMarketplaceSourceDisplay(url('https://x/m.json'))).toBe('https://x/m.json')
    expect(getMarketplaceSourceDisplay(git('https://x/r.git'))).toBe('https://x/r.git')
    expect(getMarketplaceSourceDisplay(dir('/d'))).toBe('/d')
    expect(getMarketplaceSourceDisplay(file('/f.json'))).toBe('/f.json')
    expect(getMarketplaceSourceDisplay(settingsSrc('inline'))).toBe('settings:inline')
    expect(getMarketplaceSourceDisplay(npm('pkg'))).toBe('Unknown source')
  })
})

describe('createPluginId', () => {
  test('is plugin@marketplace', () => {
    expect(createPluginId('lint', 'acme')).toBe('lint@acme')
  })
})

describe('formatMarketplaceLoadingErrors', () => {
  test('no failures is no message', () => {
    expect(formatMarketplaceLoadingErrors([], 3)).toBeNull()
  })

  test('a partial failure is a warning naming the one that failed', () => {
    expect(formatMarketplaceLoadingErrors([{ name: 'a', error: 'boom' }], 1)).toEqual({
      type: 'warning',
      message: "Warning: Failed to load marketplace 'a': boom",
    })
  })

  test('several partial failures are listed by name', () => {
    expect(
      formatMarketplaceLoadingErrors(
        [
          { name: 'a', error: 'x' },
          { name: 'b', error: 'y' },
        ],
        2,
      ),
    ).toEqual({ type: 'warning', message: 'Warning: Failed to load 2 marketplaces: a, b' })
  })

  test('when everything failed it is an error carrying every reason', () => {
    expect(
      formatMarketplaceLoadingErrors(
        [
          { name: 'a', error: 'x' },
          { name: 'b', error: 'y' },
        ],
        0,
      ),
    ).toEqual({
      type: 'error',
      message: 'Failed to load all marketplaces. Errors: a: x; b: y',
    })
  })
})

describe('policy accessors', () => {
  test('answer null / undefined when there is no policy', () => {
    expect(getStrictKnownMarketplaces()).toBeNull()
    expect(getBlockedMarketplaces()).toBeNull()
    expect(getPluginTrustMessage()).toBeUndefined()
    expect(getHostPatternsFromAllowlist()).toEqual([])
  })

  test('read the policySettings source', () => {
    policy = {
      strictKnownMarketplaces: [gh('o/r'), hostPattern('^ghe\\.example\\.com$')],
      blockedMarketplaces: [gh('bad/repo')],
      pluginTrustMessage: 'Ask IT first',
    }
    expect(getStrictKnownMarketplaces()).toEqual(policy.strictKnownMarketplaces!)
    expect(getBlockedMarketplaces()).toEqual([gh('bad/repo')])
    expect(getPluginTrustMessage()).toBe('Ask IT first')
    expect(getHostPatternsFromAllowlist()).toEqual(['^ghe\\.example\\.com$'])
  })

  test('an empty allowlist is a restriction, not "no policy"', () => {
    policy = { strictKnownMarketplaces: [] }
    expect(getStrictKnownMarketplaces()).toEqual([])
  })
})

describe('extractHostFromSource', () => {
  test('github shorthand is always github.com', () => {
    expect(extractHostFromSource(gh('o/r'))).toBe('github.com')
  })

  test('git: the SSH form and the HTTPS form', () => {
    expect(extractHostFromSource(git('git@ghe.corp.com:o/r.git'))).toBe('ghe.corp.com')
    expect(extractHostFromSource(git('https://gitlab.com/o/r.git'))).toBe('gitlab.com')
  })

  test('url: the hostname', () => {
    expect(extractHostFromSource(url('https://plugins.example.org/m.json'))).toBe(
      'plugins.example.org',
    )
  })

  test('null for an unparseable URL and for sources without a host', () => {
    expect(extractHostFromSource(git('not a url'))).toBeNull()
    expect(extractHostFromSource(url('::nope'))).toBeNull()
    expect(extractHostFromSource(npm('p'))).toBeNull()
    expect(extractHostFromSource(file('/f'))).toBeNull()
    expect(extractHostFromSource(dir('/d'))).toBeNull()
  })
})

describe('isSourceInBlocklist', () => {
  test('false with no blocklist', () => {
    expect(isSourceInBlocklist(gh('o/r'))).toBe(false)
  })

  test('a github entry without ref/path blocks every ref and path of that repo', () => {
    policy = { blockedMarketplaces: [gh('bad/repo')] }
    expect(isSourceInBlocklist(gh('bad/repo'))).toBe(true)
    expect(isSourceInBlocklist(gh('bad/repo', { ref: 'v1', path: 'sub' }))).toBe(true)
    expect(isSourceInBlocklist(gh('good/repo'))).toBe(false)
  })

  test('a github entry WITH a ref blocks only that ref', () => {
    policy = { blockedMarketplaces: [gh('bad/repo', { ref: 'v1' })] }
    expect(isSourceInBlocklist(gh('bad/repo', { ref: 'v1' }))).toBe(true)
    expect(isSourceInBlocklist(gh('bad/repo', { ref: 'v2' }))).toBe(false)
    expect(isSourceInBlocklist(gh('bad/repo'))).toBe(false)
  })

  test('a git URL to a blocked GitHub repo is caught (SSH and HTTPS, with or without .git)', () => {
    policy = { blockedMarketplaces: [gh('bad/repo')] }
    expect(isSourceInBlocklist(git('git@github.com:bad/repo.git'))).toBe(true)
    expect(isSourceInBlocklist(git('https://github.com/bad/repo.git'))).toBe(true)
    expect(isSourceInBlocklist(git('https://github.com/bad/repo'))).toBe(true)
    expect(isSourceInBlocklist(git('https://gitlab.com/bad/repo.git'))).toBe(false)
  })

  test('a git-to-github match still honors the blocked ref', () => {
    policy = { blockedMarketplaces: [gh('bad/repo', { ref: 'v1' })] }
    expect(isSourceInBlocklist(git('https://github.com/bad/repo', { ref: 'v1' }))).toBe(true)
    expect(isSourceInBlocklist(git('https://github.com/bad/repo', { ref: 'v2' }))).toBe(false)
  })

  test('a github source is caught by a git entry pointing at the same GitHub repo', () => {
    policy = { blockedMarketplaces: [git('git@github.com:bad/repo.git')] }
    expect(isSourceInBlocklist(gh('bad/repo'))).toBe(true)
    expect(isSourceInBlocklist(gh('other/repo'))).toBe(false)
  })

  test('git entries compare url, then ref/path wildcards', () => {
    policy = { blockedMarketplaces: [git('https://x/r.git', { path: 'p' })] }
    expect(isSourceInBlocklist(git('https://x/r.git', { path: 'p' }))).toBe(true)
    expect(isSourceInBlocklist(git('https://x/r.git', { path: 'q' }))).toBe(false)
    expect(isSourceInBlocklist(git('https://x/other.git', { path: 'p' }))).toBe(false)
  })

  test('url, npm, file, directory and settings entries match on their identifying field', () => {
    policy = {
      blockedMarketplaces: [
        url('https://x/m.json'),
        npm('evil-pkg'),
        file('/f.json'),
        dir('/d'),
        settingsSrc('inline'),
      ],
    }
    expect(isSourceInBlocklist(url('https://x/m.json'))).toBe(true)
    expect(isSourceInBlocklist(url('https://x/other.json'))).toBe(false)
    expect(isSourceInBlocklist(npm('evil-pkg'))).toBe(true)
    expect(isSourceInBlocklist(npm('ok-pkg'))).toBe(false)
    expect(isSourceInBlocklist(file('/f.json'))).toBe(true)
    expect(isSourceInBlocklist(file('/g.json'))).toBe(false)
    expect(isSourceInBlocklist(dir('/d'))).toBe(true)
    expect(isSourceInBlocklist(dir('/e'))).toBe(false)
    expect(isSourceInBlocklist(settingsSrc('inline', [{ name: 'p' }]))).toBe(true)
    expect(isSourceInBlocklist(settingsSrc('other'))).toBe(false)
  })

  test('different source types that are not the github/git pair never match', () => {
    policy = { blockedMarketplaces: [file('/same')] }
    expect(isSourceInBlocklist(dir('/same'))).toBe(false)
  })
})

describe('isSourceAllowedByPolicy', () => {
  test('everything is allowed without a policy', () => {
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(true)
    expect(isSourceAllowedByPolicy(npm('p'))).toBe(true)
  })

  test('the blocklist wins over the allowlist', () => {
    policy = {
      strictKnownMarketplaces: [gh('o/r')],
      blockedMarketplaces: [gh('o/r')],
    }
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(false)
  })

  test('a blocklist alone leaves everything else allowed', () => {
    policy = { blockedMarketplaces: [gh('bad/repo')] }
    expect(isSourceAllowedByPolicy(gh('good/repo'))).toBe(true)
  })

  test('an empty allowlist allows nothing', () => {
    policy = { strictKnownMarketplaces: [] }
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(false)
  })

  test('github entries match on repo, and ref/path are compared exactly', () => {
    policy = { strictKnownMarketplaces: [gh('o/r', { ref: 'main' })] }
    expect(isSourceAllowedByPolicy(gh('o/r', { ref: 'main' }))).toBe(true)
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(false)
    expect(isSourceAllowedByPolicy(gh('o/r', { ref: 'dev' }))).toBe(false)
    expect(isSourceAllowedByPolicy(gh('o/other', { ref: 'main' }))).toBe(false)
  })

  test('an empty ref/path on either side counts as absent', () => {
    policy = { strictKnownMarketplaces: [gh('o/r', { ref: '', path: '' })] }
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(true)
  })

  test('git entries match on url, ref and path', () => {
    policy = { strictKnownMarketplaces: [git('https://x/r.git', { path: 'p' })] }
    expect(isSourceAllowedByPolicy(git('https://x/r.git', { path: 'p' }))).toBe(true)
    expect(isSourceAllowedByPolicy(git('https://x/r.git'))).toBe(false)
    expect(isSourceAllowedByPolicy(git('https://x/other.git', { path: 'p' }))).toBe(false)
  })

  test('the allowlist does not cross source types', () => {
    policy = { strictKnownMarketplaces: [gh('o/r')] }
    expect(isSourceAllowedByPolicy(git('https://github.com/o/r.git'))).toBe(false)
  })

  test('url, npm, file, directory and settings entries are exact matches', () => {
    policy = {
      strictKnownMarketplaces: [
        url('https://x/m.json'),
        npm('ok-pkg'),
        file('/f.json'),
        dir('/d'),
        settingsSrc('inline', [{ name: 'p' }]),
      ],
    }
    expect(isSourceAllowedByPolicy(url('https://x/m.json'))).toBe(true)
    expect(isSourceAllowedByPolicy(url('https://x/n.json'))).toBe(false)
    expect(isSourceAllowedByPolicy(npm('ok-pkg'))).toBe(true)
    expect(isSourceAllowedByPolicy(npm('other'))).toBe(false)
    expect(isSourceAllowedByPolicy(file('/f.json'))).toBe(true)
    expect(isSourceAllowedByPolicy(dir('/d'))).toBe(true)
    expect(isSourceAllowedByPolicy(dir('/e'))).toBe(false)
    expect(isSourceAllowedByPolicy(settingsSrc('inline', [{ name: 'p' }]))).toBe(true)
    // Settings sources compare their whole plugin list, not just the name.
    expect(isSourceAllowedByPolicy(settingsSrc('inline', [{ name: 'q' }]))).toBe(false)
  })

  test('a hostPattern entry admits the hosts it names', () => {
    policy = { strictKnownMarketplaces: [hostPattern('^ghe\\.corp\\.com$')] }
    expect(isSourceAllowedByPolicy(git('git@ghe.corp.com:o/r.git'))).toBe(true)
    expect(isSourceAllowedByPolicy(url('https://ghe.corp.com/m.json'))).toBe(true)
    expect(isSourceAllowedByPolicy(git('https://gitlab.com/o/r.git'))).toBe(false)
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(false)
  })

  test('a hostPattern for github.com admits the github shorthand', () => {
    policy = { strictKnownMarketplaces: [hostPattern('^github\\.com$')] }
    expect(isSourceAllowedByPolicy(gh('any/repo'))).toBe(true)
  })

  test('a hostPattern never admits a source with no host', () => {
    policy = { strictKnownMarketplaces: [hostPattern('.*')] }
    expect(isSourceAllowedByPolicy(npm('p'))).toBe(false)
    expect(isSourceAllowedByPolicy(file('/f'))).toBe(false)
    expect(isSourceAllowedByPolicy(git('not a url'))).toBe(false)
  })

  test('an invalid hostPattern regex admits nothing instead of throwing', () => {
    policy = { strictKnownMarketplaces: [hostPattern('[')] }
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(false)
  })

  test('an unanchored hostPattern must still match the whole host', () => {
    policy = { strictKnownMarketplaces: [hostPattern('ghe\\.corp\\.com')] }
    expect(isSourceAllowedByPolicy(git('https://ghe.corp.com/o/r.git'))).toBe(true)
    expect(isSourceAllowedByPolicy(git('https://ghe.corp.com.evil.io/o/r.git'))).toBe(false)
    expect(isSourceAllowedByPolicy(git('https://evil-ghe.corp.com/o/r.git'))).toBe(false)
  })

  test('a top-level alternation is anchored as a whole', () => {
    policy = { strictKnownMarketplaces: [hostPattern('a\\.example|b\\.example')] }
    expect(isSourceAllowedByPolicy(url('https://a.example/m.json'))).toBe(true)
    expect(isSourceAllowedByPolicy(url('https://b.example/m.json'))).toBe(true)
    expect(isSourceAllowedByPolicy(url('https://a.example.evil.io/m.json'))).toBe(false)
  })

  test('a pathPattern admits file and directory paths, as a prefix match', () => {
    policy = { strictKnownMarketplaces: [pathPattern('^/opt/marketplaces/')] }
    expect(isSourceAllowedByPolicy(dir('/opt/marketplaces/acme'))).toBe(true)
    expect(isSourceAllowedByPolicy(file('/opt/marketplaces/acme/m.json'))).toBe(true)
    expect(isSourceAllowedByPolicy(dir('/home/u/marketplaces/acme'))).toBe(false)
  })

  test('a pathPattern never admits a network source', () => {
    policy = { strictKnownMarketplaces: [pathPattern('.*')] }
    expect(isSourceAllowedByPolicy(gh('o/r'))).toBe(false)
    expect(isSourceAllowedByPolicy(url('https://x/m.json'))).toBe(false)
  })

  test('an invalid pathPattern regex admits nothing instead of throwing', () => {
    policy = { strictKnownMarketplaces: [pathPattern('(')] }
    expect(isSourceAllowedByPolicy(dir('/d'))).toBe(false)
  })

  test('any one matching entry is enough', () => {
    policy = {
      strictKnownMarketplaces: [gh('a/a'), pathPattern('^/ok'), hostPattern('^gitlab\\.com$')],
    }
    expect(isSourceAllowedByPolicy(git('https://gitlab.com/o/r.git'))).toBe(true)
    expect(isSourceAllowedByPolicy(dir('/ok/x'))).toBe(true)
    expect(isSourceAllowedByPolicy(gh('a/a'))).toBe(true)
    expect(isSourceAllowedByPolicy(gh('b/b'))).toBe(false)
  })
})

describe('formatSourceForDisplay', () => {
  test('prefixes each source type and appends a ref when present', () => {
    expect(formatSourceForDisplay(gh('o/r'))).toBe('github:o/r')
    expect(formatSourceForDisplay(gh('o/r', { ref: 'v1' }))).toBe('github:o/r@v1')
    expect(formatSourceForDisplay(url('https://x/m.json'))).toBe('https://x/m.json')
    expect(formatSourceForDisplay(git('https://x/r.git'))).toBe('git:https://x/r.git')
    expect(formatSourceForDisplay(git('https://x/r.git', { ref: 'b' }))).toBe(
      'git:https://x/r.git@b',
    )
    expect(formatSourceForDisplay(npm('p'))).toBe('npm:p')
    expect(formatSourceForDisplay(file('/f'))).toBe('file:/f')
    expect(formatSourceForDisplay(dir('/d'))).toBe('dir:/d')
    expect(formatSourceForDisplay(hostPattern('^h$'))).toBe('hostPattern:^h$')
    expect(formatSourceForDisplay(pathPattern('^/p'))).toBe('pathPattern:^/p')
  })

  test('settings sources count their plugins with the right plural', () => {
    expect(formatSourceForDisplay(settingsSrc('inline', [{}]))).toBe(
      'settings:inline (1 plugin)',
    )
    expect(formatSourceForDisplay(settingsSrc('inline', [{}, {}]))).toBe(
      'settings:inline (2 plugins)',
    )
  })

  test('an unknown type falls back', () => {
    expect(
      formatSourceForDisplay({ source: 'mystery' } as unknown as MarketplaceSource),
    ).toBe('unknown source')
  })
})

describe('loadMarketplacesWithGracefulDegradation', () => {
  const known = (source: MarketplaceSource): KnownMarketplace =>
    ({ source, installLocation: '/tmp/x', lastUpdated: '2026-01-01T00:00:00Z' }) as KnownMarketplace

  test('loads each marketplace, records failures and keeps going', async () => {
    const data = { name: 'ok', owner: { name: 'o' }, plugins: [] }
    spies.push(
      spyOn(marketplaceManager, 'getMarketplace').mockImplementation((async (
        name: string,
      ) => {
        if (name === 'broken') throw new Error('cannot read manifest')
        if (name === 'weird') throw 'a string'
        return data
      }) as unknown as typeof marketplaceManager.getMarketplace),
    )

    const { marketplaces, failures } = await loadMarketplacesWithGracefulDegradation({
      ok: known(gh('o/ok')),
      broken: known(gh('o/broken')),
      weird: known(gh('o/weird')),
    })

    expect(marketplaces.map(m => [m.name, m.data])).toEqual([
      ['ok', data],
      ['broken', null],
      ['weird', null],
    ])
    expect(failures).toEqual([
      { name: 'broken', error: 'cannot read manifest' },
      { name: 'weird', error: 'a string' },
    ])
  })

  test('skips a marketplace the policy blocks without loading it', async () => {
    policy = { blockedMarketplaces: [gh('bad/repo')] }
    const loaded: string[] = []
    spies.push(
      spyOn(marketplaceManager, 'getMarketplace').mockImplementation((async (
        name: string,
      ) => {
        loaded.push(name)
        return { name, owner: { name: 'o' }, plugins: [] }
      }) as unknown as typeof marketplaceManager.getMarketplace),
    )

    const { marketplaces, failures } = await loadMarketplacesWithGracefulDegradation({
      bad: known(gh('bad/repo')),
      good: known(gh('good/repo')),
    })
    expect(loaded).toEqual(['good'])
    expect(marketplaces.map(m => m.name)).toEqual(['good'])
    expect(failures).toEqual([])
  })
})

describe('detectEmptyMarketplaceReason', () => {
  const withGit = (available: boolean) =>
    spies.push(
      spyOn(gitAvailability, 'checkGitAvailable').mockImplementation(
        (async () => available) as unknown as typeof gitAvailability.checkGitAvailable,
      ),
    )

  test('missing git comes first', async () => {
    withGit(false)
    policy = { strictKnownMarketplaces: [] }
    expect(
      await detectEmptyMarketplaceReason({ configuredMarketplaceCount: 0, failedMarketplaceCount: 0 }),
    ).toBe('git-not-installed')
  })

  test('an empty allowlist blocks everything', async () => {
    withGit(true)
    policy = { strictKnownMarketplaces: [] }
    expect(
      await detectEmptyMarketplaceReason({ configuredMarketplaceCount: 3, failedMarketplaceCount: 0 }),
    ).toBe('all-blocked-by-policy')
  })

  test('a restrictive allowlist with nothing configured', async () => {
    withGit(true)
    policy = { strictKnownMarketplaces: [gh('o/r')] }
    expect(
      await detectEmptyMarketplaceReason({ configuredMarketplaceCount: 0, failedMarketplaceCount: 0 }),
    ).toBe('policy-restricts-sources')
  })

  test('nothing configured and no policy', async () => {
    withGit(true)
    expect(
      await detectEmptyMarketplaceReason({ configuredMarketplaceCount: 0, failedMarketplaceCount: 0 }),
    ).toBe('no-marketplaces-configured')
  })

  test('every configured marketplace failed', async () => {
    withGit(true)
    expect(
      await detectEmptyMarketplaceReason({ configuredMarketplaceCount: 2, failedMarketplaceCount: 2 }),
    ).toBe('all-marketplaces-failed')
  })

  test('some loaded: the plugins must already be installed', async () => {
    withGit(true)
    policy = { strictKnownMarketplaces: [gh('o/r')] }
    expect(
      await detectEmptyMarketplaceReason({ configuredMarketplaceCount: 2, failedMarketplaceCount: 1 }),
    ).toBe('all-plugins-installed')
  })
})
