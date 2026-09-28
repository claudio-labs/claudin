/**
 * Characterization of the per-repository lock around `git worktree add` and
 * `git worktree remove`, pinned for the clean-base rewrite
 * (docs/tech/rewrite/vcs/worktree.md).
 *
 * The first half drives the lock alone: holders are started together, each
 * one parks on a gate, and the gates are opened in a chosen order while a log
 * records who entered and who left. The second half shows what the lock buys
 * on disk: concurrent creations and removals in one real repository.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  localBranches,
  openWorktreeLab,
  registeredWorktrees,
  type WorktreeLab,
} from 'src/vcs/git/__testutils__/worktreeLab.js'
import {
  _resetGitWorktreeMutationLocksForTesting,
  createAgentWorktree,
  removeAgentWorktree,
  withGitWorktreeMutationLock,
} from 'src/vcs/git/worktree.js'

afterEach(() => {
  _resetGitWorktreeMutationLocksForTesting()
})

/** Lets every queued promise reaction run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

type Party = {
  finished: Promise<unknown>
  open(): void
}

/**
 * Starts one holder per `[name, key]`, in order. Each logs `>name` when it
 * gets the lock and `<name` when it leaves, and waits on its own gate between.
 */
function startParties(journal: string[], parties: Array<[string, string]>): Map<string, Party> {
  const started = new Map<string, Party>()
  for (const [name, key] of parties) {
    let open!: () => void
    const gate = new Promise<void>(resolve => {
      open = resolve
    })
    const finished = withGitWorktreeMutationLock(key, async () => {
      journal.push(`>${name}`)
      await gate
      journal.push(`<${name}`)
      return name
    })
    started.set(name, { finished, open })
  }
  return started
}

describe('withGitWorktreeMutationLock: who runs when', () => {
  type Scenario = {
    parties: Array<[string, string]>
    /** Who holds the lock before any gate opens. */
    entered: string[]
    /** Gates opened one at a time, in this order. */
    opens: string[]
    journal: string[]
  }
  const scenarios: Array<[string, Scenario]> = [
    [
      'three holders of one repository run one at a time, in arrival order',
      {
        parties: [['p', '/repo/one'], ['q', '/repo/one'], ['r', '/repo/one']],
        entered: ['>p'],
        opens: ['p', 'q', 'r'],
        journal: ['>p', '<p', '>q', '<q', '>r', '<r'],
      },
    ],
    [
      'holders of different repositories do not wait for each other',
      {
        parties: [['p', '/repo/one'], ['q', '/repo/two']],
        entered: ['>p', '>q'],
        opens: ['q', 'p'],
        journal: ['>p', '>q', '<q', '<p'],
      },
    ],
    [
      'a later holder waits only for its own repository',
      {
        parties: [['p', '/repo/one'], ['q', '/repo/two'], ['r', '/repo/one']],
        entered: ['>p', '>q'],
        opens: ['q', 'p', 'r'],
        journal: ['>p', '>q', '<q', '<p', '>r', '<r'],
      },
    ],
    [
      'keys are compared as written: a trailing slash is another repository',
      {
        parties: [['p', '/repo/one'], ['q', '/repo/one/']],
        entered: ['>p', '>q'],
        opens: ['p', 'q'],
        journal: ['>p', '>q', '<p', '<q'],
      },
    ],
  ]

  for (const [label, scenario] of scenarios) {
    test(label, async () => {
      const journal: string[] = []
      const parties = startParties(journal, scenario.parties)
      await settle()
      expect(journal).toEqual(scenario.entered)
      for (const name of scenario.opens) {
        parties.get(name)?.open()
        await settle()
      }
      expect(journal).toEqual(scenario.journal)
      const results = await Promise.all([...parties.values()].map(p => p.finished))
      expect(results).toEqual(scenario.parties.map(([name]) => name))
    })
  }
})

