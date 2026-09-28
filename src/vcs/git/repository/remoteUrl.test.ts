import { describe, expect, test } from 'bun:test'
import {
  gitHubNameOf,
  isGitHubHost,
  parseGitRemote,
  redactRemoteUserInfo,
  toGitHubName,
} from 'src/vcs/git/repository/remoteUrl.js'

/** Each row pairs an input with what `answer` must give for it. The rows are compared at once. */
function expectAnswers<In, Out>(answer: (input: In) => Out, rows: ReadonlyArray<readonly [In, Out]>): void {
  expect(rows.map(([input]) => answer(input))).toStrictEqual(rows.map(([, expected]) => expected))
}

describe('github.com in any letter case', () => {
  test('is recognised by the host check, and a look-alike host stays refused', () => {
    expectAnswers(isGitHubHost, [
      ['GitHub.COM', true],
      ['github.com.evil.example', false],
    ])
  })

  test('is recognised by both projections, and other hosts stay refused', () => {
    expectAnswers(toGitHubName, [
      ['https://GitHub.com/Acme/Widgets.git', 'Acme/Widgets'],
      ['git@GITHUB.COM:acme/widgets.git', 'acme/widgets'],
      ['https://GitLab.com/acme/widgets', null],
    ])
    expectAnswers(gitHubNameOf, [[{ host: 'GitHub.com', owner: 'Acme', name: 'Widgets' }, 'Acme/Widgets']])
  })

  test('while parseGitRemote keeps the host as written', () => {
    expectAnswers(remote => parseGitRemote(remote)?.host, [['https://GitHub.com/Acme/Widgets', 'GitHub.com']])
  })
})

describe('credentials in a remote', () => {
  test('a password holding an unencoded @ never reaches the parsed host', () => {
    expectAnswers(parseGitRemote, [
      ['https://octo:p@ss@github.com/acme/widgets', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ])
  })

  test('redactRemoteUserInfo masks everything up to the last @ after the scheme', () => {
    expectAnswers(redactRemoteUserInfo, [
      ['https://x-access-token:ghs_S3CRET@github.com/acme/widgets.git', 'https://***@github.com/acme/widgets.git'],
      ['https://ghp_S3CRET@github.com/acme/widgets', 'https://***@github.com/acme/widgets'],
      ['https://octo:p@ss@github.com/acme/widgets', 'https://***@github.com/acme/widgets'],
      ['git@github.com:acme/widgets.git', '***@github.com:acme/widgets.git'],
      ['https://github.com/acme/widgets', 'https://github.com/acme/widgets'],
    ])
  })
})
