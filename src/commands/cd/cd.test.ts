import { expect, test } from 'bun:test'

import {
  type CdDeps,
  call,
  formatCdResult,
  parseCdTarget,
} from 'src/commands/cd/cd.js'
import type { LocalJSXCommandContext } from 'src/commands/commands.js'
import type { LocalCommandResult } from 'src/shared/types/command.js'
import type { WorktreeSession } from 'src/vcs/git/worktree.js'

const OLD_DIR = '/tmp/cd-test-old'
const NEW_DIR = '/tmp/cd-test-new'

function makeDeps(overrides: Partial<CdDeps> = {}): CdDeps {
  return {
    currentWorktreeSession: () => null,
    resolveDirectory: async path => ({
      resultType: 'success',
      absolutePath: path,
    }),
    reroot: dir => ({ previousCwd: OLD_DIR, newCwd: dir }),
    previousDir: () => null,
    hasPendingWakeup: () => false,
    currentCwd: () => OLD_DIR,
    refreshSandbox: () => {},
    ...overrides,
  }
}

function makeContext() {
  let state = {
    toolPermissionContext: { additionalWorkingDirectories: new Map() },
  }
  const context = {
    getAppState: () => state,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
  } as unknown as LocalJSXCommandContext
  return {
    context,
    workingDirs: () => state.toolPermissionContext.additionalWorkingDirectories,
  }
}

function value(result: LocalCommandResult): string {
  return result.type === 'text' ? result.value : ''
}

test('parseCdTarget distinguishes empty, previous and a path', () => {
  expect(parseCdTarget('')).toEqual({ kind: 'empty' })
  expect(parseCdTarget('   ')).toEqual({ kind: 'empty' })
  expect(parseCdTarget('-')).toEqual({ kind: 'previous' })
  expect(parseCdTarget(' - ')).toEqual({ kind: 'previous' })
  expect(parseCdTarget('  ~/code/x ')).toEqual({
    kind: 'path',
    path: '~/code/x',
  })
})

test('formatCdResult names the kept directory only when one was kept', () => {
  const moved = { previousCwd: OLD_DIR, newCwd: NEW_DIR }

  const kept = formatCdResult(moved, true, false)
  expect(kept).toContain(NEW_DIR)
  expect(kept).toContain(`${OLD_DIR} kept accessible`)
  expect(kept).not.toContain('/loop')

  const dropped = formatCdResult(moved, false, true)
  expect(dropped).not.toContain('kept accessible')
  expect(dropped).toContain('cancelled the pending /loop wakeup')
})

test('no argument prints usage instead of moving', async () => {
  const { context } = makeContext()
  let rerooted = false

  const result = await call(
    '',
    context,
    makeDeps({
      reroot: dir => {
        rerooted = true
        return { previousCwd: OLD_DIR, newCwd: dir }
      },
    }),
  )

  expect(value(result)).toContain('Usage')
  expect(rerooted).toBe(false)
})

test('refuses to move a session that is inside a worktree', async () => {
  const { context } = makeContext()
  let rerooted = false

  const result = await call(
    NEW_DIR,
    context,
    makeDeps({
      currentWorktreeSession: () => ({}) as WorktreeSession,
      reroot: dir => {
        rerooted = true
        return { previousCwd: OLD_DIR, newCwd: dir }
      },
    }),
  )

  expect(value(result)).toContain('ExitWorktree')
  expect(rerooted).toBe(false)
})

test('reports the resolver error for a path that does not exist', async () => {
  const { context } = makeContext()

  const result = await call(
    '/tmp/nope',
    context,
    makeDeps({
      resolveDirectory: async path => ({
        resultType: 'pathNotFound',
        directoryPath: path,
        absolutePath: path,
      }),
    }),
  )

  expect(value(result)).toContain('was not found')
})

test('a file target suggests its parent without add-dir wording', async () => {
  const { context } = makeContext()

  const result = await call(
    '/tmp/cd-test-new/marker.txt',
    context,
    makeDeps({
      resolveDirectory: async path => ({
        resultType: 'notADirectory',
        directoryPath: path,
        absolutePath: path,
      }),
    }),
  )

  expect(value(result)).toContain('is not a directory')
  expect(value(result)).toContain(NEW_DIR)
  expect(value(result)).not.toContain('add the parent')
})

test('/cd - without a previous directory says so', async () => {
  const { context } = makeContext()

  const result = await call('-', context, makeDeps())

  expect(value(result)).toContain('no previous directory')
})

test('a move keeps the old directory as a session working directory', async () => {
  const { context, workingDirs } = makeContext()
  let refreshed = false

  const result = await call(
    NEW_DIR,
    context,
    makeDeps({ refreshSandbox: () => (refreshed = true) }),
  )

  expect(value(result)).toContain(NEW_DIR)
  expect(workingDirs().get(OLD_DIR)).toEqual({
    path: OLD_DIR,
    source: 'session',
  })
  expect(refreshed).toBe(true)
})

test('does not re-add the old directory when the move went up into it', async () => {
  const { context, workingDirs } = makeContext()

  await call(
    '/tmp/cd-test-old',
    context,
    makeDeps({
      currentCwd: () => '/tmp/cd-test-old/nested',
      reroot: dir => ({ previousCwd: '/tmp/cd-test-old/nested', newCwd: dir }),
    }),
  )

  expect(workingDirs().size).toBe(0)
})

test('a failed move reports the error and grants nothing', async () => {
  const { context, workingDirs } = makeContext()

  const result = await call(
    NEW_DIR,
    context,
    makeDeps({
      reroot: () => {
        throw new Error('Path "/tmp/cd-test-new" does not exist')
      },
    }),
  )

  expect(value(result)).toContain('Could not move to')
  expect(value(result)).toContain('does not exist')
  expect(workingDirs().size).toBe(0)
})
