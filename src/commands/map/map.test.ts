import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { call, lastSyncLine, parseMapArgs } from 'src/commands/map/map.js'
import {
  RULE_MAP_KILLSWITCH,
  RULE_MAP_RELATIVE_PATH,
} from 'src/memory/instructions/ruleMapAutoSync.js'
import { resetRuleMapSyncForTesting } from 'src/memory/instructions/ruleMapScheduler.js'
import { generateRuleMap } from 'src/memory/instructions/rulesMapSync.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from 'src/platform/config/config.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'

// /map reads and writes the project root's map. The root is pointed at a
// throwaway repo, and the killswitch keeps `sync`/`annotate` from writing even
// there — both process-global, so both are put back after.
const savedKillswitch = process.env[RULE_MAP_KILLSWITCH]
const savedRoot = getProjectRoot()
let root = ''

beforeAll(() => {
  process.env[RULE_MAP_KILLSWITCH] = '1'
  root = mkdtempSync(join(tmpdir(), 'mapcmd-'))
  const tracked: string[] = []
  mkdirSync(join(root, 'src', 'core'), { recursive: true })
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(root, 'src', 'core', `f${i}.ts`), 'x\n')
    tracked.push(`src/core/f${i}.ts`)
  }
  mkdirSync(join(root, '.claudin', 'rules'), { recursive: true })
  writeFileSync(join(root, RULE_MAP_RELATIVE_PATH), generateRuleMap(tracked))
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
  setProjectRoot(root)
})
afterAll(() => {
  setProjectRoot(savedRoot)
  rmSync(root, { recursive: true, force: true })
  if (savedKillswitch === undefined) delete process.env[RULE_MAP_KILLSWITCH]
  else process.env[RULE_MAP_KILLSWITCH] = savedKillswitch
})
afterEach(() => {
  resetRuleMapSyncForTesting()
})

type Done = { result?: string; options?: Parameters<LocalJSXCommandOnDone>[1] }

async function runMap(args: string): Promise<Done> {
  const done: Done = {}
  const onDone = ((result?: string, options?: Done['options']) => {
    done.result = result
    done.options = options
  }) as LocalJSXCommandOnDone
  await call(onDone, { setAppState: () => {} } as never, args)
  return done
}

describe('parseMapArgs', () => {
  test('reads every subcommand, and status by default', () => {
    expect(parseMapArgs('')).toEqual({ kind: 'status' })
    for (const kind of ['status', 'sync', 'on', 'off', 'annotate'] as const) {
      expect(parseMapArgs(`  ${kind} `)).toEqual({ kind })
    }
    expect(parseMapArgs('explore')).toEqual({ kind: 'usage', arg: 'explore' })
  })
})

describe('lastSyncLine', () => {
  test('says when nothing ran yet', () => {
    expect(lastSyncLine(null, 0)).toBe('Last sync: none yet in this session')
  })

  test('names what a write moved, and marks an on-demand run', () => {
    expect(
      lastSyncLine(
        {
          at: 0,
          trigger: 'command',
          outcome: {
            status: 'healed',
            path: '.claudin/rules/search-strategy.md',
            changes: [{ path: 'src/tools/', from: 682, to: 751 }],
          },
        },
        120_000,
      ),
    ).toBe('Last sync: 2m ago (on demand), updated · src/tools/ 682→751')
  })

  test('gives the reason a sync wrote nothing', () => {
    expect(
      lastSyncLine(
        {
          at: 0,
          trigger: 'turn',
          outcome: { status: 'skipped', reason: 'uncommitted changes' },
        },
        5_000,
      ),
    ).toBe('Last sync: 5s ago, nothing written: it has uncommitted edits of yours')
  })
})

describe('/map', () => {
  test('off and on flip the per-project switch', async () => {
    const saved = getCurrentProjectConfig().ruleMapSyncDisabled
    try {
      const off = await runMap('off')
      expect(off.result).toContain('off for this project')
      expect(getCurrentProjectConfig().ruleMapSyncDisabled).toBe(true)

      const on = await runMap('on')
      expect(on.result).toContain('on for this project')
      expect(getCurrentProjectConfig().ruleMapSyncDisabled).toBeUndefined()
    } finally {
      saveCurrentProjectConfig(current => ({
        ...current,
        ruleMapSyncDisabled: saved,
      }))
    }
  })

  test('status names the map, its kind, its switch and its last sync, then the verbs', async () => {
    const status = await runMap('')
    const lines = status.result?.split('\n') ?? []
    expect(lines[0]).toBe('Navigation map · .claudin/rules/search-strategy.md')
    expect(status.result).toContain('Kind: generated')
    expect(status.result).toContain(`off everywhere (${RULE_MAP_KILLSWITCH} is set)`)
    expect(status.result).toContain('Last sync: none yet in this session')
    expect(status.result).toContain('Unexplained: 2 entries read')
    // One line of the verbs that apply — with the killswitch set, neither
    // project switch does — not the whole usage after every status.
    expect(lines.at(-1)).toBe('  /map sync · /map annotate')
    expect(status.result).not.toContain('Usage:')
    expect(status.options).toEqual({ display: 'system' })
  })

  test('sync reports why nothing was written, in the user\'s words', async () => {
    const sync = await runMap('sync')
    expect(sync.result).toBe(
      `Navigation map not synced: ${RULE_MAP_KILLSWITCH} is set.`,
    )
  })

  test('annotate hands the model the shared instructions', async () => {
    const annotate = await runMap('annotate')
    expect(annotate.options?.shouldQuery).toBe(true)
    const prompt = String(annotate.options?.metaMessages?.[0])
    expect(prompt).toContain('# Annotate the navigation map')
    expect(prompt).toContain('Only annotate what you actually read')
  })

  test('an unknown argument shows the usage', async () => {
    const usage = await runMap('explore')
    expect(usage.result).toContain('Unknown /map argument: explore')
    expect(usage.result).toContain('Usage:')
  })

  // Last: it writes the map the tests above read.
  test('sync writes a stale map and names what moved, then finds it current', async () => {
    delete process.env[RULE_MAP_KILLSWITCH]
    try {
      mkdirSync(join(root, 'src', 'grown'), { recursive: true })
      for (let i = 0; i < 40; i++) {
        writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
      }
      execFileSync('git', ['add', '-A', 'src'], { cwd: root, stdio: 'ignore' })

      const first = await runMap('sync')
      expect(first.result).toBe(
        `Navigation map · ${RULE_MAP_RELATIVE_PATH} · updated · src/ 4→44, src/grown/ (new, 40)`,
      )
      const second = await runMap('sync')
      expect(second.result).toBe('Navigation map already current.')
    } finally {
      process.env[RULE_MAP_KILLSWITCH] = '1'
    }
  })
})
