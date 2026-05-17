import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { TerminalNotification } from '../ink/useTerminalNotification.js'
import { resetGlobalConfigForTests, saveGlobalConfig } from '../utils/config.js'

// -- Top-level mocks (must run before importing the SUT) --------------------

type ExecCall = { cmd: string; args: string[] }
const execCalls: ExecCall[] = []

const execFileNoThrowImpl = mock<
  (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string; error?: string }>
>(async () => ({ code: 0, stdout: '', stderr: '' }))

mock.module('../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: async (cmd: string, args: string[]) => {
    execCalls.push({ cmd, args })
    return execFileNoThrowImpl(cmd, args)
  },
  execFileNoThrowWithCwd: async (cmd: string, args: string[]) => {
    execCalls.push({ cmd, args })
    return execFileNoThrowImpl(cmd, args)
  },
  execSyncWithDefaults_DEPRECATED: () => ({ code: 0, stdout: '', stderr: '' }),
}))

const whichImpl = mock<(name: string) => Promise<string | null>>(
  async name => `/usr/bin/${name}`,
)
mock.module('../utils/which.js', () => ({
  which: (name: string) => whichImpl(name),
  whichSync: () => null,
}))

type EnvShape = {
  platform: 'darwin' | 'linux' | 'win32'
  terminal: string | null
  isSSH: () => boolean
  isWslEnvironment: () => boolean
}
const envState: EnvShape = {
  platform: 'linux',
  terminal: null,
  isSSH: () => false,
  isWslEnvironment: () => false,
}
mock.module('../utils/env.js', () => ({
  env: new Proxy({} as EnvShape, {
    get(_t, prop: keyof EnvShape) {
      return envState[prop]
    },
  }),
  // envDynamic.ts imports JETBRAINS_IDES as a named export; keep it real to avoid
  // module-binding errors in sibling test files that share this worker.
  JETBRAINS_IDES: [
    'pycharm','intellij','webstorm','phpstorm','rubymine','clion',
    'goland','rider','datagrip','appcode','dataspell','aqua','gateway',
    'fleet','jetbrains','androidstudio',
  ],
}))

mock.module('../utils/hooks.js', () => ({
  executeNotificationHooks: async () => {},
  // Stub all exports that modules in the same Bun worker might need.
  executeWorktreeRemoveHook: async () => {},
  executeWorktreeCreateHook: async () => {},
  hasWorktreeCreateHook: () => false,
  hasWorktreeRemoveHook: () => false,
  executePreToolUseHooks: async () => ({ decision: 'allow' as const }),
  executePostToolUseHooks: async () => {},
  executeStopHooks: async () => ({ decision: 'allow' as const }),
  executePreCompactHooks: async () => ({ decision: 'allow' as const }),
  executeUserPromptSubmitHooks: async () => ({ decision: 'allow' as const }),
  executeSubagentStopHooks: async () => ({ decision: 'allow' as const }),
  isEnabled: () => false,
  getHooks: () => ({}),
  getHooksByType: () => [],
  shouldEnableHookPrompts: () => false,
  getGlobalHookConfig: () => ({}),
  hasHooks: () => false,
  hasInstructionsLoadedHook: () => false,
  executeStartupHooks: async () => {},
  executeShutdownHooks: async () => {},
  executeInstructionsLoadedHooks: async () => ({ decision: 'allow' as const }),
}))

mock.module('./analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('../utils/log.js', () => ({
  logError: () => {},
  logForDebugging: () => {},
}))

// SUT — dynamic import so mock.module() above is applied first
const { _resetNotifierCachesForTests, sendNotification } = await import(
  './notifier.js'
)

const terminalStub: TerminalNotification = {
  notifyBell: () => {},
  notifyITerm2: () => {},
  notifyKitty: () => {},
  notifyGhostty: () => {},
  notifyOsc777: () => {},
  notifyOsc9Plain: () => {},
  progress: () => {},
}

beforeEach(() => {
  saveGlobalConfig(c => ({ ...c, preferredNotifChannel: 'os_native' }))
  execCalls.length = 0
  execFileNoThrowImpl.mockReset()
  execFileNoThrowImpl.mockImplementation(async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }))
  whichImpl.mockReset()
  whichImpl.mockImplementation(async name => `/usr/bin/${name}`)
  envState.platform = 'linux'
  envState.terminal = null
  envState.isSSH = () => false
  envState.isWslEnvironment = () => false
  _resetNotifierCachesForTests()
})

afterEach(() => {
  _resetNotifierCachesForTests()
})

afterAll(() => {
  resetGlobalConfigForTests()
})


describe('sendOsNative on macOS', () => {
  test('prefers terminal-notifier when available', async () => {
    envState.platform = 'darwin'
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls.map(c => c.cmd)).toEqual(['terminal-notifier'])
  })

  test('falls back to osascript when terminal-notifier is missing', async () => {
    envState.platform = 'darwin'
    whichImpl.mockImplementation(async name =>
      name === 'terminal-notifier' ? null : `/usr/bin/${name}`,
    )
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls.map(c => c.cmd)).toEqual(['osascript'])
  })

  test('falls back to osascript when terminal-notifier exits non-zero', async () => {
    envState.platform = 'darwin'
    execFileNoThrowImpl.mockImplementation(async (cmd: string) => {
      if (cmd === 'terminal-notifier') {
        return { code: 1, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls.map(c => c.cmd)).toEqual([
      'terminal-notifier',
      'osascript',
    ])
  })
})

describe('sendOsNative on Linux', () => {
  test('prefers notify-send when available', async () => {
    envState.platform = 'linux'
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls.map(c => c.cmd)).toEqual(['notify-send'])
  })

  test('falls back to kdialog when notify-send is missing', async () => {
    envState.platform = 'linux'
    whichImpl.mockImplementation(async name =>
      name === 'notify-send' ? null : `/usr/bin/${name}`,
    )
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls.map(c => c.cmd)).toEqual(['kdialog'])
  })
})

describe('sendOsNative on Windows', () => {
  test('invokes powershell.exe with Toast XML', async () => {
    envState.platform = 'win32'
    await sendNotification(
      { message: 'task done', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!.cmd).toBe('powershell.exe')
    expect(execCalls[0]!.args).toContain('-EncodedCommand')
  })
})

describe('sendOsNative on WSL (interop)', () => {
  test('routes through powershell.exe even though platform is linux', async () => {
    envState.platform = 'linux'
    envState.isWslEnvironment = () => true
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!.cmd).toBe('powershell.exe')
  })

  test('returns no_method_available when powershell.exe is unreachable', async () => {
    envState.platform = 'linux'
    envState.isWslEnvironment = () => true
    whichImpl.mockImplementation(async name =>
      name === 'powershell.exe' ? null : `/usr/bin/${name}`,
    )
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls).toHaveLength(0)
  })
})

describe('SSH safety', () => {
  test('skips os_native on a remote SSH host (non-WSL)', async () => {
    envState.platform = 'linux'
    envState.isSSH = () => true
    envState.isWslEnvironment = () => false
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls).toHaveLength(0)
  })

  test('still fires Toast under WSL even with SSH envs set', async () => {
    envState.platform = 'linux'
    envState.isSSH = () => true
    envState.isWslEnvironment = () => true
    await sendNotification(
      { message: 'm', notificationType: 'idle' },
      terminalStub,
    )
    expect(execCalls.map(c => c.cmd)).toEqual(['powershell.exe'])
  })
})
