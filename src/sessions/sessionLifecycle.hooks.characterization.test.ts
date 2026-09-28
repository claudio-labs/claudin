/**
 * Characterization of what runs when a session starts (sessionStart.ts),
 * pinned before the clean-base rewrite of `sessions/lifecycle`: SessionStart
 * and Setup hooks, the plugin hooks loaded before them, and what their output
 * becomes (messages, one additional-context attachment, an initial user
 * message, watch paths, and `export` lines for the session environment).
 *
 * The hooks are real command hooks, configured in a temp CLAUDIN_CONFIG_DIR's
 * settings.json and run by the real hook engine; each one records the input
 * it was given. Plugin-hook loading is observed through the diagnostics log
 * it is timed into. Its failure path is reached by seeding the memo of
 * `loadPluginHooks` with a rejected load, since no plugin on disk makes the
 * loader throw. The session environment itself is in
 * sessionLifecycle.environment.characterization.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import {
  getCwdState,
  getIsNonInteractiveSession,
  getMainThreadAgentType,
  getOriginalCwd,
  getSessionId,
  setCwdState,
  setIsInteractive,
  setMainThreadAgentType,
  setOriginalCwd,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { clearPluginHookCache, loadPluginHooks } from 'src/plugins/loadPluginHooks.js'
import {
  envSnapshot,
  runInFreshProcess,
  type EnvSnapshot,
} from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
} from 'src/sessions/sessionEnvironment.js'
import {
  processSessionStartHooks,
  processSetupHooks,
  takeInitialUserMessage,
} from 'src/sessions/sessionStart.js'
import { getInMemoryErrors } from 'src/shared/log.js'
import { asSessionId } from 'src/shared/types/ids.js'

let env: EnvSnapshot
let saved: {
  sessionId: string
  originalCwd: string
  cwd: string
  agentType: string | undefined
  interactive: boolean
}

let sandbox: string
let configDir: string
let projectDir: string

beforeAll(() => {
  env = envSnapshot([
    'CLAUDIN_CONFIG_DIR',
    'CLAUDIN_ENV_FILE',
    'CLAUDIN_SIMPLE',
    'CLAUDIN_DIAGNOSTICS_FILE',
    'DISABLE_ERROR_REPORTING',
    'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC',
    'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
  ])
  saved = {
    sessionId: getSessionId(),
    originalCwd: getOriginalCwd(),
    cwd: getCwdState(),
    agentType: getMainThreadAgentType(),
    interactive: !getIsNonInteractiveSession(),
  }
})

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-hooks-')))
  configDir = join(sandbox, 'config')
  projectDir = join(sandbox, 'project')
  mkdirSync(configDir)
  mkdirSync(projectDir)
  process.env.CLAUDIN_CONFIG_DIR = configDir
  for (const key of [
    'CLAUDIN_ENV_FILE',
    'CLAUDIN_SIMPLE',
    'CLAUDIN_DIAGNOSTICS_FILE',
    'DISABLE_ERROR_REPORTING',
    'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC',
    'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
  ]) {
    delete process.env[key]
  }
  setOriginalCwd(projectDir)
  setCwdState(projectDir)
  // Non-interactive: hooks run without the workspace-trust dialog.
  setIsInteractive(false)
  setMainThreadAgentType(undefined)
  switchSession(asSessionId(randomUUID()))
  resetSettingsCache()
  resetHooksConfigSnapshot()
  invalidateSessionEnvCache()
})

afterEach(() => {
  clearPluginHookCache()
  takeInitialUserMessage()
  env.restore()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  invalidateSessionEnvCache()
  setOriginalCwd(saved.originalCwd)
  setCwdState(saved.cwd)
  rmSync(sandbox, { recursive: true, force: true })
})

afterAll(() => {
  env.restore()
  switchSession(asSessionId(saved.sessionId))
  setMainThreadAgentType(saved.agentType)
  setIsInteractive(saved.interactive)
  invalidateSessionEnvCache()
})

// --- helpers --------------------------------------------------------------

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

type CommandHook = { type: 'command'; command: string; async?: boolean }

/** A command hook that saves its JSON input to `recordTo` and prints `output`. */
function hook(options: { recordTo?: string; output?: unknown; async?: boolean }): CommandHook {
  const steps = [options.recordTo ? `cat > ${shellQuote(options.recordTo)}` : 'cat > /dev/null']
  if (options.output !== undefined) {
    const text =
      typeof options.output === 'string' ? options.output : JSON.stringify(options.output)
    steps.push(`printf '%s\\n' ${shellQuote(text)}`)
  }
  return {
    type: 'command',
    command: steps.join('; '),
    ...(options.async && { async: true }),
  }
}

