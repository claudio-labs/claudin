import { describe, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFilePoller } from 'src/vcs/git/gitFilesystem/filePoller.js'
import { fileStamp } from 'src/vcs/git/gitFilesystem/gitFiles.js'

const INTERVAL = 5

async function waitFor(condition: () => boolean, withinMs = 1000): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(INTERVAL)
  return condition()
}

describe('createFilePoller', () => {
  test('a change after the watch starts is reported once, and nothing without a change', async () => {
    const stamps = new Map([['/f', 'v1']])
    const watch = createFilePoller(INTERVAL, path => stamps.get(path) ?? 'absent')
    let changes = 0
    const stop = watch('/f', () => changes++)
    try {
      await Bun.sleep(INTERVAL * 4)
      expect(changes).toBe(0)
      stamps.set('/f', 'v2')
      expect(await waitFor(() => changes === 1)).toBe(true)
      await Bun.sleep(INTERVAL * 4)
      expect(changes).toBe(1)
    } finally {
      stop()
    }
  })

  test('a file that does not exist yet is watched for its creation', async () => {
    const stamps = new Map<string, string>()
    const watch = createFilePoller(INTERVAL, path => stamps.get(path) ?? 'absent')
    let changes = 0
    const stop = watch('/later', () => changes++)
    try {
      stamps.set('/later', 'made')
      expect(await waitFor(() => changes === 1)).toBe(true)
    } finally {
      stop()
    }
  })

  test('after stop, changes are no longer reported', async () => {
    const stamps = new Map([['/f', 'v1']])
    const watch = createFilePoller(INTERVAL, path => stamps.get(path) ?? 'absent')
    let changes = 0
    watch('/f', () => changes++)()
    stamps.set('/f', 'v2')
    await Bun.sleep(INTERVAL * 4)
    expect(changes).toBe(0)
  })

  test('a listener that throws does not stop the others', async () => {
    const stamps = new Map([['/a', '1'], ['/b', '1']])
    const watch = createFilePoller(INTERVAL, path => stamps.get(path) ?? 'absent')
    let seen = 0
    const stops = [
      watch('/a', () => {
        throw new Error('listener failure')
      }),
      watch('/b', () => seen++),
    ]
    try {
      stamps.set('/a', '2')
      stamps.set('/b', '2')
      expect(await waitFor(() => seen === 1)).toBe(true)
    } finally {
      for (const stop of stops) stop()
    }
  })
})

describe('fileStamp', () => {
  test('changes when git renames a new file over the old one, even at the same size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-stamp-'))
    try {
      const target = join(dir, 'HEAD')
      writeFileSync(target, 'ref: refs/heads/aa\n')
      const before = fileStamp(target)
      writeFileSync(join(dir, 'HEAD.lock'), 'ref: refs/heads/bb\n')
      renameSync(join(dir, 'HEAD.lock'), target)
      expect(fileStamp(target)).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing file, or one below a file, has the same stamp as any other absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-absent-'))
    try {
      writeFileSync(join(dir, 'plain'), 'x')
      expect(fileStamp(join(dir, 'missing'))).toBe(fileStamp(join(dir, 'plain', 'below')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
