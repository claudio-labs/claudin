import { describe, expect, test } from 'bun:test'
import { createRepositoryDetector } from 'src/vcs/git/repository/repositoryDetection.js'

function harness(readRemote: () => Promise<string | null>) {
  const logged: string[] = []
  let cwd = '/work/a'
  let reads = 0
  const detector = createRepositoryDetector({
    readRemoteUrl: () => {
      reads++
      return readRemote()
    },
    sessionCwd: () => cwd,
    log: message => logged.push(message),
  })
  return {
    detector,
    logged,
    reads: () => reads,
    moveTo: (dir: string) => {
      cwd = dir
    },
  }
}

describe('what reaches the debug log', () => {
  test('an origin carrying a token is logged without its user-info', async () => {
    const { detector, logged } = harness(
      async () => 'https://x-access-token:ghs_T0KEN@github.com/acme/widgets.git',
    )
    expect(await detector.detectWithHost()).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    })
    expect(logged).not.toEqual([])
    expect(logged.join('\n')).not.toContain('ghs_T0KEN')
    expect(logged.join('\n')).not.toContain('x-access-token')
  })

  test('an origin that names no repository is logged without its user-info too', async () => {
    const { detector, logged } = harness(async () => 'https://deploy:hunter2@localhost/acme/widgets')
    expect(await detector.detectWithHost()).toBeNull()
    expect(logged.join('\n')).toContain('localhost')
    expect(logged.join('\n')).not.toContain('hunter2')
  })

  test('an input gitHubNameOf cannot read is logged without its user-info', () => {
    const { detector, logged } = harness(async () => null)
    expect(detector.gitHubNameOf('https://deploy:hunter2@gitlab.example/acme/widgets')).toBeNull()
    expect(detector.gitHubNameOf('acme/widgets')).toBe('acme/widgets')
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('hunter2')
  })
})

describe('memory', () => {
  test('each answer, null included, is kept per session cwd until forget', async () => {
    let remote: string | null = null
    const { detector, reads, moveTo } = harness(async () => remote)
    expect(await detector.detectWithHost()).toBeNull()
    remote = 'git@github.com:acme/widgets.git'
    expect(await detector.detectWithHost()).toBeNull()
    moveTo('/work/b')
    expect(await detector.detectOnGitHub()).toBe('acme/widgets')
    expect(reads()).toBe(2)
    detector.forget()
    moveTo('/work/a')
    expect(await detector.detectOnGitHub()).toBe('acme/widgets')
    expect(reads()).toBe(3)
  })

  test('a failing read is remembered as null and logged', async () => {
    const { detector, logged, reads } = harness(async () => {
      throw new Error('config unreadable')
    })
    expect(await detector.detectWithHost()).toBeNull()
    expect(await detector.detectWithHost()).toBeNull()
    expect(reads()).toBe(1)
    expect(logged.some(line => line.includes('config unreadable'))).toBe(true)
  })

  test('the github.com projection accepts the host in any letter case', async () => {
    const { detector } = harness(async () => 'https://GitHub.com/Acme/Widgets.git')
    expect(await detector.detectOnGitHub()).toBe('Acme/Widgets')
  })
})
