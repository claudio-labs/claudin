import { afterEach, describe, expect, test } from 'bun:test'

import { getClearTerminalSequence } from './clearTerminal.js'

const ERASE_SCROLLBACK = '\x1B[3J'
const ERASE_SCREEN = '\x1B[2J'
const CURSOR_HOME = '\x1B[H'
const CURSOR_HOME_WINDOWS = '\x1B[0f'

const originalPlatform = process.platform
const originalWtSession = process.env.WT_SESSION
const originalTermProgram = process.env.TERM_PROGRAM
const originalTermProgramVersion = process.env.TERM_PROGRAM_VERSION
const originalMsystem = process.env.MSYSTEM

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  setPlatform(originalPlatform)
  restoreEnv('WT_SESSION', originalWtSession)
  restoreEnv('TERM_PROGRAM', originalTermProgram)
  restoreEnv('TERM_PROGRAM_VERSION', originalTermProgramVersion)
  restoreEnv('MSYSTEM', originalMsystem)
})

describe('getClearTerminalSequence', () => {
  test('does not emit ERASE_SCROLLBACK on linux', () => {
    setPlatform('linux')
    const seq = getClearTerminalSequence()
    expect(seq).not.toContain(ERASE_SCROLLBACK)
  })

  test('does not emit ERASE_SCROLLBACK on darwin', () => {
    setPlatform('darwin')
    const seq = getClearTerminalSequence()
    expect(seq).not.toContain(ERASE_SCROLLBACK)
  })

  test('does not emit ERASE_SCROLLBACK on modern Windows Terminal', () => {
    setPlatform('win32')
    process.env.WT_SESSION = '00000000-0000-0000-0000-000000000000'
    delete process.env.TERM_PROGRAM
    delete process.env.MSYSTEM
    const seq = getClearTerminalSequence()
    expect(seq).not.toContain(ERASE_SCROLLBACK)
  })

  test('does not emit ERASE_SCROLLBACK on legacy Windows console', () => {
    setPlatform('win32')
    delete process.env.WT_SESSION
    delete process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM_VERSION
    delete process.env.MSYSTEM
    const seq = getClearTerminalSequence()
    expect(seq).not.toContain(ERASE_SCROLLBACK)
  })

  test('emits ERASE_SCREEN and CURSOR_HOME on linux', () => {
    setPlatform('linux')
    const seq = getClearTerminalSequence()
    expect(seq).toContain(ERASE_SCREEN)
    expect(seq).toContain(CURSOR_HOME)
    expect(seq).toBe(ERASE_SCREEN + CURSOR_HOME)
  })

  test('emits ERASE_SCREEN and CURSOR_HOME on darwin', () => {
    setPlatform('darwin')
    const seq = getClearTerminalSequence()
    expect(seq).toBe(ERASE_SCREEN + CURSOR_HOME)
  })

  test('emits ERASE_SCREEN and CURSOR_HOME on modern Windows Terminal', () => {
    setPlatform('win32')
    process.env.WT_SESSION = '00000000-0000-0000-0000-000000000000'
    delete process.env.TERM_PROGRAM
    delete process.env.MSYSTEM
    const seq = getClearTerminalSequence()
    expect(seq).toBe(ERASE_SCREEN + CURSOR_HOME)
  })

  test('emits ERASE_SCREEN and HVP cursor home on legacy Windows console', () => {
    setPlatform('win32')
    delete process.env.WT_SESSION
    delete process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM_VERSION
    delete process.env.MSYSTEM
    const seq = getClearTerminalSequence()
    expect(seq).toContain(ERASE_SCREEN)
    expect(seq).toBe(ERASE_SCREEN + CURSOR_HOME_WINDOWS)
  })
})
