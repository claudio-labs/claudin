import { describe, expect, test } from 'bun:test'

import { detectGitOperation, parseGitCommitId } from 'src/tools/shared/gitOperationTracking.js'

describe('detectGitOperation', () => {
  test('parses commit sha and push branch from raw output', () => {
    const command = 'git commit -m wip && git push'
    const output =
      '[main 154654a] wip\n   abc1234..def5678  main -> main\n'
    const r = detectGitOperation(command, output)
    expect(r.commit).toEqual({ sha: '154654', kind: 'committed' })
    expect(r.push).toEqual({ branch: 'main' })
  })

  test('strips bash-output-filtered wrapper so closing tag is not captured as branch', () => {
    const command = 'git commit -m wip && git push'
    // The bash-output filter wraps stdout; the push ref line ends the body so
    // the closing tag abuts the branch name with no separating whitespace.
    const output =
      '<bash-output-filtered original="git push" lines="2/9" reduction="78%">' +
      '[main 154654a] wip\n   abc1234..def5678  main -> main' +
      '</bash-output-filtered>\n'
    const r = detectGitOperation(command, output)
    expect(r.commit).toEqual({ sha: '154654', kind: 'committed' })
    expect(r.push).toEqual({ branch: 'main' })
  })

  test('strips bash-output-rewritten wrapper too', () => {
    const command = 'git push'
    const output =
      '<bash-output-rewritten original="git push" actual="git push">' +
      '   abc1234..def5678  feature/x -> feature/x' +
      '</bash-output-rewritten>'
    const r = detectGitOperation(command, output)
    expect(r.push).toEqual({ branch: 'feature/x' })
  })
})

describe('parseGitCommitId', () => {
  test('extracts sha from commit output', () => {
    expect(parseGitCommitId('[main 154654a] wip')).toBe('154654a')
  })

  test('extracts sha from root commit', () => {
    expect(parseGitCommitId('[main (root-commit) abc1234] init')).toBe(
      'abc1234',
    )
  })
})
