import { describe, expect, test } from 'bun:test'
import { exec } from 'src/shared/proc/Shell.js'
import {
  descendantsOf,
  hasActivity,
  parseCpuTime,
  parsePsTable,
  sampleProcessTree,
} from 'src/tools/BuildTool/treeActivity.js'

describe('parseCpuTime', () => {
  test('reads procps and BSD formats', () => {
    expect(parseCpuTime('00:00:01')).toBe(1)
    expect(parseCpuTime('01:02:03')).toBe(3723)
    expect(parseCpuTime('1-02:03:04')).toBe(93_784)
    // BSD `ps` (macOS): minutes, seconds and hundredths.
    expect(parseCpuTime('1:02.03')).toBeCloseTo(62.03)
    expect(parseCpuTime('0:00.12')).toBeCloseTo(0.12)
  })

  test('anything else is not a time', () => {
    expect(parseCpuTime('TIME')).toBeNull()
    expect(parseCpuTime('')).toBeNull()
    expect(parseCpuTime('12')).toBeNull()
  })
})

describe('parsePsTable + descendantsOf', () => {
  const table = [
    '    1     0 00:00:09',
    '  100     1 00:00:00',
    '  101   100 00:01:30',
    '  102   101 00:00:07',
    '  200     1 00:10:00',
    'garbage line',
    '',
  ].join('\n')

  test('keeps the root and everything below it, nothing else', () => {
    const tree = descendantsOf(parsePsTable(table), 100)
    expect([...tree.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [100, 0],
      [101, 90],
      [102, 7],
    ])
  })

  test('a root that has exited yields an empty tree', () => {
    expect(descendantsOf(parsePsTable(table), 999).size).toBe(0)
  })
})

describe('hasActivity', () => {
  const before = new Map([
    [100, 0],
    [101, 90],
  ])

  test('a member that gained CPU is working', () => {
    expect(hasActivity(before, new Map([[100, 0], [101, 91]]))).toBe(true)
  })

  test('a tree that used no CPU is not', () => {
    expect(hasActivity(before, new Map(before))).toBe(false)
  })

  test('a gain below one CPU-second is a poller, not work', () => {
    expect(hasActivity(before, new Map([[100, 0.3], [101, 90.4]]))).toBe(false)
  })

  test('a new process is work even with no gain on any pid', () => {
    // Short compiler jobs can start and finish between two samples.
    expect(hasActivity(before, new Map([...before, [103, 0]]))).toBe(true)
  })

  test('a member that only exited is not work', () => {
    expect(hasActivity(before, new Map([[100, 0]]))).toBe(false)
  })
})

describe('sampleProcessTree — the real `ps`', () => {
  test.skipIf(process.platform === 'win32')(
    'samples the tree under a running command, rooted at its shell',
    async () => {
      const shell = await exec('sleep 5', new AbortController().signal, 'bash')
      try {
        const pid = shell.pid
        expect(pid).toBeGreaterThan(0)
        // The shell sources its environment snapshot before it forks `sleep`,
        // so the child can take a moment to appear.
        let tree = await sampleProcessTree(pid!)
        const deadline = Date.now() + 5_000
        while ((tree?.size ?? 0) < 2 && Date.now() < deadline) {
          await Bun.sleep(100)
          tree = await sampleProcessTree(pid!)
        }
        expect(tree?.has(pid!)).toBe(true)
        // The shell and the `sleep` it forked.
        expect(tree?.size ?? 0).toBeGreaterThanOrEqual(2)
      } finally {
        shell.kill()
        await shell.result
      }
    },
    15_000,
  )

  test.skipIf(process.platform === 'win32')('a pid with no process answers null', async () => {
    expect(await sampleProcessTree(2 ** 22 + 12_345)).toBeNull()
  })
})
