// Characterization of the remote-URL parsers in src/vcs/git/detectRepository.ts,
// written for the clean-base rewrite (docs/tech/rewrite/vcs/git.md). The
// functions that read the session repository (detectCurrentRepository and its
// host-aware variant) are pinned in git.session.characterization.test.ts,
// because they share the session's cached git state.
import { describe, expect, test } from 'bun:test'
import {
  parseGitHubRepository,
  parseGitRemote,
  type ParsedRepository,
} from 'src/vcs/git/detectRepository.js'

function repo(host: string, owner: string, name: string): ParsedRepository {
  return { host, owner, name }
}

// Every remote form the parser accepts, and what it makes of it.
const ACCEPTED: ReadonlyArray<readonly [string, ParsedRepository]> = [
  ['git@github.com:acme/widgets.git', repo('github.com', 'acme', 'widgets')],
  ['git@github.com:acme/widgets', repo('github.com', 'acme', 'widgets')],
  ['git@ghe.corp.example:platform/tooling.git', repo('ghe.corp.example', 'platform', 'tooling')],
  ['https://github.com/acme/widgets.git', repo('github.com', 'acme', 'widgets')],
  ['https://github.com/acme/widgets', repo('github.com', 'acme', 'widgets')],
  ['http://github.com/acme/widgets', repo('github.com', 'acme', 'widgets')],
  ['https://octo:s3cret@github.com/acme/widgets.git', repo('github.com', 'acme', 'widgets')],
  ['https://x-access-token:ghs_tok3n@github.com/acme/widgets', repo('github.com', 'acme', 'widgets')],
  ['https://ghe.corp.example:8443/platform/tooling.git', repo('ghe.corp.example:8443', 'platform', 'tooling')],
  ['http://ghe.corp.example:8080/platform/tooling', repo('ghe.corp.example:8080', 'platform', 'tooling')],
  ['ssh://git@github.com/acme/widgets.git', repo('github.com', 'acme', 'widgets')],
  ['ssh://git@ghe.corp.example:2222/platform/tooling.git', repo('ghe.corp.example', 'platform', 'tooling')],
  ['ssh://ghe.corp.example/platform/tooling', repo('ghe.corp.example', 'platform', 'tooling')],
  ['git://github.com/acme/widgets.git', repo('github.com', 'acme', 'widgets')],
  ['git://mirror.example.org:9418/platform/tooling', repo('mirror.example.org', 'platform', 'tooling')],
  ['  git@github.com:acme/widgets.git\n', repo('github.com', 'acme', 'widgets')],
  ['git@github.com:Acme-Org/Widget_Kit.git', repo('github.com', 'Acme-Org', 'Widget_Kit')],
  ['git@github.com:acme/cc.kurs.web.git', repo('github.com', 'acme', 'cc.kurs.web')],
  ['https://github.com/acme/widgets.git.git', repo('github.com', 'acme', 'widgets.git')],
  ['https://www.github.com/acme/widgets', repo('www.github.com', 'acme', 'widgets')],
  ['git@git.sub.example.co.uk:team/app.git', repo('git.sub.example.co.uk', 'team', 'app')],
]

// Remotes that are rejected, each with the reason.
const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['', 'empty'],
  ['   ', 'blank'],
  ['not a remote', 'prose'],
  ['acme/widgets', 'owner/name shorthand is not a remote'],
  ['git@github.com-work:acme/widgets.git', 'SSH config alias: the last label is not purely alphabetic'],
  ['git@localhost:acme/widgets.git', 'host without a dot'],
  ['git@10.0.0.7:acme/widgets.git', 'IP address host'],
  ['https://192.168.1.20/acme/widgets', 'IP address host over https'],
  ['deploy@github.com:acme/widgets.git', 'scp-like form with a user other than git'],
  ['git@gitlab.com:group/subgroup/project.git', 'more than two path segments'],
  ['https://gitlab.com/group/subgroup/project.git', 'more than two path segments over https'],
  ['https://github.com/acme/widgets/', 'trailing slash'],
  ['https://github.com/acme', 'single path segment'],
  ['https://github.com/acme/widgets/tree/main', 'a web page URL'],
  ['ftp://github.com/acme/widgets', 'unsupported scheme'],
  ['git+ssh://git@github.com/acme/widgets.git', 'compound scheme'],
  ['file:///srv/git/widgets.git', 'file URL'],
  ['HTTPS://github.com/acme/widgets', 'upper-case scheme'],
  ['git@github.com:2222/acme/widgets.git', 'scp-like form with a port'],
]

describe('parseGitRemote', () => {
  for (const [input, expected] of ACCEPTED) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(parseGitRemote(input)).toEqual(expected)
    })
  }

  for (const [input, reason] of REJECTED) {
    test(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      expect(parseGitRemote(input)).toBeNull()
    })
  }

  test('user-info in a URL never reaches the result', () => {
    const parsed = parseGitRemote('https://octo:s3cret@github.com/acme/widgets.git')
    expect(JSON.stringify(parsed)).not.toContain('s3cret')
    expect(JSON.stringify(parsed)).not.toContain('octo')
  })
})

// What parseGitHubRepository makes of each input, grouped by the rule at work.
const GITHUB_NAMES: Record<string, ReadonlyArray<readonly [string, string | null]>> = {
  'a github.com remote in any accepted form becomes owner/name, letter case kept': [
    ['git@github.com:Acme/Widgets.git', 'Acme/Widgets'],
    ['https://token@github.com/acme/widgets', 'acme/widgets'],
    ['ssh://git@github.com:22/acme/widgets.git', 'acme/widgets'],
    ['git://github.com/acme/widgets', 'acme/widgets'],
  ],
  'a remote on any other host is refused, GitHub Enterprise included': [
    ['git@ghe.corp.example:platform/tooling.git', null],
    ['https://ghe.corp.example:8443/platform/tooling', null],
    ['https://www.github.com/acme/widgets', null],
    ['https://gitlab.com/acme/widgets.git', null],
  ],
  'the owner/name shorthand is accepted, trimmed, with one trailing .git removed': [
    ['acme/widgets', 'acme/widgets'],
    ['  Acme/Widgets.git  ', 'Acme/Widgets'],
    ['acme/widgets.git.git', 'acme/widgets.git'],
    ['acme/cc.kurs.web', 'acme/cc.kurs.web'],
  ],
  'anything else is refused': [
    ['', null],
    ['acme', null],
    ['acme/', null],
    ['/widgets', null],
    ['acme/widgets/extra', null],
    ['git@github.com-work:acme/widgets.git', null],
    ['user@acme/widgets', null],
    ['https://github.com/acme/widgets/tree/main', null],
    ['HTTPS://github.com/acme/widgets', null],
  ],
}

describe('parseGitHubRepository', () => {
  for (const [rule, cases] of Object.entries(GITHUB_NAMES)) {
    test(rule, () => {
      const seen = cases.map(([input]) => [input, parseGitHubRepository(input)] as const)
      expect(seen).toEqual([...cases])
    })
  }
})