function withContext(event: 'SessionStart' | 'Setup', extra: Record<string, unknown>) {
  return { hookSpecificOutput: { hookEventName: event, ...extra } }
}

function configureSettings(settings: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
  resetHooksConfigSnapshot()
}

function configureHooks(
  hooks: Record<string, Array<{ matcher?: string; hooks: CommandHook[] }>>,
): void {
  configureSettings({ hooks })
}

function readInput(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

type AnyMessage = {
  type: string
  data?: { type?: string; hookName?: string }
  attachment?: { type: string; [key: string]: unknown }
}

/**
 * The one attachment that gathers every additional context of a run: its
 * hook name, tool-use id and hook event are all the event's own name.
 */
function contextAttachment(event: 'SessionStart' | 'Setup', contexts: string[]) {
  const named = Object.fromEntries(
    ['hookName', 'toolUseID', 'hookEvent'].map(field => [field, event]),
  )
  return { type: 'hook_additional_context', content: contexts, ...named }
}

function contextAttachments(messages: readonly unknown[]) {
  return (messages as AnyMessage[]).filter(
    message => message.attachment?.type === 'hook_additional_context',
  )
}

/** The plugin-hook load events in the diagnostics log, in order. */
function pluginLoadEvents(): string[] {
  const file = process.env.CLAUDIN_DIAGNOSTICS_FILE
  if (!file || !existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { event: string }).event)
    .filter(event => event.startsWith('load_plugin_hooks_'))
}

/**
 * The in-memory error log only records while nonessential traffic is
 * enabled, and Claudin's default is to disable it. Opt in explicitly.
 */
function recordErrors(): void {
  process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
}

/** Where the current session's hook env files live, created by the test. */
function sessionEnvDir(): string {
  const dir = join(configDir, 'session-env', getSessionId())
  mkdirSync(dir, { recursive: true })
  return dir
}

function failPluginHookLoading(reason: unknown): void {
  const failed = Promise.reject(reason)
  failed.catch(() => {})
  loadPluginHooks.cache.set(undefined, failed)
}

// --- SessionStart ---------------------------------------------------------

