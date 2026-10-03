/**
 * The /memory picker as the shipped build runs it.
 *
 * The build turns the TEAMMEM flag on, and `bun test` reads every `feature()`
 * as off, so under the plain runner this file has one test: it runs itself
 * again in a child `bun test --feature=TEAMMEM` and fails with the child's
 * output when anything there fails. The child runs the characterization.
 *
 * Every case gets its own temp world (config home, managed directory, project,
 * git home) and mounts the picker in a real Ink root on a fake terminal,
 * inside the app state and keybinding providers and a Suspense boundary, the
 * way `/memory` mounts it. The suite reads only the painted screen, the
 * callbacks and the files the picker writes.
 */
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as React from 'react'

import { recordConsolidation, rollbackConsolidationLock } from 'src/memory/autoDream/consolidationLock.js'
import { clearMemoryFileCaches, getMemoryFiles } from 'src/memory/instructions/claudemd.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import { getAutoMemPath, getMemoryBaseDir } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { parseBrowseValue, TIDY_VALUE } from 'src/memory/ui/memoryDirRows.js'
import { MemoryFileSelector } from 'src/memory/ui/MemoryFileSelector.js'
import { getMemoryPath } from 'src/platform/config/config/derived.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { formatRelativeTimeAgo } from 'src/shared/text/format.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { getAgentMemoryDir } from 'src/tools/AgentTool/agentMemory.js'

// `feature()` only folds when it is the condition of a ternary.
const SHIPPED_TEAMMEM = feature('TEAMMEM') ? true : false

