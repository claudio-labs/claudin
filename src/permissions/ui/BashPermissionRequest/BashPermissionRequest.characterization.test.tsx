/**
 * Characterization of the Bash permission dialog, written before the
 * clean-base rewrite of permissions/shellDialogs. The spec is
 * docs/tech/rewrite/permissions/shellDialogs.md.
 *
 * The dialog is reached the way the REPL reaches it: the request goes to
 * `PermissionRequest` with the real BashTool. What matters most here is the
 * rule "don't ask again" saves, so every allow-always row names the exact
 * rule and where it goes. A sed in-place edit takes another route, pinned in
 * the SedEdit suite. The classifier's part of the dialog only exists with
 * BASH_CLASSIFIER on; BashPermissionRequest.classifier.characterization.test.tsx
 * pins it in a flagged run.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { saveGlobalConfig } from 'src/platform/config/config.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import type { Tool } from 'src/tools/Tool.js'
import { flat, isolatedWorld, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, allowRule, answer, ask, type Ask, type Call, denied, managedRulesOnly, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const world = isolatedWorld()
const { enter, esc, tab, down, up } = KEYS
const BACKSPACE = '\x7f'
const CTRL_D = '\x04'
const erase = (n: number) => Array<string>(n).fill(BACKSPACE)
const typed = (text: string) => [...text]

const bashRule = (content: string) => ({ toolName: 'Bash', ruleContent: content })
/** What the permission check suggests for a command: one local allow rule. */
const suggesting = (...rules: Array<{ toolName: string; ruleContent?: string }>) => ({
  behavior: 'ask' as const,
  message: 'needs approval',
  suggestions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }],
})

const askBash = (command: string, over: Partial<Ask> = {}) =>
  ask({ tool: BashTool as unknown as Tool, input: { command }, permissionResult: suggesting(bashRule('rm:*')) as never, ...over })

const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))
const hintLine = (frame: string) => shown(frame).find(line => line.startsWith('Esc to cancel')) ?? ''

/** The dialog's own prefix guess settles after a parse; wait for the field to stop changing. */
async function settled(asked: Awaited<ReturnType<typeof askBash>>): Promise<void> {
  await Bun.sleep(250)
  await asked.screen.until(frame => frame.includes('Do you want to proceed?'), 'the question')
}