// Outcomes are awaited plainly, never through expect(...).resolves/.rejects:
// under Bun those spin until the promise settles, so a lock that never
// releases would hang the run instead of timing the test out.
describe('withGitWorktreeMutationLock: results and failures', () => {
  test('resolves to what the critical section resolved to, by identity', async () => {
    const payload = { worktree: 'kept' }
    const answer = await withGitWorktreeMutationLock('/repo/value', async () => payload)
    expect(answer).toBe(payload)
  })

  test('a failing holder rejects with its own error and still lets the next one in', async () => {
    const journal: string[] = []
    const failure = new Error('git worktree add exploded')
    const first = withGitWorktreeMutationLock('/repo/fails', async () => {
      journal.push('first')
      throw failure
    })
    const second = withGitWorktreeMutationLock('/repo/fails', async () => {
      journal.push('second')
      return 'second done'
    })
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 'second done' },
    ])
    expect((outcomes[0] as PromiseRejectedResult).reason).toBe(failure)
    expect(journal).toEqual(['first', 'second'])
  })

  test('a holder queued behind a failure is not handed the failure', async () => {
    const results = await Promise.allSettled([
      withGitWorktreeMutationLock('/repo/chain', async () => {
        throw new Error('boom')
      }),
      withGitWorktreeMutationLock('/repo/chain', async () => 'fine'),
      withGitWorktreeMutationLock('/repo/chain', async () => 'also fine'),
    ])
    expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
  })

  test('the lock is free again once every holder has left', async () => {
    await withGitWorktreeMutationLock('/repo/free', async () => 'done')
    const journal: string[] = []
    const parties = startParties(journal, [['late', '/repo/free']])
    await settle()
    expect(journal).toEqual(['>late'])
    parties.get('late')?.open()
    await parties.get('late')?.finished
  })
})

describe('_resetGitWorktreeMutationLocksForTesting', () => {
  test('forgets a held lock: the next caller of that key goes straight in', async () => {
    const journal: string[] = []
    const parties = startParties(journal, [['holder', '/repo/reset']])
    await settle()
    _resetGitWorktreeMutationLocksForTesting()
    const newcomer = startParties(journal, [['newcomer', '/repo/reset']])
    await settle()
    expect(journal).toEqual(['>holder', '>newcomer'])
    newcomer.get('newcomer')?.open()
    parties.get('holder')?.open()
    await Promise.all([parties.get('holder')?.finished, newcomer.get('newcomer')?.finished])
  })
})

describe('what the lock does for a real repository', () => {
  let lab: WorktreeLab
  beforeEach(() => {
    lab = openWorktreeLab()
  })
  afterEach(() => {
    lab.close()
  })

  test('two concurrent creations of one slug make one worktree and agree on it', async () => {
    const { clone, base } = lab.upstream('lock-same')
    const [first, second] = await lab.inSession(clone, () =>
      Promise.all([createAgentWorktree('agent-a1111111'), createAgentWorktree('agent-a1111111')]),
    )
    expect(second).toEqual(first)
    expect(first.headCommit).toBe(base)
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, first.worktreePath])
    expect(localBranches(lab.git, clone)).toEqual(['main', 'worktree-agent-a1111111'])
  })

  test('concurrent creations of different slugs all succeed', async () => {
    const { clone } = lab.upstream('lock-many')
    const slugs = ['one', 'two', 'three', 'four', 'five']
    const made = await lab.inSession(clone, () =>
      Promise.all(slugs.map(slug => createAgentWorktree(slug))),
    )
    expect(made.map(m => m.worktreeBranch)).toEqual(slugs.map(s => `worktree-${s}`))
    expect(registeredWorktrees(lab.git, clone).slice(1).sort()).toEqual(
      made.map(m => m.worktreePath).sort(),
    )
  })

  test('concurrent removals all succeed and take their branches along', async () => {
    const { clone } = lab.upstream('lock-remove')
    const slugs = ['r1', 'r2', 'r3', 'r4']
    const made = await lab.inSession(clone, () =>
      Promise.all(slugs.map(slug => createAgentWorktree(slug))),
    )
    const removed = await Promise.all(
      made.map(m => removeAgentWorktree(m.worktreePath, m.worktreeBranch, m.gitRoot)),
    )
    expect(removed).toEqual([true, true, true, true])
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
    expect(localBranches(lab.git, clone)).toEqual(['main'])
  })
})
