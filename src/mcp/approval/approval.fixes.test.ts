/**
 * mcp/approvalDialogs: the spec's "fix" findings that the characterization
 * suites leave unpinned, driven through the plain functions behind the dialogs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  type ApprovalAnswer,
  applyApprovalAnswer,
  type LocalLists,
  type LocalListsUpdate,
  localListsUpdate,
} from 'src/mcp/approval/answer.js'
import {
  type DesktopImportDeps,
  executeDesktopImport,
  planDesktopImport,
  runDesktopImport,
} from 'src/mcp/approval/desktopImport.js'
import { pendingProjectServers } from 'src/mcp/approval/pending.js'
import {
  enterWorld,
  leaveWorld,
  type Json,
  userServersOnRecord,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import type { McpServerConfig } from 'src/mcp/types.js'
import { getProjectMcpServerStatus } from 'src/mcp/utils.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const stdio = (command: string): McpServerConfig => ({ command, args: [] })

describe('finding 2: an answer appends to the local layer only', () => {
  let world: World
  beforeEach(() => {
    world = enterWorld()
  })
  afterEach(() => {
    leaveWorld()
  })
  const localFile = () => join(world.project, '.claudin', 'settings.local.json')
  const readLocal = (): Json | null => (existsSync(localFile()) ? (JSON.parse(readFileSync(localFile(), 'utf8')) as Json) : null)

  type Case = { name: string; layers: Partial<Record<'user' | 'project', Json>>; answer: ApprovalAnswer; local: Json; approved: string[]; rejected: string[] }
  const cases: Case[] = [
    {
      name: 'approving copies no other layer into the local file',
      layers: { user: { enabledMcpjsonServers: ['from-user'] }, project: { enabledMcpjsonServers: ['from-repo'] } },
      answer: { approve: ['github'], reject: [], enableAll: false },
      local: { enabledMcpjsonServers: ['github'] },
      approved: ['from-user', 'from-repo', 'github'],
      rejected: [],
    },
    {
      name: 'rejecting copies no other layer into the local file',
      layers: { user: { disabledMcpjsonServers: ['from-user'] }, project: { enabledMcpjsonServers: ['from-repo'] } },
      answer: { approve: [], reject: ['github'], enableAll: false },
      local: { disabledMcpjsonServers: ['github'] },
      approved: ['from-repo'],
      rejected: ['from-user', 'github'],
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      for (const [layer, content] of Object.entries(c.layers)) writeSettings(layer as 'user' | 'project', content)
      resetSettingsCache()
      applyApprovalAnswer(c.answer)
      expect(readLocal()).toEqual(c.local)
      resetSettingsCache()
      for (const name of c.approved) expect(getProjectMcpServerStatus(name)).toBe('approved')
      for (const name of c.rejected) expect(getProjectMcpServerStatus(name)).toBe('rejected')
    })
  }

  test("a repository's self-approval does not outlive its removal", () => {
    writeSettings('project', { enabledMcpjsonServers: ['from-repo'] })
    resetSettingsCache()
    applyApprovalAnswer({ approve: ['github'], reject: [], enableAll: false })
    writeSettings('project', {})
    resetSettingsCache()
    expect(getProjectMcpServerStatus('from-repo')).toBe('pending')
  })
})

describe('the answer writer', () => {
  const lists = (enabled: string[] = [], disabled: string[] = []): LocalLists => ({ enabled, disabled })
  type Case = { name: string; answer: ApprovalAnswer; current: LocalLists; update: LocalListsUpdate | null }
  const cases: Case[] = [
    { name: 'nothing new writes nothing', answer: { approve: ['a'], reject: ['b'], enableAll: false }, current: lists(['a'], ['b']), update: null },
    { name: 'repeats within one answer are dropped', answer: { approve: ['a', 'a'], reject: [], enableAll: false }, current: lists(), update: { enabledMcpjsonServers: ['a'] } },
    { name: 'the switch alone', answer: { approve: ['a'], reject: [], enableAll: true }, current: lists(['a']), update: { enableAllProjectMcpServers: true } },
    {
      name: 'both lists, appended after what is there',
      answer: { approve: ['c'], reject: ['d'], enableAll: false },
      current: lists(['a'], ['b']),
      update: { enabledMcpjsonServers: ['a', 'c'], disabledMcpjsonServers: ['b', 'd'] },
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(localListsUpdate(c.answer, c.current)).toEqual(c.update)
      const writes: LocalListsUpdate[] = []
      applyApprovalAnswer(c.answer, { readLocalLists: () => c.current, writeLocalLists: update => writes.push(update) })
      expect(writes).toEqual(c.update === null ? [] : [c.update])
    })
  }
})

describe('who is pending', () => {
  test('keeps the project-scope order and drops decided servers', () => {
    const status: Record<string, 'approved' | 'rejected' | 'pending'> = { z: 'pending', a: 'approved', m: 'pending', r: 'rejected' }
    expect(pendingProjectServers({ projectServerNames: () => ['z', 'a', 'm', 'r'], statusOf: name => status[name]! })).toEqual(['z', 'm'])
  })
})

describe('the import plan', () => {
  const servers = { github: stdio('gh'), github_1: stdio('gh1'), notes: stdio('n') }
  test('renames past existing and earlier planned names, keeps the order, skips the unselected', () => {
    expect(planDesktopImport(servers, ['github', 'github_1'], new Set(['github'])).map(e => [e.name, e.finalName])).toEqual([
      ['github', 'github_1'],
      ['github_1', 'github_1_1'],
    ])
  })
})

describe('finding 6: a refused server does not stop the import', () => {
  function recorder(refuse: (name: string) => string | null) {
    const out: string[] = []
    const err: string[] = []
    const added: string[] = []
    const exits: Array<number | undefined> = []
    const deps: DesktopImportDeps = {
      add: async name => {
        const reason = refuse(name)
        if (reason !== null) throw new Error(reason)
        added.push(name)
      },
      writeOut: text => out.push(text),
      writeErr: text => err.push(text),
      successColour: text => `<${text}>`,
      shutdown: async (...args: [number?]) => {
        exits.push(args.length === 0 ? undefined : args[0])
      },
    }
    return { deps, out, err, added, exits }
  }
  const servers = { first: stdio('1'), 'bad name': stdio('2'), last: stdio('3') }

  test('the others are imported, each refusal is reported with its reason, and the process ends once', async () => {
    const r = recorder(name => (name.includes(' ') ? 'names may not contain spaces' : null))
    let done = 0
    await runDesktopImport({ servers, selected: Object.keys(servers), existing: new Set(), scope: 'user' }, () => (done += 1), r.deps)
    expect(r.added).toEqual(['first', 'last'])
    expect(r.err).toEqual(['Could not import bad name: names may not contain spaces\n'])
    expect(r.out).toEqual(['\n<Successfully imported 2 MCP servers to user config.>\n'])
    expect(done).toBe(1)
    expect(r.exits).toEqual([1])
  })

  test('every server refused: says none were imported and still ends', async () => {
    const r = recorder(() => 'denied by policy')
    let done = 0
    await runDesktopImport({ servers, selected: ['first'], existing: new Set(), scope: 'local' }, () => (done += 1), r.deps)
    expect(r.err).toEqual(['Could not import first: denied by policy\n'])
    expect(r.out).toEqual(['\nNo servers were imported.'])
    expect(done).toBe(1)
    expect(r.exits).toEqual([1])
  })

  test('nothing refused ends the process without an exit code', async () => {
    const r = recorder(() => null)
    await runDesktopImport({ servers, selected: ['first'], existing: new Set(), scope: 'user' }, () => {}, r.deps)
    expect(r.err).toEqual([])
    expect(r.exits).toEqual([undefined])
  })

  test('a non-Error refusal is reported by its text', async () => {
    const outcome = await executeDesktopImport(planDesktopImport(servers, ['first'], new Set()), 'user', async () => {
      throw 'plain refusal'
    })
    expect(outcome.refused).toEqual([{ finalName: 'first', reason: 'plain refusal' }])
  })

  describe('against the real config writer', () => {
    beforeEach(() => {
      enterWorld()
    })
    afterEach(() => {
      leaveWorld()
    })
    test('a Claude Desktop name with a space is refused and the rest still land', async () => {
      const r = recorder(() => null)
      const { addMcpConfig } = await import('src/mcp/config.js')
      await runDesktopImport(
        { servers, selected: Object.keys(servers), existing: new Set(), scope: 'user' },
        () => {},
        { ...r.deps, add: addMcpConfig },
      )
      expect(Object.keys(userServersOnRecord() ?? {})).toEqual(['first', 'last'])
      expect(r.err).toHaveLength(1)
      expect(r.err[0]).toStartWith('Could not import bad name: ')
      expect(r.exits).toEqual([1])
    })
  })
})