describe('BashPermissionRequest: what it shows', () => {
  test(
    'title, command, request description, question, three options and the hint line',
    async () => {
      const asked = await askBash('rm build', { description: 'Clean the build output' })
      await settled(asked)
      expect(shown(asked.screen.text())).toEqual([
        '─'.repeat(120),
        'Bash command',
        'rm build',
        'Clean the build output',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '2. Yes, and don’t ask again for: rm build:*',
        '3. No',
        'Esc to cancel · Tab to amend · ctrl+e to explain',
      ])
    },
    SLOW,
  )

  test(
    'the description the model gave inside the input is not shown; the request description is',
    async () => {
      const asked = await ask({
        tool: BashTool as unknown as Tool,
        input: { command: 'make all', description: 'Builds everything' },
        description: 'shown under the command',
        permissionResult: suggesting(bashRule('make all')) as never,
      })
      const text = asked.screen.text()
      expect(text).toContain('shown under the command')
      expect(text).not.toContain('Builds everything')
    },
    SLOW,
  )

  test(
    'with no suggestions there is no allow-always option',
    async () => {
      const asked = await askBash('rm build', { permissionResult: { behavior: 'ask', message: 'asking' } })
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )

  test(
    'suggestions on a passthrough result are not offered',
    async () => {
      const asked = await askBash('rm build', { permissionResult: { ...suggesting(bashRule('rm:*')), behavior: 'passthrough' } as never })
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )

  test(
    'managed policy keeps rules to itself: only Yes and No',
    async () => {
      managedRulesOnly(world().home)
      const asked = await askBash('rm build')
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )

  test(
    'the worker badge joins the title, and the reason for asking sits above the question',
    async () => {
      const asked = await askBash('rm build', {
        workerBadge: { name: 'builder', color: 'cyan' },
        permissionResult: { ...suggesting(bashRule('rm:*')), decisionReason: { type: 'other', reason: 'Deletes files' } } as never,
      })
      expect(shown(asked.screen.text())[1]).toBe('Bash command · @builder')
      expect(flat(asked.screen.text())).toContain('Deletes files Do you want to proceed?')
    },
    SLOW,
  )

  test(
    'the hint: "Tab to amend" only while Yes or No is focused and closed; ctrl+e only while the explainer is on',
    async () => {
      const asked = await askBash('rm build')
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · Tab to amend · ctrl+e to explain')
      await asked.screen.press(down)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · ctrl+e to explain')
      await asked.screen.press(down)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · Tab to amend · ctrl+e to explain')
      await asked.screen.press(tab)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · ctrl+e to explain')
      expect(optionLines(asked.screen.text())[2]).toMatch(/^❯ 3\. No/)
    },
    SLOW,
  )

  test(
    'with the explainer turned off the ctrl+e hint is gone',
    async () => {
      saveGlobalConfig(config => ({ ...config, permissionExplainerEnabled: false }))
      try {
        const asked = await askBash('rm build')
        expect(hintLine(asked.screen.text())).toBe('Esc to cancel · Tab to amend')
      } finally {
        saveGlobalConfig(config => ({ ...config, permissionExplainerEnabled: undefined }))
      }
    },
    SLOW,
  )

  test(
    'Tab on Yes opens a note field; moving away from it while empty closes it, with text it stays open',
    async () => {
      const asked = await askBash('rm build')
      await asked.screen.press(tab)
      expect(optionLines(asked.screen.text())[0]).toMatch(/^❯ 1\. Yes, /)
      await asked.screen.press(down)
      expect(optionLines(asked.screen.text())[0]).toBe('1. Yes')
      await asked.screen.press(up, tab, ...typed('later'), down)
      expect(optionLines(asked.screen.text())[0]).toBe('1. Yes, later')
    },
    SLOW,
  )

  test(
    'Tab on an open note closes it again, on Yes and on No',
    async () => {
      const asked = await askBash('rm build')
      await asked.screen.press(tab, ...typed('x'))
      expect(optionLines(asked.screen.text())[0]).toBe('❯ 1. Yes, x')
      await asked.screen.press(tab)
      expect(optionLines(asked.screen.text())[0]).toBe('❯ 1. Yes')
      await asked.screen.press(up, tab, ...typed('y'))
      expect(optionLines(asked.screen.text())[2]).toBe('❯ 3. No, y')
      await asked.screen.press(tab)
      expect(optionLines(asked.screen.text())[2]).toBe('❯ 3. No')
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · Tab to amend · ctrl+e to explain')
    },
    SLOW,
  )

  test(
    'ctrl+d swaps the question for the decision details and back; --debug adds the hints',
    async () => {
      const asked = await askBash('rm build', { debug: true })
      expect(flat(shown(asked.screen.text()).at(-1)!)).toBe('Esc to cancel · Tab to amend · ctrl+e to explain Ctrl+d to show debug info')
      await asked.screen.press(CTRL_D)
      const debug = asked.screen.text()
      expect(debug).not.toContain('Do you want to proceed?')
      expect(flat(debug)).toContain('Behavior ask')
      expect(flat(debug)).toContain('Bash(rm:*)')
      expect(shown(debug).at(-1)).toBe('Ctrl-D to hide debug info')
      await asked.screen.press(CTRL_D)
      expect(asked.screen.text()).toContain('Do you want to proceed?')
    },
    SLOW,
  )

  test(
    'with the details shown there is no list, so Esc does nothing',
    async () => {
      const asked = await askBash('rm build')
      expect(await answer(asked, [CTRL_D, esc])).toEqual([])
      expect(asked.screen.state().attribution.escapeCount).toBe(0)
    },
    SLOW,
  )

  test(
    'without --debug, ctrl+d still shows the details, with no hint to hide them',
    async () => {
      const asked = await askBash('rm build')
      await asked.screen.press(CTRL_D)
      expect(flat(asked.screen.text())).toContain('Behavior ask')
      expect(asked.screen.text()).not.toContain('Ctrl-D')
      expect(asked.screen.text()).not.toContain('Ctrl+d')
    },
    SLOW,
  )

  describe('the title follows the sandbox', () => {
    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore()
    })
    const spies: Array<{ mockRestore: () => void }> = []
    // Whether the host can sandbox is the OS boundary; the user's excluded
    // commands come from a real settings file.
    const rows: Array<[string, boolean, string, string]> = [
      ['sandbox off', false, 'docker ps', 'Bash command'],
      ['sandbox on, the command runs inside it', true, 'rm build', 'Bash command'],
      ['sandbox on, a command the user excluded from it', true, 'docker ps', 'Bash command (unsandboxed)'],
    ]
    for (const [name, on, command, title] of rows) {
      test(
        name,
        async () => {
          writeFileSync(join(world().config, 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['docker:*'] } }))
          resetSettingsCache()
          spies.push(spyOn(SandboxManager, 'isSandboxingEnabled').mockImplementation(() => on))
          const asked = await askBash(command)
          expect(shown(asked.screen.text())[1]).toBe(title)
        },
        SLOW,
      )
    }
  })
})

