/**
 * `/clear`, `--resume` and `--continue` call clearSessionCaches() so that the
 * next turn rediscovers files, skills, context and git state from scratch.
 * Each row below puts something into one of the caches it resets, through
 * that cache's own module, and reads it back after the clear.
 *
 * Some state belongs to background agents that /clear keeps alive. When ids
 * are passed in, their entries survive, and so does state that cannot be
 * scoped to one agent; the `keptForAgents` column says which rows do.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { getGitStatus, getSystemContext, getUserContext } from 'src/agent/context.js'
import {
  _getSkillLatchSnapshotForTests,
  _seedSentSkillNamesForTests,
} from 'src/agent/attachments/attachments.js'
import {
  hasPermissionCallback,
  registerPermissionCallback,
} from 'src/agent/coordinator/hooks/useSwarmPermissionPoller.js'
import { clearSessionCaches } from 'src/commands/clear/caches.js'
import { getMemoryFiles } from 'src/memory/instructions/claudemd.js'
import {
  addInvokedSkill,
  getInvokedSkills,
  getLastEmittedDate,
  setLastEmittedDate,
} from 'src/platform/bootstrap/state.js'
import {
  getPendingLSPDiagnosticCount,
  registerPendingLSPDiagnostic,
} from 'src/platform/lsp/LSPDiagnosticRegistry.js'
import { getSessionStartDate } from 'src/shared/constants/common.js'
import { fileReadCache } from 'src/shared/fs/fileReadCache.js'
import { cacheImagePath, getStoredImagePath } from 'src/terminal/image/imageStore.js'
import { getAgentDefinitionsWithOverrides } from 'src/tools/AgentTool/loadAgentsDir.js'
import { getPrompt as getSkillToolPrompt } from 'src/tools/SkillTool/prompt.js'
import { resolveGitDir } from 'src/vcs/git/gitFilesystem.js'
import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'

const KEPT_AGENT = 'agent-kept-across-clear'

let lab: WorktreeLab
beforeAll(() => {
  lab = openWorktreeLab()
})
afterAll(() => {
  clearSessionCaches()
  lab.close()
})

type Memo = { cache: { set(key: unknown, value: unknown): unknown; has(key: unknown): boolean } }

/** A row whose state lives in a lodash memo the module exports. */
function memoRow(name: string, memo: unknown): Row {
  const cache = (memo as Memo).cache
  const key = `probe:${name}`
  return {
    name,
    keptForAgents: false,
    fill: () => {
      cache.set(key, Promise.resolve('remembered'))
    },
    holds: () => cache.has(key),
  }
}

type Row = {
  name: string
  /** True when the entry survives a clear that preserves KEPT_AGENT. */
  keptForAgents: boolean
  fill: () => void | Promise<void>
  holds: () => boolean | Promise<boolean>
}

function rows(): Row[] {
  const readable = join(lab.anchor, 'cached.txt')
  const repo = lab.git.repo('clear-gitdir')
  return [
    memoRow('user context', getUserContext),
    memoRow('system context', getSystemContext),
    memoRow('git status', getGitStatus),
    memoRow('session start date', getSessionStartDate),
    memoRow('memory files', getMemoryFiles),
    {
      name: 'last emitted date',
      keptForAgents: false,
      fill: () => setLastEmittedDate('2031-04-05'),
      holds: () => getLastEmittedDate() !== null,
    },
    {
      name: 'file read cache',
      keptForAgents: false,
      fill: () => {
        writeFileSync(readable, 'cached body')
        fileReadCache.readFile(readable)
      },
      holds: () => fileReadCache.getStats().entries.includes(readable),
    },
    {
      name: 'pasted image paths',
      keptForAgents: false,
      fill: () => {
        cacheImagePath({ id: 7351, type: 'image', content: '', mediaType: 'image/png' } as never)
      },
      holds: () => getStoredImagePath(7351) !== null,
    },
    {
      name: 'skill names already listed',
      keptForAgents: false,
      fill: () => _seedSentSkillNamesForTests('', ['listed-skill']),
      holds: () => Object.values(_getSkillLatchSnapshotForTests().sentByAgent).flat().includes('listed-skill'),
    },
    {
      name: 'pending LSP diagnostics',
      keptForAgents: false,
      fill: () =>
        registerPendingLSPDiagnostic({
          serverName: 'probe-lsp',
          files: [
            {
              uri: `file://${join(lab.anchor, 'broken.ts')}`,
              diagnostics: [{ message: 'nope', severity: 'Error', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
            } as never,
          ],
        }),
      holds: () => getPendingLSPDiagnosticCount() > 0,
    },
    {
      name: 'git directory lookups',
      keptForAgents: false,
      fill: async () => {
        await resolveGitDir(repo)
        rmSync(join(repo, '.git'), { recursive: true, force: true })
      },
      holds: async () => (await resolveGitDir(repo)) !== null,
    },
    {
      name: 'main-thread invoked skills',
      keptForAgents: false,
      fill: () => addInvokedSkill('main-skill', '/skills/main', 'body', null),
      holds: () => [...getInvokedSkills().values()].some(s => s.skillName === 'main-skill'),
    },
    {
      name: 'invoked skills of a kept agent',
      keptForAgents: true,
      fill: () => addInvokedSkill('agent-skill', '/skills/agent', 'body', KEPT_AGENT),
      holds: () => [...getInvokedSkills().values()].some(s => s.skillName === 'agent-skill'),
    },
    {
      name: 'swarm permission callbacks',
      keptForAgents: true,
      fill: () =>
        registerPermissionCallback({ requestId: 'req-probe', toolUseId: 'toolu-probe', onAllow: () => {}, onReject: () => {} }),
      holds: () => hasPermissionCallback('req-probe'),
    },
  ]
}

/** Caches dropped through a lazy import: they empty a moment after the call. */
function lateRows(): Row[] {
  return [memoRow('agent definitions', getAgentDefinitionsWithOverrides), memoRow('Skill tool prompt', getSkillToolPrompt)]
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

async function snapshot(table: Row[]): Promise<Record<string, boolean>> {
  const seen: Record<string, boolean> = {}
  for (const row of table) seen[row.name] = await row.holds()
  return seen
}

async function fillAll(table: Row[]): Promise<void> {
  for (const row of table) await row.fill()
}

describe('clearSessionCaches', () => {
  const modes: Array<{ name: string; preserved: ReadonlySet<string> | undefined; survivors: (row: Row) => boolean }> = [
    { name: 'with no argument', preserved: undefined, survivors: () => false },
    { name: 'with an empty set', preserved: new Set(), survivors: () => false },
    { name: 'keeping one agent', preserved: new Set([KEPT_AGENT]), survivors: row => row.keptForAgents },
  ]

  for (const mode of modes) {
    test(`${mode.name}: every cache it owns is emptied, except what kept agents still need`, async () => {
      const table = [...rows(), ...lateRows()]
      await fillAll(table)
      expect(Object.values(await snapshot(table)).every(Boolean)).toBe(true)

      if (mode.preserved === undefined) clearSessionCaches()
      else clearSessionCaches(mode.preserved)
      await settle()

      const expected = Object.fromEntries(table.map(row => [row.name, mode.survivors(row)]))
      expect(await snapshot(table)).toEqual(expected)

      // Leave nothing behind for the next mode.
      clearSessionCaches()
      await settle()
    })
  }
})
