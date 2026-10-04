/**
 * Characterization of BypassPermissionsModeDialog, the confirmation an
 * interactive session shows before it starts in bypassPermissions (from
 * --dangerously-skip-permissions, --permission-mode, or a `defaultMode` in any
 * settings file, a checkout's own included), unless a trusted settings layer
 * already recorded the skip. Written before the clean-base rewrite of
 * permissions/modeDialogs; the spec is docs/tech/rewrite/permissions/modeDialogs.md.
 *
 * Every answer but "accept" ends the process, so those answers are driven in a
 * child `bun test` of this same file, and the parent reads how it ended: the
 * exit code, whether the caller heard an acceptance, and the settings on disk.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { BypassPermissionsModeDialog } from 'src/permissions/ui/BypassPermissionsModeDialog.js'
import { isolatedWorld, KEYS, flat, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { hasSkipDangerousModePermissionPrompt } from 'src/platform/settings/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const ENDING = 'MODE_DIALOG_ENDING'

type Ending = { keys: string[]; report: string; project: string }

const ending: Ending | null = process.env[ENDING] ? (JSON.parse(process.env[ENDING]) as Ending) : null

if (ending) {
  // --- the child: one answer, then watch how the process ends ------------------
  test('answers the dialog and records how the process ends', async () => {
    const note = (line: string) => writeFileSync(ending.report, `${line}\n`, { flag: 'a' })
    process.on('exit', code => note(`exit ${code}`))
    setOriginalCwd(ending.project)
    resetSettingsCache()
    const screen = await mount(<BypassPermissionsModeDialog onAccept={() => note('accepted')} />)
    await screen.press(...ending.keys)
    await Bun.sleep(6_000)
    note('still running')
  }, SLOW)
} else {
  describe('BypassPermissionsModeDialog', () => {
    const world = isolatedWorld()
    const userSettings = () => join(world().config, 'settings.json')

    test(
      'warns what the mode does and who answers for it, and offers exit first',
      async () => {
        const screen = await mount(<BypassPermissionsModeDialog onAccept={() => {}} />, { columns: 100 })
        const text = flat(screen.text())
        expect(text).toContain('WARNING: Claudin running in Bypass Permissions mode')
        for (const fact of [
          'will not ask for your approval before running potentially dangerous commands',
          'sandboxed container/VM',
          'restricted internet access',
          'easily be restored if damaged',
          'you accept all responsibility for actions taken while running in Bypass Permissions mode',
          'https://code.claude.com/docs/en/security',
        ]) {
          expect(text).toContain(fact)
        }
        // The safe answer is first and focused: Enter alone never accepts.
        expect(text).toMatch(/❯ 1\. No, exit 2\. Yes, I accept/)
        expect(text).toContain('Esc to cancel')
      },
      SLOW,
    )

    const accepts: Array<{ how: string; keys: string[] }> = [
      { how: 'the arrow and Enter', keys: [KEYS.down, KEYS.enter] },
      { how: 'its number', keys: ['2'] },
    ]
    for (const { how, keys } of accepts) {
      test(
        `accepting by ${how} records the skip in the user settings, then tells the caller once`,
        async () => {
          writeFileSync(userSettings(), JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'] } }))
          resetSettingsCache()
          let accepted = 0
          let skipSeenByCaller: boolean | null = null
          const onAccept = () => {
            accepted += 1
            resetSettingsCache()
            skipSeenByCaller = hasSkipDangerousModePermissionPrompt()
          }
          const screen = await mount(<BypassPermissionsModeDialog onAccept={onAccept} />)
          await screen.press(...keys)
          expect(accepted).toBe(1)
          // Written before the caller hears of it, so the caller can rely on it.
          expect(skipSeenByCaller as boolean | null).toBe(true)
          expect(JSON.parse(readFileSync(userSettings(), 'utf8'))).toEqual({
            theme: 'dark',
            permissions: { allow: ['Read'] },
            skipDangerousModePermissionPrompt: true,
          })
          // Only the user's own file: the checkout gets nothing.
          expect(existsSync(join(world().project, '.claudin'))).toBe(false)
        },
        SLOW,
      )
    }

    test(
      'accepting still tells the caller when the user settings cannot be written, and the file stays as it was',
      async () => {
        writeFileSync(userSettings(), '{ not json')
        resetSettingsCache()
        let accepted = 0
        const screen = await mount(<BypassPermissionsModeDialog onAccept={() => (accepted += 1)} />)
        await screen.press('2')
        expect(accepted).toBe(1)
        expect(readFileSync(userSettings(), 'utf8')).toBe('{ not json')
        resetSettingsCache()
        expect(hasSkipDangerousModePermissionPrompt()).toBe(false)
      },
      SLOW,
    )

    // --- the answers that end the process ------------------------------------------
    async function endWith(keys: string[]): Promise<{ lines: string[]; settings: string }> {
      const report = join(world().home, 'report.log')
      writeFileSync(userSettings(), JSON.stringify({ theme: 'dark' }))
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '..', '..', '..'),
        env: {
          ...process.env,
          CLAUDIN_CONFIG_DIR: world().config,
          [ENDING]: JSON.stringify({ keys, report, project: world().project } satisfies Ending),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (!existsSync(report)) throw new Error(`the child left no report:\n${out}\n${err}`)
      const lines = readFileSync(report, 'utf8').trim().split('\n')
      return { lines, settings: readFileSync(userSettings(), 'utf8') }
    }

    const endings: Array<{ answer: string; keys: string[]; code: number }> = [
      { answer: 'Enter on the focused "No, exit"', keys: [KEYS.enter], code: 1 },
      { answer: '"1"', keys: ['1'], code: 1 },
      { answer: 'Esc', keys: [KEYS.esc], code: 0 },
    ]
    for (const { answer, keys, code } of endings) {
      test(
        `${answer} ends the process with exit code ${code}, without accepting or writing settings`,
        async () => {
          const { lines, settings } = await endWith(keys)
          expect(lines).toEqual([`exit ${code}`])
          expect(JSON.parse(settings)).toEqual({ theme: 'dark' })
        },
        60_000,
      )
    }

    test(
      'a single Ctrl+C neither accepts nor ends the process',
      async () => {
        const { lines, settings } = await endWith([KEYS.ctrlC])
        // The runner ends the child after the wait; what matters is that nothing came first.
        expect(lines[0]).toBe('still running')
        expect(lines).not.toContain('accepted')
        expect(JSON.parse(settings)).toEqual({ theme: 'dark' })
      },
      60_000,
    )
  })
}