describe('BashPermissionRequest: what each answer reports', () => {
  const INPUT = { command: 'rm build' }
  const RULE = (content: string) => [allowRule('Bash', content)]
  type Row = { name: string; keys: string[]; calls: Call[]; escapes: number; argc?: number; managed?: boolean }
  const rows: Row[] = [
    { name: 'Enter on Yes: allow once, nothing saved, no note', keys: [enter], calls: allowed(INPUT, [], undefined), escapes: 0, argc: 3 },
    { name: '1: allow once', keys: ['1'], calls: allowed(INPUT, [], undefined), escapes: 0, argc: 3 },
    { name: 'Yes with a note: the note, trimmed', keys: [tab, ...typed('  then run tests  '), enter], calls: allowed(INPUT, [], 'then run tests'), escapes: 0 },
    { name: 'a note written, its field closed again: the hidden note still goes', keys: [tab, ...typed('hidden'), tab, enter], calls: allowed(INPUT, [], 'hidden'), escapes: 0 },
    { name: 'Yes with the note left empty: no note', keys: [tab, enter], calls: allowed(INPUT, [], undefined), escapes: 0, argc: 3 },
    { name: '2: allow always with the suggested prefix, saved locally', keys: ['2'], calls: allowed(INPUT, RULE('rm build:*')), escapes: 0, argc: 2 },
    { name: 'Down, Enter: the same', keys: [down, enter], calls: allowed(INPUT, RULE('rm build:*')), escapes: 0 },
    { name: 'the prefix edited to an exact command', keys: [down, ...erase(2), enter], calls: allowed(INPUT, RULE('rm build')), escapes: 0 },
    { name: 'the prefix edited with spaces around it: saved trimmed', keys: [down, ...typed('   '), enter], calls: allowed(INPUT, RULE('rm build:*')), escapes: 0 },
    { name: 'the prefix rewritten', keys: [down, ...erase(10), ...typed('rm build/cache:*'), enter], calls: allowed(INPUT, RULE('rm build/cache:*')), escapes: 0 },
    { name: 'the prefix cleared: allow once, nothing saved', keys: [down, ...erase(10), enter], calls: allowed(INPUT, []), escapes: 0, argc: 2 },
    { name: '3: deny with no note, counted as an escape', keys: ['3'], calls: denied(), escapes: 1 },
    { name: 'No with a note: the note, trimmed, not counted', keys: [down, down, tab, ...typed(' use git clean '), enter], calls: denied('use git clean'), escapes: 0 },
    { name: 'No with a blank note: a plain deny, counted', keys: [down, down, tab, ...typed('   '), enter], calls: denied(), escapes: 1 },
    { name: 'Esc: deny, counted', keys: [esc], calls: denied(), escapes: 1 },
    { name: 'Esc with a Yes note written: the note is dropped', keys: [tab, ...typed('ok'), esc], calls: denied(), escapes: 1 },
    { name: 'Up from Yes wraps to No', keys: [up, enter], calls: denied(), escapes: 1 },
    { name: 'y, n and a digit past the list: nothing', keys: ['y', 'n', '4'], calls: [], escapes: 0 },
    { name: 'managed policy: 2 is No', keys: ['2'], calls: denied(), escapes: 1, managed: true },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        if (row.managed) managedRulesOnly(world().home)
        const asked = await askBash('rm build')
        await settled(asked)
        const calls = await answer(asked, row.keys)
        expect(calls).toEqual(row.calls)
        if (row.argc !== undefined) expect((calls[0] as { args: unknown[] }).args).toHaveLength(row.argc)
        expect(asked.screen.state().attribution.escapeCount).toBe(row.escapes)
      },
      SLOW,
    )
  }

  test(
    'the dialog tells the request about the user only when focus moves or a note opens',
    async () => {
      let touches = 0
      const asked = await askBash('rm build', { confirm: { onUserInteraction: () => touches++ } })
      expect(touches).toBe(0)
      await asked.screen.press(down)
      expect(touches).toBe(1)
      await asked.screen.press(up)
      expect(touches).toBe(2)
      await asked.screen.press(tab)
      expect(touches).toBe(3)
    },
    SLOW,
  )
})