if (!SHIPPED_TEAMMEM) {
  test('the picker characterization passes with TEAMMEM on, as the build ships it', async () => {
    const checkout = resolve(import.meta.dir, '..', '..', '..')
    const child = Bun.spawn([process.execPath, 'test', '--feature=TEAMMEM', import.meta.path], {
      cwd: checkout,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = `${stdout}\n${stderr}`
    const passing = Number(output.match(/(\d+) pass/)?.[1] ?? 0)
    const failing = Number(output.match(/(\d+) fail/)?.[1] ?? 1)
    if (code !== 0 || failing > 0 || passing === 0) {
      throw new Error(`the TEAMMEM run did not pass (exit ${code}):\n${output.slice(-8_000)}`)
    }
    expect(output).not.toMatch(/\d+ (skip|todo)/)
  }, 300_000)
} else {
  characterizePicker()
}

function characterizePicker(): void {
  const world = useMemdirWorld()
  const MOUNT = 30_000

  const UP = '\x1B[A'
  const DOWN = '\x1B[B'
  const ENTER = '\r'
  const ESC = '\x1B'

  // --- the world ---------------------------------------------------------------

  /** A git repository at <root>/repo, entered as the session's directory. */
  function gitProject(): string {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    w.enter(repo)
    return repo
  }

  type Agent = { agentType: string; memory?: 'user' | 'project' | 'local' }
  type Dream = 'running' | 'completed'

  function appState(agents: Agent[], dream?: Dream): AppState {
    const state = getDefaultAppState()
    const active = agents as unknown as AppState['agentDefinitions']['activeAgents']
    state.agentDefinitions = { activeAgents: active, allAgents: active }
    if (dream) {
      state.tasks = {
        'dream-1': { id: 'dream-1', type: 'dream', status: dream } as unknown as AppState['tasks'][string],
      }
    }
    return state
  }

  /** Stamps the last consolidation `hoursAgo` hours back, through the lock's own API. */
  async function dreamedHoursAgo(hoursAgo: number): Promise<number> {
    await recordConsolidation()
    const at = Date.now() - hoursAgo * 3_600_000
    await rollbackConsolidationLock(at)
    return at
  }

  function userSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(world().configDir, 'settings.json'), 'utf8'))
  }

  // --- reading the screen --------------------------------------------------------

  type Row = { label: string; description: string }
  type Focus = { on: 'row'; number: number } | { on: 'Auto-memory' | 'Auto-dream' } | { on: 'nothing' }

  const ROW_LINE = /^([❯↑↓ ]*?)(\d+)\. (.*)$/
  const TOGGLE_LINE = /^(❯?)\s*(Auto-memory|Auto-dream): (.*)$/
  const LABEL_AND_DESCRIPTION = /^(\s*\S.*?)(?:\s{2,}(\S.*))?$/
  const CHOSEN_MARK = / ✔$/

  function parseRow(rest: string): Row {
    const [, label = '', description = ''] = LABEL_AND_DESCRIPTION.exec(rest.trimEnd()) ?? []
    return { label: label.replace(CHOSEN_MARK, ''), description }
  }

  /** Each visible row's text after its number, untouched. */
  function visibleRows(screen: string): Map<number, string> {
    const rows = new Map<number, string>()
    for (const line of screen.split('\n')) {
      const match = ROW_LINE.exec(line)
      if (match) rows.set(Number(match[2]), match[3]!)
    }
    return rows
  }

  function toggleLines(screen: string): Map<string, string> {
    const toggles = new Map<string, string>()
    for (const line of screen.split('\n')) {
      const match = TOGGLE_LINE.exec(line)
      if (match) toggles.set(match[2]!, match[3]!.trimEnd())
    }
    return toggles
  }

  function focusOf(screen: string): Focus {
    for (const line of screen.split('\n')) {
      if (!line.includes('❯')) continue
      const toggle = TOGGLE_LINE.exec(line)
      if (toggle) return { on: toggle[2] as 'Auto-memory' | 'Auto-dream' }
      const row = ROW_LINE.exec(line)
      if (row) return { on: 'row', number: Number(row[2]) }
    }
    return { on: 'nothing' }
  }

  // --- the harness ----------------------------------------------------------------

  type Picker = {
    screen: () => string
    chosen: string[]
    cancels: () => number
    focus: () => Focus
    toggles: () => Map<string, string>
    /** Sends a key and waits until `changed` holds, sending it again if it was dropped. */
    press: (key: string, changed: () => boolean) => Promise<void>
    /** Sends a key that must change nothing, and gives it time to. */
    pressIdle: (key: string) => Promise<void>
    /** Moves the focus with one arrow key and waits for it to land. */
    move: (key: string) => Promise<Focus>
    /** Every row of the list, read by walking the focus down once around. */
    rows: () => Promise<Row[]>
    choose: () => Promise<string>
    close: () => Promise<void>
  }

  async function until(check: () => boolean, what: string, screen: () => string, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. Screen:\n${screen()}`)
      await Bun.sleep(15)
    }
  }

  async function openPicker(
    options: { counts?: { private: number; team: number }; agents?: Agent[]; dream?: Dream } = {},
  ): Promise<Picker> {
    // As `/memory` does: load the files before the picker suspends on them.
    clearMemoryFileCaches()
    await getMemoryFiles()

    const terminal = createFakeTerminal({ columns: 220 })
    const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
    const chosen: string[] = []
    let cancels = 0
    root.render(
      <AppStateProvider initialState={appState(options.agents ?? [], options.dream)}>
        <KeybindingSetup>
          <React.Suspense fallback={null}>
            <MemoryFileSelector
              onSelect={value => {
                chosen.push(value)
              }}
              onCancel={() => {
                cancels++
              }}
              dirCounts={options.counts}
            />
          </React.Suspense>
        </KeybindingSetup>
      </AppStateProvider>,
    )
    const screen = terminal.screen
    await until(() => focusOf(screen()).on === 'row', 'the first paint', screen)
    // The key handlers subscribe in an effect after the paint.
    await Bun.sleep(150)

    const press = async (key: string, changed: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 4; attempt++) {
        terminal.type(key)
        const settle = Date.now() + 1_500
        while (Date.now() < settle) {
          if (changed()) return
          await Bun.sleep(15)
        }
      }
      throw new Error(`${JSON.stringify(key)} changed nothing. Screen:\n${screen()}`)
    }

    const signature = () => JSON.stringify(focusOf(screen()))

    const picker: Picker = {
      screen,
      chosen,
      cancels: () => cancels,
      focus: () => focusOf(screen()),
      toggles: () => toggleLines(screen()),
      press,
      pressIdle: async key => {
        terminal.type(key)
        await Bun.sleep(400)
      },
      move: async key => {
        const before = signature()
        await press(key, () => signature() !== before)
        return focusOf(screen())
      },
      rows: async () => {
        const start = focusOf(screen())
        if (start.on !== 'row') throw new Error(`the list is not focused. Screen:\n${screen()}`)
        const all = new Map<number, string>()
        for (let step = 0; step < 40; step++) {
          for (const [n, text] of visibleRows(screen())) all.set(n, text)
          const now = await picker.move(DOWN)
          if (now.on === 'row' && now.number === start.number) break
        }
        // From ten rows on, a one-digit number is padded to line up with the
        // two-digit ones; that padding is the list's, not the label's.
        const width = String(all.size).length
        return [...all.keys()]
          .sort((a, b) => a - b)
          .map(n => parseRow(all.get(n)!.slice(width - String(n).length)))
      },
      choose: async () => {
        const before = chosen.length
        await press(ENTER, () => chosen.length > before)
        await Bun.sleep(100)
        expect(chosen.length).toBe(before + 1)
        return chosen.at(-1)!
      },
      close: async () => {
        root.unmount()
        terminal.close()
        await Bun.sleep(0)
      },
    }
    return picker
  }

  async function withPicker(
    options: Parameters<typeof openPicker>[0],
    check: (picker: Picker) => Promise<void>,
  ): Promise<void> {
    const picker = await openPicker(options)
    try {
      await check(picker)
    } finally {
      await picker.close()
    }
  }

  /** The folder rows, as computed from the paths the memory module resolves. */
  function folderRows(counts?: { private: number; team: number }): Row[] {
    return [
      {
        label: counts ? `Private memory · ${counts.private}` : 'Private memory',
        description: `Saved in ${getDisplayPath(getAutoMemPath())}`,
      },
      {
        label: counts ? `Team memory · ${counts.team}` : 'Team memory',
        description: `Shared with the team, git-tracked at ${getDisplayPath(getTeamMemPath())}`,
      },
      { label: 'Tidy memories', description: 'Merge duplicate memories and rebuild the index' },
    ]
  }

  const USER_ROW: Row = { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' }

  // --- the list ------------------------------------------------------------------------

  describe('MemoryFileSelector: the rows', () => {
    test(
      'a fresh repository: user and project memory, the private and team folders, tidy, then agent memories',
      async () => {
        gitProject()
        // The two indexes exist, and are still not listed as files.
        world().put(join(getAutoMemPath(), 'MEMORY.md'), '- [a](a.md) — a\n')
        world().put(join(getTeamMemPath(), 'MEMORY.md'), '- [b](b.md) — b\n')
        const agents: Agent[] = [
          { agentType: 'reviewer', memory: 'project' },
          { agentType: 'no-memory' },
          { agentType: 'writer', memory: 'user' },
          { agentType: 'scratch', memory: 'local' },
        ]

        await withPicker({ counts: { private: 3, team: 7 }, agents }, async picker => {
          expect(await picker.rows()).toEqual([
            USER_ROW,
            { label: 'Project memory', description: 'Checked in at ./AGENTS.md' },
            ...folderRows({ private: 3, team: 7 }),
            { label: 'reviewer agent memory', description: 'project scope' },
            { label: 'writer agent memory', description: 'user scope' },
            { label: 'scratch agent memory', description: 'local scope' },
          ])
          expect(picker.toggles()).toEqual(new Map([
            ['Auto-memory', 'on'],
            ['Auto-dream', 'off · never'],
          ]))
        })
      },
      MOUNT,
    )

    test(
      'outside a repository the project file is "Saved in", not "Checked in at"',
      async () => {
        await withPicker({}, async picker => {
          const rows = await picker.rows()
          expect(rows.slice(0, 2)).toEqual([USER_ROW, { label: 'Project memory', description: 'Saved in ./AGENTS.md' }])
          expect(rows.slice(2)).toEqual(folderRows())
        })
      },
      MOUNT,
    )

    test(
      'counts of zero are shown; no counts at all leave the number off',
      async () => {
        gitProject()
        await withPicker({ counts: { private: 0, team: 0 } }, async picker => {
          expect((await picker.rows()).slice(2)).toEqual(folderRows({ private: 0, team: 0 }))
        })
        await withPicker({}, async picker => {
          expect((await picker.rows()).slice(2)).toEqual(folderRows())
        })
      },
      MOUNT,
    )

    test(
      'files that exist come first, in load order: managed, user, project and its imports, rules, local',
      async () => {
        const repo = gitProject()
        const w = world()
        w.put(getMemoryPath('Managed'), '# managed\n')
        w.put(getMemoryPath('User'), '# mine\n')
        // CLAUDE.md stands in when there is no AGENTS.md.
        w.put(join(repo, 'CLAUDE.md'), '# project\n\n@./docs/guide.md\n')
        w.put(join(repo, 'docs', 'guide.md'), '# guide\n\n@./deep.md\n')
        w.put(join(repo, 'docs', 'deep.md'), '# deep\n')
        w.put(join(repo, '.claudin', 'rules', 'style.md'), '# style\n')
        w.put(join(repo, 'CLAUDE.local.md'), '# local\n')

        await withPicker({}, async picker => {
          expect(await picker.rows()).toEqual([
            { label: getDisplayPath(getMemoryPath('Managed')), description: '' },
            USER_ROW,
            { label: 'Project memory', description: 'Checked in at ./CLAUDE.md' },
            { label: 'L docs/guide.md', description: '@-imported' },
            { label: '  L docs/deep.md', description: '@-imported' },
            { label: '.claudin/rules/style.md', description: '' },
            { label: 'CLAUDE.local.md', description: '' },
            ...folderRows(),
          ])
        })
      },
      MOUNT,
    )

    test(
      'a missing user or project file still gets its row, with no mark that it is new',
      async () => {
        const repo = gitProject()
        world().put(join(repo, '.claudin', 'rules', 'only.md'), '# rule\n')
        await withPicker({}, async picker => {
          const labels = (await picker.rows()).map(row => row.label)
          // The rule exists, so it is listed first; the two missing files follow it.
          expect(labels.slice(0, 3)).toEqual(['.claudin/rules/only.md', 'User memory', 'Project memory'])
          expect(labels.join('\n')).not.toContain('(new)')
        })
      },
      MOUNT,
    )

    test(
      'a user-level rule is listed by its path',
      async () => {
        gitProject()
        const rule = world().put(join(world().configDir, 'rules', 'tone.md'), '# tone\n')
        await withPicker({}, async picker => {
          const labels = (await picker.rows()).map(row => row.label)
          expect(labels).toContain(getDisplayPath(rule))
          expect(labels.filter(label => label === 'User memory')).toHaveLength(1)
        })
      },
      MOUNT,
    )

    test(
      'started below the project file: "Project memory" is that file, with no second row for the start directory',
      async () => {
        const repo = gitProject()
        const w = world()
        w.put(join(repo, 'AGENTS.md'), '# root\n')
        const pkg = w.mkdir('repo', 'pkg')
        w.enter(pkg)

        await withPicker({}, async picker => {
          const rows = await picker.rows()
          expect(rows.map(row => row.label).slice(0, 2)).toEqual(['Project memory', 'User memory'])
          expect(await picker.choose()).toBe(join(repo, 'AGENTS.md'))
        })
      },
      MOUNT,
    )

    test(
      'auto memory off: only the instruction files, and no auto-dream line',
      async () => {
        gitProject()
        process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
        await withPicker({ counts: { private: 2, team: 5 }, agents: [{ agentType: 'reviewer', memory: 'project' }] }, async picker => {
          expect(await picker.rows()).toEqual([USER_ROW, { label: 'Project memory', description: 'Checked in at ./AGENTS.md' }])
          expect(picker.toggles()).toEqual(new Map([['Auto-memory', 'off']]))
        })
      },
      MOUNT,
    )
  })

  // --- what a row hands back ---------------------------------------------------------

  describe('MemoryFileSelector: choosing a row', () => {
    test(
      'Enter hands the caller a file path, a folder to browse, the tidy action or an agent folder',
      async () => {
        const repo = gitProject()
        const agents: Agent[] = [{ agentType: 'tools:reviewer', memory: 'project' }, { agentType: 'writer', memory: 'user' }]
        await withPicker({ counts: { private: 1, team: 1 }, agents }, async picker => {
          const values: string[] = []
          for (let row = 0; row < 7; row++) {
            values.push(await picker.choose())
            await picker.move(DOWN)
          }
          expect(values.slice(0, 2)).toEqual([join(world().configDir, 'CLAUDE.md'), join(repo, 'AGENTS.md')])
          expect(values.slice(2).map(value => parseBrowseValue(value) ?? value)).toEqual([
            { dir: getAutoMemPath(), title: 'Private memory', isTeamDir: false },
            { dir: getTeamMemPath(), title: 'Team memory', isTeamDir: true },
            TIDY_VALUE,
            { dir: getAgentMemoryDir('tools:reviewer', 'project'), title: 'tools:reviewer agent memory', isTeamDir: false },
            { dir: getAgentMemoryDir('writer', 'user'), title: 'writer agent memory', isTeamDir: false },
          ])
          expect(getAgentMemoryDir('writer', 'user').startsWith(getMemoryBaseDir())).toBe(true)
          expect(picker.cancels()).toBe(0)
        })
      },
      MOUNT,
    )

    test(
      'the picker reopens on the row chosen last, but never on tidy',
      async () => {
        gitProject()
        let picker = await openPicker()
        try {
          await picker.move(DOWN)
          await picker.move(DOWN)
          expect(parseBrowseValue(await picker.choose())?.title).toBe('Private memory')
        } finally {
          await picker.close()
        }

        picker = await openPicker()
        try {
          expect(picker.focus()).toEqual({ on: 'row', number: 3 })
          await picker.move(DOWN)
          await picker.move(DOWN)
          expect(await picker.choose()).toBe(TIDY_VALUE)
        } finally {
          await picker.close()
        }

        picker = await openPicker()
        try {
          expect(picker.focus()).toEqual({ on: 'row', number: 3 })
        } finally {
          await picker.close()
        }

        // Once that row is gone, the first row is focused again.
        process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
        picker = await openPicker()
        try {
          expect(picker.focus()).toEqual({ on: 'row', number: 1 })
        } finally {
          await picker.close()
        }
      },
      MOUNT * 2,
    )
  })

  // --- leaving -------------------------------------------------------------------------

  describe('MemoryFileSelector: cancelling', () => {
    for (const [name, key] of [['Esc', ESC], ['n', 'n']] as const) {
      test(
        `${name} cancels once and chooses nothing`,
        async () => {
          gitProject()
          await withPicker({}, async picker => {
            await picker.press(key, () => picker.cancels() > 0)
            await Bun.sleep(300)
            expect(picker.cancels()).toBe(1)
            expect(picker.chosen).toEqual([])
          })
        },
        MOUNT,
      )
    }
  })

  // --- the two switches ------------------------------------------------------------------

  describe('MemoryFileSelector: the auto-memory and auto-dream switches', () => {
    test(
      'Up from the first row climbs to Auto-dream, then Auto-memory, and stops; Down comes back to the list',
      async () => {
        gitProject()
        await withPicker({}, async picker => {
          expect(picker.focus()).toEqual({ on: 'row', number: 1 })
          expect(await picker.move(UP)).toEqual({ on: 'Auto-dream' })
          expect(await picker.move(UP)).toEqual({ on: 'Auto-memory' })
          await picker.pressIdle(UP)
          expect(picker.focus()).toEqual({ on: 'Auto-memory' })
          expect(await picker.move(DOWN)).toEqual({ on: 'Auto-dream' })
          expect(await picker.move(DOWN)).toEqual({ on: 'row', number: 1 })
        })
      },
      MOUNT,
    )

    test(
      'a focused switch takes Enter and y for itself: the list chooses nothing',
      async () => {
        gitProject()
        await withPicker({}, async picker => {
          await picker.move(UP)
          await picker.move(UP)
          await picker.press(ENTER, () => picker.toggles().get('Auto-memory') === 'off')
          expect(userSettings().autoMemoryEnabled).toBe(false)
          await picker.press('y', () => picker.toggles().get('Auto-memory') === 'on')
          expect(userSettings().autoMemoryEnabled).toBe(true)
          expect(picker.chosen).toEqual([])
          expect(picker.cancels()).toBe(0)
        })
      },
      MOUNT,
    )

    test(
      'switching auto memory off drops the folder rows at once; the auto-dream line stays',
      async () => {
        gitProject()
        await withPicker({ counts: { private: 4, team: 1 } }, async picker => {
          await picker.move(UP)
          await picker.move(UP)
          await picker.press(ENTER, () => picker.toggles().get('Auto-memory') === 'off')
          expect(picker.toggles().has('Auto-dream')).toBe(true)
          await picker.move(DOWN)
          await picker.move(DOWN)
          expect((await picker.rows()).map(row => row.label)).toEqual(['User memory', 'Project memory'])
        })
      },
      MOUNT,
    )

    test(
      'auto memory off when the picker opens: one switch; turning it on brings the folders back, not the dream line',
      async () => {
        gitProject()
        world().settings('user', { autoMemoryEnabled: false })
        await withPicker({ counts: { private: 1, team: 2 } }, async picker => {
          expect(picker.toggles()).toEqual(new Map([['Auto-memory', 'off']]))
          expect(await picker.move(UP)).toEqual({ on: 'Auto-memory' })
          await picker.press(ENTER, () => picker.toggles().get('Auto-memory') === 'on')
          expect(userSettings().autoMemoryEnabled).toBe(true)
          expect(picker.toggles().has('Auto-dream')).toBe(false)
          expect(await picker.move(DOWN)).toEqual({ on: 'row', number: 1 })
          expect((await picker.rows()).slice(2)).toEqual(folderRows({ private: 1, team: 2 }))
        })
      },
      MOUNT,
    )

    test(
      'Enter on Auto-dream switches it and writes autoDreamEnabled to the user settings',
      async () => {
        gitProject()
        await withPicker({}, async picker => {
          expect(await picker.move(UP)).toEqual({ on: 'Auto-dream' })
          await picker.press(ENTER, () => picker.toggles().get('Auto-dream')?.startsWith('on') === true)
          expect(picker.toggles().get('Auto-dream')).toBe('on · never · /dream to run')
          expect(userSettings().autoDreamEnabled).toBe(true)
          await picker.press(ENTER, () => picker.toggles().get('Auto-dream')?.startsWith('off') === true)
          expect(picker.toggles().get('Auto-dream')).toBe('off · never')
          expect(userSettings().autoDreamEnabled).toBe(false)
        })
      },
      MOUNT,
    )
  })

  // --- the dream status --------------------------------------------------------------------

  describe('MemoryFileSelector: what the auto-dream line says', () => {
    const cases: Array<{ name: string; on: boolean; hoursAgo?: number; dream?: Dream; line: (at?: number) => string }> = [
      { name: 'never run, switched off', on: false, line: () => 'off · never' },
      { name: 'never run, switched on: how to run it', on: true, line: () => 'on · never · /dream to run' },
      {
        name: 'run before, switched on',
        on: true,
        hoursAgo: 3,
        line: at => `on · last ran ${formatRelativeTimeAgo(new Date(at!))} · /dream to run`,
      },
      {
        name: 'run before, switched off',
        on: false,
        hoursAgo: 30,
        line: at => `off · last ran ${formatRelativeTimeAgo(new Date(at!))}`,
      },
      { name: 'running now, switched on: no hint', on: true, hoursAgo: 3, dream: 'running', line: () => 'on · running' },
      { name: 'running now, switched off', on: false, dream: 'running', line: () => 'off · running' },
      { name: 'a finished dream task is not running', on: false, dream: 'completed', line: () => 'off · never' },
    ]

    for (const { name, on, hoursAgo, dream, line } of cases) {
      test(
        name,
        async () => {
          gitProject()
          if (on) world().settings('user', { autoDreamEnabled: true })
          const at = hoursAgo === undefined ? undefined : await dreamedHoursAgo(hoursAgo)
          await withPicker({ dream }, async picker => {
            const expected = line(at)
            await until(() => picker.toggles().get('Auto-dream') === expected, `"Auto-dream: ${expected}"`, picker.screen, 4_000)
          })
        },
        MOUNT,
      )
    }
  })
}