describe('processSessionStartHooks', () => {
  test('in bare mode no hook runs, plugin hooks are not even loaded, and nothing is returned', async () => {
    process.env.CLAUDIN_DIAGNOSTICS_FILE = join(sandbox, 'diagnostics.jsonl')
    const input = join(sandbox, 'input.json')
    configureHooks({ SessionStart: [{ matcher: 'startup', hooks: [hook({ recordTo: input })] }] })
    process.env.CLAUDIN_SIMPLE = '1'

    expect(await processSessionStartHooks('startup')).toEqual([])
    expect(existsSync(input)).toBe(false)
    expect(pluginLoadEvents()).toEqual([])
  })

  test('returns what the hooks produced, then one attachment carrying every additional context', async () => {
    configureHooks({
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            hook({ output: withContext('SessionStart', { additionalContext: 'branch is main' }) }),
            hook({ output: withContext('SessionStart', { additionalContext: 'CI is red' }) }),
            hook({ output: 'plain text from a hook' }),
          ],
        },
      ],
    })

    const messages = (await processSessionStartHooks('startup')) as AnyMessage[]

    const progress = messages.filter(message => message.type === 'progress')
    expect(progress).toHaveLength(3)
    for (const message of progress) {
      expect(message.data).toMatchObject({
        type: 'hook_progress',
        hookName: 'SessionStart:startup',
      })
    }
    expect(
      messages.some(
        message =>
          message.attachment?.type === 'hook_success' &&
          message.attachment.content === 'plain text from a hook',
      ),
    ).toBe(true)
    const last = messages.at(-1)!
    expect(last.type).toBe('attachment')
    const contexts = [...(last.attachment!.content as string[])].sort()
    expect({ ...last.attachment, content: contexts }).toEqual(
      contextAttachment('SessionStart', ['CI is red', 'branch is main']),
    )
    expect(contextAttachments(messages)).toHaveLength(1)
  })

  test('with no additional context there is no context attachment', async () => {
    configureHooks({
      SessionStart: [{ matcher: 'startup', hooks: [hook({ output: 'just text' })] }],
    })

    const messages = await processSessionStartHooks('startup')

    expect(messages.length).toBeGreaterThan(0)
    expect(contextAttachments(messages)).toHaveLength(0)
  })

  test('with no hooks configured nothing is returned', async () => {
    expect(await processSessionStartHooks('startup')).toEqual([])
  })

  test.each(['startup', 'resume', 'clear', 'compact'] as const)(
    'the source %s selects the hooks whose matcher names it',
    async source => {
      const ran = (name: string) => join(sandbox, `${name}.json`)
      configureHooks({
        SessionStart: ['startup', 'resume', 'clear', 'compact'].map(name => ({
          matcher: name,
          hooks: [hook({ recordTo: ran(name) })],
        })),
      })

      await processSessionStartHooks(source)

      for (const name of ['startup', 'resume', 'clear', 'compact']) {
        expect(existsSync(ran(name))).toBe(name === source)
      }
      expect(readInput(ran(source))).toMatchObject({
        hook_event_name: 'SessionStart',
        source,
      })
    },
  )

  test('the hook is told the session, the agent type and the model it was given', async () => {
    const input = join(sandbox, 'input.json')
    configureHooks({ SessionStart: [{ matcher: 'resume', hooks: [hook({ recordTo: input })] }] })
    setMainThreadAgentType('from-bootstrap')

    await processSessionStartHooks('resume', {
      sessionId: 'resumed-session',
      agentType: 'from-caller',
      model: 'model-x',
    })

    expect(readInput(input)).toMatchObject({
      session_id: 'resumed-session',
      agent_type: 'from-caller',
      model: 'model-x',
      source: 'resume',
    })
  })

  test('without options the hook gets the current session and the main-thread agent type', async () => {
    const input = join(sandbox, 'input.json')
    configureHooks({ SessionStart: [{ matcher: 'startup', hooks: [hook({ recordTo: input })] }] })
    setMainThreadAgentType('reviewer')

    await processSessionStartHooks('startup')

    const received = readInput(input)
    expect(received.session_id).toBe(getSessionId())
    expect(received.agent_type).toBe('reviewer')
    expect(received.model).toBeUndefined()
  })

  test('an initial user message from a hook is handed out once', async () => {
    configureHooks({
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [hook({ output: withContext('SessionStart', { initialUserMessage: 'run the tests' }) })],
        },
      ],
    })

    const messages = await processSessionStartHooks('startup')

    expect(contextAttachments(messages)).toHaveLength(0)
    expect(takeInitialUserMessage()).toBe('run the tests')
    expect(takeInitialUserMessage()).toBeUndefined()
  })

  test('an untaken initial user message survives a later start that sets none', async () => {
    configureHooks({
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [hook({ output: withContext('SessionStart', { initialUserMessage: 'first' }) })],
        },
        { matcher: 'clear', hooks: [hook({ output: 'no message here' })] },
      ],
    })

    await processSessionStartHooks('startup')
    await processSessionStartHooks('clear')

    expect(takeInitialUserMessage()).toBe('first')
  })

  test('an async hook only contributes when synchronous execution is forced', async () => {
    const asyncHook = hook({
      async: true,
      output: withContext('SessionStart', { additionalContext: 'from the async hook' }),
    })
    configureHooks({ SessionStart: [{ matcher: 'startup', hooks: [asyncHook] }] })

    const backgrounded = await processSessionStartHooks('startup')
    const forced = await processSessionStartHooks('startup', { forceSyncExecution: true })

    expect(contextAttachments(backgrounded)).toHaveLength(0)
    expect(contextAttachments(forced).map(message => message.attachment?.content)).toEqual([
      ['from the async hook'],
    ])
  })

  test('plugin hooks are loaded, and timed, before the hooks run', async () => {
    process.env.CLAUDIN_DIAGNOSTICS_FILE = join(sandbox, 'diagnostics.jsonl')

    await processSessionStartHooks('startup')

    expect(pluginLoadEvents()).toEqual([
      'load_plugin_hooks_started',
      'load_plugin_hooks_completed',
    ])
  })

  test('when only managed hooks are allowed, plugin hooks are not loaded', async () => {
    process.env.CLAUDIN_DIAGNOSTICS_FILE = join(sandbox, 'diagnostics.jsonl')
    recordErrors()
    configureSettings({ disableAllHooks: true })
    const errorsBefore = getInMemoryErrors().length
    failPluginHookLoading(new Error('should never be awaited'))

    expect(await processSessionStartHooks('startup')).toEqual([])
    expect(pluginLoadEvents()).toEqual([])
    expect(getInMemoryErrors().length).toBe(errorsBefore)
  })

  test('a failed plugin-hook load is logged, and the configured hooks still run', async () => {
    process.env.CLAUDIN_DIAGNOSTICS_FILE = join(sandbox, 'diagnostics.jsonl')
    recordErrors()
    const input = join(sandbox, 'input.json')
    configureHooks({
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            hook({
              recordTo: input,
              output: withContext('SessionStart', { additionalContext: 'still here' }),
            }),
          ],
        },
      ],
    })
    failPluginHookLoading(new Error('Failed to clone marketplace repo'))

    const messages = await processSessionStartHooks('startup')

    expect(existsSync(input)).toBe(true)
    expect(contextAttachments(messages)).toHaveLength(1)
    expect(pluginLoadEvents()).toEqual(['load_plugin_hooks_started', 'load_plugin_hooks_failed'])
    expect(getInMemoryErrors().at(-1)?.error).toContain('Failed to clone marketplace repo')
  })

  test('a failure that is not an Error is logged with the source that was starting', async () => {
    recordErrors()
    failPluginHookLoading('registry unreachable')

    await processSessionStartHooks('resume')

    const logged = getInMemoryErrors().at(-1)?.error ?? ''
    expect(logged).toContain('registry unreachable')
    expect(logged).toContain('resume')
  })

  test('the watch paths a hook returns are handed to the file watcher', async () => {
    const watched = join(sandbox, 'elsewhere', 'watched.env')
    mkdirSync(join(sandbox, 'elsewhere'))
    writeFileSync(watched, 'A=1\n')
    const events = join(sandbox, 'file-changed.jsonl')
    configureHooks({
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [hook({ output: withContext('SessionStart', { watchPaths: [watched] }) })],
        },
      ],
      FileChanged: [
        {
          matcher: 'watched.env',
          hooks: [{ type: 'command', command: `cat >> ${shellQuote(events)}; echo >> ${shellQuote(events)}` }],
        },
      ],
    })

    const result = await runInFreshProcess(
      `
      const fs = await import('fs')
      const state = await load('src/platform/bootstrap/state.ts')
      const watcher = await load('src/platform/lifecycleHooks/fileChangedWatcher.ts')
      const start = await load('src/sessions/sessionStart.ts')
      state.setOriginalCwd(${JSON.stringify(projectDir)})
      state.setCwdState(${JSON.stringify(projectDir)})
      watcher.initializeFileChangedWatcher(${JSON.stringify(projectDir)})
      await start.processSessionStartHooks('startup')
      await Bun.sleep(300)
      fs.writeFileSync(${JSON.stringify(watched)}, 'A=2\\n')
      const deadline = Date.now() + 8000
      while (!fs.existsSync(${JSON.stringify(events)}) && Date.now() < deadline) await Bun.sleep(50)
      await Bun.sleep(100)
      const seen = fs.existsSync(${JSON.stringify(events)})
        ? fs.readFileSync(${JSON.stringify(events)}, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l))
        : []
      return { seen }
      `,
      { CLAUDIN_CONFIG_DIR: configDir },
      sandbox,
    )

    expect(result.seen).toContainEqual(
      expect.objectContaining({
        hook_event_name: 'FileChanged',
        file_path: watched,
        event: 'change',
      }),
    )
  }, 20_000)

  test("a hook's export lines reach the session environment script", async () => {
    configureHooks({
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            {
              type: 'command',
              command: `echo 'export LIFECYCLE_PROBE=42' >> "$CLAUDIN_ENV_FILE"`,
            },
          ],
        },
      ],
    })

    await processSessionStartHooks('startup')
    invalidateSessionEnvCache()

    expect(await getSessionEnvironmentScript()).toBe('export LIFECYCLE_PROBE=42')
    expect(readdirSync(sessionEnvDir())).toEqual(['sessionstart-hook-0.sh'])
  })
})