describe('BashPermissionRequest: the rule "don\'t ask again" saves', () => {
  // The permission check's own suggestion is the exact command; the dialog
  // replaces it with its prefix guess. `rm build` keeps its second word.
  // `git status && ls` is read-only throughout, so the parse offers nothing
  // and the first guess is saved. An open quote is dropped by the parse.
  // Each line: the command, then the rule content saved for it.
  const table = `
rm build  =>  rm build:*
rm build/out  =>  rm:*
rm -rf /tmp/x  =>  rm:*
npm run test  =>  npm run:*
git push origin main  =>  git push:*
docker compose up -d  =>  docker compose up:*
ls  =>  ls:*
python3 script.py  =>  python3:*
./run.sh  =>  ./run.sh:*
FOO=1 npm test  =>  FOO=1 npm test:*
NODE_ENV=production npm run build  =>  NODE_ENV=production npm run:*
sudo rm build  =>  sudo rm:*
xargs rm  =>  xargs rm:*
timeout 5 rm build  =>  timeout 5 rm build:*
cd src && npm test  =>  npm test:*
echo a\\nrm b  =>  rm b:*
echo hi > out.txt  =>  echo hi:*
npm test | tee log  =>  npm test:*
git status && ls  =>  git status:*
npm run "build  =>  npm run:*
python3 "a b  =>  python3 a:*
./run.sh "x  =>  ./run.sh x:*
`
  const rows = table.trim().split('\n').map(line => line.split('  =>  ').map(part => part.replaceAll('\\n', '\n')) as [string, string])
  for (const [command, rule] of rows) {
    test(
      `${JSON.stringify(command)} saves Bash(${rule}) locally`,
      async () => {
        const asked = await askBash(command, { permissionResult: suggesting(bashRule(command)) as never })
        await settled(asked)
        expect(optionLines(asked.screen.text())[1]).toBe(`2. Yes, and don’t ask again for: ${rule.split('\n')[0]}`)
        expect(await answer(asked, ['2'])).toEqual(allowed({ command }, [allowRule('Bash', rule)]))
      },
      SLOW,
    )
  }

  const compound = (reasonsFor: string[]) => ({ type: 'subcommandResults', reasons: new Map(reasonsFor.map(c => [c, { behavior: 'ask', message: c }])) })

  test(
    'a compound command whose check found one rule: the field starts from that rule',
    async () => {
      const command = 'cd src && npm run lint -- --fix'
      const asked = await askBash(command, {
        permissionResult: { ...suggesting(bashRule('npm run lint:*')), decisionReason: compound(['cd src', 'npm run lint -- --fix']) } as never,
      })
      await settled(asked)
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, and don’t ask again for: npm run lint:*')
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, [allowRule('Bash', 'npm run lint:*')]))
    },
    SLOW,
  )

  test(
    'a compound command with two rules: a fixed label, and every suggestion saved as it came',
    async () => {
      const command = 'npm test && git push'
      const suggestions = [
        { type: 'addRules', rules: [bashRule('npm test:*')], behavior: 'allow', destination: 'localSettings' },
        { type: 'addRules', rules: [bashRule('git push:*')], behavior: 'allow', destination: 'projectSettings' },
      ]
      const asked = await askBash(command, {
        permissionResult: { behavior: 'ask', message: 'asking', suggestions, decisionReason: compound(['npm test', 'git push']) } as never,
      })
      await settled(asked)
      expect(flat(optionLines(asked.screen.text()).join(' '))).toContain(
        `2. Yes, and don't ask again for npm test and git push commands in ${getOriginalCwd()}`,
      )
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, suggestions))
    },
    SLOW,
  )

  test(
    'a compound command with no Bash rule: the suggestions decide the label',
    async () => {
      const command = 'cat notes/a.md && ls'
      const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/srv/notes/**' }], behavior: 'allow', destination: 'session' }]
      const asked = await askBash(command, { permissionResult: { behavior: 'ask', message: 'asking', suggestions, decisionReason: compound(['cat notes/a.md', 'ls']) } as never })
      await settled(asked)
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, allow reading from notes/ from this project')
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, suggestions))
    },
    SLOW,
  )

  test(
    'a directory among the suggestions: no field; a label naming the directory and the commands, without redirection targets',
    async () => {
      const command = 'cat a > /srv/out/log.txt'
      const suggestions = [
        { type: 'addRules', rules: [bashRule('cat a > /srv/out/log.txt')], behavior: 'allow', destination: 'localSettings' },
        { type: 'addDirectories', directories: ['/srv/out'], destination: 'session' },
      ]
      const asked = await askBash(command, { permissionResult: { behavior: 'ask', message: 'asking', suggestions } as never })
      await settled(asked)
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, and allow access to out/ and cat a commands')
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, suggestions))
    },
    SLOW,
  )

  test(
    'only a whole-tool rule suggested: no label can be made, so no allow-always option',
    async () => {
      const asked = await askBash('rm build', { permissionResult: { behavior: 'ask', message: 'asking', suggestions: [{ type: 'addDirectories', directories: [], destination: 'session' }] } as never })
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )
})
