import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getClientType,
  getIsInteractive,
  getQuestionPreviewFormat,
  getSessionSource,
  setClientType,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'
import { applyClientType, resolveClientType } from 'src/platform/main/clientType.js'

const ENV_KEYS = [
  'GITHUB_ACTIONS',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDIN_QUESTION_PREVIEW_FORMAT',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const savedArgv = process.argv
const savedTty = process.stdout.isTTY
const savedState = { clientType: getClientType(), interactive: getIsInteractive() }

function run(args: string[], tty = true) {
  process.argv = ['bun', 'claudin', ...args]
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true })
  return resolveClientType()
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  process.argv = savedArgv
  Object.defineProperty(process.stdout, 'isTTY', { value: savedTty, configurable: true })
  setClientType(savedState.clientType)
  setIsInteractive(savedState.interactive)
})

describe('resolveClientType — the client', () => {
  test.each([
    [{ GITHUB_ACTIONS: 'true' }, 'github-action'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, 'sdk-typescript'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }, 'sdk-python'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, 'sdk-cli'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, 'claude-vscode'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'local-agent' }, 'local-agent'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, 'claude-desktop'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'remote' }, 'remote'],
    [{ CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'tok' }, 'remote'],
    [{}, 'cli'],
  ] as const)('%o → %s', (env, expected) => {
    Object.assign(process.env, env)
    expect(run([]).clientType).toBe(expected)
  })

  test('the preview format: an explicit one wins, the CLI defaults to markdown, SDKs and desktop keep theirs', () => {
    expect(run([]).previewFormat).toBe('markdown')
    process.env.CLAUDIN_QUESTION_PREVIEW_FORMAT = 'html'
    expect(run([]).previewFormat).toBe('html')
    delete process.env.CLAUDIN_QUESTION_PREVIEW_FORMAT
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    expect(run([]).previewFormat).toBeUndefined()
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    expect(run([]).previewFormat).toBeUndefined()
  })

  test('remote-control comes from the bridge environment', () => {
    expect(run([]).sessionSource).toBeUndefined()
    process.env.CLAUDE_CODE_ENVIRONMENT_KIND = 'bridge'
    expect(run([]).sessionSource).toBe('remote-control')
  })
})

describe('resolveClientType — interactivity', () => {
  test('a terminal with no print flag is interactive', () => {
    expect(run([]).isInteractive).toBe(true)
    expect(run(['--resume', 'abc']).isInteractive).toBe(true)
  })

  test.each([
    [['-p', 'hi']],
    [['--print', 'hi']],
    [['--init-only']],
    [['--sdk-url', 'wss://x']],
    [['--sdk-url=wss://x']],
  ])('%o is not interactive', args => {
    expect(run(args).isInteractive).toBe(false)
  })

  test('stdout that is not a terminal is not interactive', () => {
    expect(run([], false).isInteractive).toBe(false)
  })
})

describe('applyClientType', () => {
  test('writes the resolved values to the session state', () => {
    applyClientType({ clientType: 'sdk-cli', previewFormat: 'html', sessionSource: 'remote-control', isInteractive: false, isOneShotPrint: false })
    expect(getClientType()).toBe('sdk-cli')
    expect(getQuestionPreviewFormat()).toBe('html')
    expect(getSessionSource()).toBe('remote-control')
    expect(getIsInteractive()).toBe(false)
  })

  test('an undefined preview format or session source leaves the current one', () => {
    applyClientType({ clientType: 'cli', previewFormat: 'markdown', sessionSource: 'remote-control', isInteractive: true, isOneShotPrint: false })
    applyClientType({ clientType: 'cli', previewFormat: undefined, sessionSource: undefined, isInteractive: true, isOneShotPrint: false })
    expect(getQuestionPreviewFormat()).toBe('markdown')
    expect(getSessionSource()).toBe('remote-control')
  })
})

// The -p cache tier (`CLAUDIN_MAIN_CACHE_TTL=auto`, cacheControl.ts) keys on
// this: a print run with one prompt, as opposed to an SDK session that streams
// turns in with a person behind them.
describe('resolveClientType — one-shot print', () => {
  test.each([
    [['-p', 'hi'], true],
    [['--print', 'hi'], true],
    [['-p', 'hi', '--resume', 'abc'], true],
    [['-p', '--input-format', 'text', 'hi'], true],
    [['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], false],
    [['-p', '--input-format=stream-json', '--output-format=stream-json'], false],
    [['-p', 'hi', '--sdk-url', 'wss://x'], false],
    [[], false],
  ] as const)('%o → %s', (args, expected) => {
    expect(run([...args]).isOneShotPrint).toBe(expected)
  })

  test('a pipe without a print flag is not one', () => {
    expect(run([], false).isOneShotPrint).toBe(false)
  })

  test('applyClientType writes it', async () => {
    const { getIsOneShotPrint } = await import('src/platform/bootstrap/state.js')
    applyClientType({ clientType: 'cli', previewFormat: undefined, sessionSource: undefined, isInteractive: false, isOneShotPrint: true } as never)
    expect(getIsOneShotPrint()).toBe(true)
    applyClientType({ clientType: 'cli', previewFormat: undefined, sessionSource: undefined, isInteractive: true, isOneShotPrint: false } as never)
    expect(getIsOneShotPrint()).toBe(false)
  })
})