// --- Setup ----------------------------------------------------------------

describe('processSetupHooks', () => {
  test('in bare mode no hook runs and nothing is returned', async () => {
    const input = join(sandbox, 'input.json')
    configureHooks({ Setup: [{ matcher: 'init', hooks: [hook({ recordTo: input })] }] })
    process.env.CLAUDIN_SIMPLE = 'true'

    expect(await processSetupHooks('init')).toEqual([])
    expect(existsSync(input)).toBe(false)
  })

  test.each(['init', 'maintenance'] as const)(
    'the trigger %s selects its hooks, and their context comes back as a Setup attachment',
    async trigger => {
      const input = (name: string) => join(sandbox, `${name}.json`)
      configureHooks({
        Setup: ['init', 'maintenance'].map(name => ({
          matcher: name,
          hooks: [
            hook({
              recordTo: input(name),
              output: withContext('Setup', { additionalContext: `context for ${name}` }),
            }),
          ],
        })),
      })

      const messages = await processSetupHooks(trigger)

      expect(existsSync(input('init'))).toBe(trigger === 'init')
      expect(existsSync(input('maintenance'))).toBe(trigger === 'maintenance')
      expect(readInput(input(trigger))).toMatchObject({ hook_event_name: 'Setup', trigger })
      expect(contextAttachments(messages).map(message => message.attachment)).toEqual([
        contextAttachment('Setup', [`context for ${trigger}`]),
      ])
      expect((messages as AnyMessage[]).at(-1)?.attachment?.type).toBe('hook_additional_context')
    },
  )

  test('without context the hook messages come back alone', async () => {
    configureHooks({ Setup: [{ matcher: 'init', hooks: [hook({ output: 'set up' })] }] })

    const messages = (await processSetupHooks('init')) as AnyMessage[]

    expect(messages.map(message => message.type)).toEqual(['progress', 'attachment'])
    expect(messages[1]?.attachment).toMatchObject({ type: 'hook_success', content: 'set up' })
  })

  test('an async hook only contributes when synchronous execution is forced', async () => {
    configureHooks({
      Setup: [
        {
          matcher: 'init',
          hooks: [
            hook({
              async: true,
              output: withContext('Setup', { additionalContext: 'late context' }),
            }),
          ],
        },
      ],
    })

    const backgrounded = await processSetupHooks('init')
    const forced = await processSetupHooks('init', { forceSyncExecution: true })

    expect(contextAttachments(backgrounded)).toHaveLength(0)
    expect(contextAttachments(forced)).toHaveLength(1)
  })

  test('a failed plugin-hook load does not stop the configured hooks', async () => {
    const input = join(sandbox, 'input.json')
    configureHooks({ Setup: [{ matcher: 'init', hooks: [hook({ recordTo: input })] }] })
    failPluginHookLoading(new Error('EACCES: permission denied'))

    await processSetupHooks('init')

    expect(existsSync(input)).toBe(true)
  })
})
