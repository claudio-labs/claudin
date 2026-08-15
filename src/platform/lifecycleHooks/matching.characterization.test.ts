/**
 * Characterization tests for getMatchingHooks (and its internal matchesPattern,
 * matchQuery derivation, source labeling, and dedup behavior, observed via the
 * public API).
 *
 * Locks behavior before the 11d split moves this surface to `hooks/matching.ts`.
 *
 * Strategy:
 *   - Mock `hooks/hooksConfigSnapshot.js` so `getHooksConfig()` returns a
 *     controlled HooksSettings tree (no real settings.json IO).
 *   - Pass `appState=undefined` so session-hook merging is skipped — keeps
 *     this file focused on the "settings -> match -> dedup" path. Session
 *     merging is exercised separately in events characterization.
 *   - Cache-bust the hooks.ts import per test file so the mocked snapshot
 *     module is consumed (bun caches ESM by URL).
 */
import { describe, expect, mock, test, beforeAll } from 'bun:test'
import type {
  HookEvent,
  HookInput,
  HookMatcher,
} from 'src/shared/types/hookEvents.js'

type Hooks = typeof import('src/platform/lifecycleHooks/hooks.js')

let hooks: Hooks
let snapshotConfig: Partial<Record<HookEvent, HookMatcher[]>> = {}

beforeAll(async () => {
  mock.module('./hooksConfigSnapshot.js', () => ({
    getHooksConfigFromSnapshot: () => snapshotConfig,
    shouldAllowManagedHooksOnly: () => false,
    shouldDisableAllHooksIncludingManaged: () => false,
    // Other exports are not referenced by the matching path in hooks.ts but
    // keep the surface roughly matching real module so other importers don't
    // crash if they pull this mock transitively.
    captureHooksConfigSnapshot: () => {},
    updateHooksConfigSnapshot: () => {},
    resetHooksConfigSnapshot: () => {},
  }))
  hooks = await import(`src/platform/lifecycleHooks/hooks.js?matching-char=${Date.now()}`)
})

function cmdHook(command: string) {
  return { type: 'command' as const, command }
}

function matcher(m: string, command: string): HookMatcher {
  return { matcher: m, hooks: [cmdHook(command)] }
}

function bashPreToolInput(toolName = 'Bash'): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: { command: 'ls' },
  } as HookInput
}

describe('getMatchingHooks — matchesPattern (via PreToolUse)', () => {
  test('empty matcher string matches all', async () => {
    snapshotConfig = { PreToolUse: [matcher('', 'echo empty')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result).toHaveLength(1)
    expect(result[0].hookSource).toBe('settings')
  })

  test('wildcard "*" matcher matches all tools', async () => {
    snapshotConfig = { PreToolUse: [matcher('*', 'echo wildcard')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('FileWrite'),
    )
    expect(result).toHaveLength(1)
  })

  test('exact tool name match — hit', async () => {
    snapshotConfig = { PreToolUse: [matcher('Bash', 'echo bash')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('Bash'),
    )
    expect(result).toHaveLength(1)
  })

  test('exact tool name match — miss', async () => {
    snapshotConfig = { PreToolUse: [matcher('Bash', 'echo bash')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('FileWrite'),
    )
    expect(result).toHaveLength(0)
  })

  test('pipe-separated list — hit on one alternative', async () => {
    snapshotConfig = {
      PreToolUse: [matcher('Bash|FileWrite|FileEdit', 'echo pipe')],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('FileWrite'),
    )
    expect(result).toHaveLength(1)
  })

  test('pipe-separated list — miss', async () => {
    snapshotConfig = {
      PreToolUse: [matcher('Bash|FileWrite', 'echo pipe')],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('Grep'),
    )
    expect(result).toHaveLength(0)
  })

  test('regex matcher — hit', async () => {
    snapshotConfig = { PreToolUse: [matcher('^File.*', 'echo regex')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('FileWrite'),
    )
    expect(result).toHaveLength(1)
  })

  test('regex matcher — miss', async () => {
    snapshotConfig = { PreToolUse: [matcher('^File.*', 'echo regex')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('Bash'),
    )
    expect(result).toHaveLength(0)
  })

  test('invalid regex returns no match (does not throw)', async () => {
    snapshotConfig = { PreToolUse: [matcher('[unclosed', 'echo bad')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput('Bash'),
    )
    expect(result).toHaveLength(0)
  })
})

describe('getMatchingHooks — matchQuery derivation per event', () => {
  test('SessionStart matches on source', async () => {
    snapshotConfig = { SessionStart: [matcher('startup', 'echo start')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'SessionStart',
      {
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        source: 'startup',
      } as HookInput,
    )
    expect(result).toHaveLength(1)
  })

  test('Notification matches on notification_type', async () => {
    snapshotConfig = {
      Notification: [matcher('idle', 'echo notif')],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'Notification',
      {
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        notification_type: 'idle',
        message: 'hi',
      } as HookInput,
    )
    expect(result).toHaveLength(1)
  })

  test('FileChanged matches on basename of file_path', async () => {
    snapshotConfig = {
      FileChanged: [matcher('config\\.json', 'echo file')],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'FileChanged',
      {
        hook_event_name: 'FileChanged',
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        file_path: '/some/long/path/to/config.json',
        event: 'change',
      } as HookInput,
    )
    expect(result).toHaveLength(1)
  })

  test('TeammateIdle has no matchQuery — every matcher passes through', async () => {
    snapshotConfig = {
      TeammateIdle: [
        matcher('this-would-not-match-anything', 'echo a'),
        matcher('*', 'echo b'),
        matcher('', 'echo c'),
      ],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'TeammateIdle',
      {
        hook_event_name: 'TeammateIdle',
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      } as HookInput,
    )
    // matchQuery is undefined ⇒ filter is skipped, all matchers retained
    expect(result).toHaveLength(3)
  })
})

describe('getMatchingHooks — source labeling', () => {
  test('plain settings hook gets hookSource = "settings"', async () => {
    snapshotConfig = { PreToolUse: [matcher('Bash', 'echo s')] }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result[0].hookSource).toBe('settings')
    expect(result[0].pluginRoot).toBeUndefined()
    expect(result[0].skillRoot).toBeUndefined()
  })

  test('plugin hook with pluginName gets "plugin:<name>"', async () => {
    snapshotConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [cmdHook('echo p')],
          pluginRoot: '/plugins/foo',
          pluginName: 'foo',
        } as unknown as HookMatcher,
      ],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result[0].hookSource).toBe('plugin:foo')
    expect(result[0].pluginRoot).toBe('/plugins/foo')
  })

  test('skill hook with skillName gets "skill:<name>"', async () => {
    snapshotConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [cmdHook('echo k')],
          skillRoot: '/skills/bar',
          skillName: 'bar',
        } as unknown as HookMatcher,
      ],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result[0].hookSource).toBe('skill:bar')
    expect(result[0].skillRoot).toBe('/skills/bar')
  })
})

describe('getMatchingHooks — multi-hook matcher', () => {
  test('matcher with N hooks expands to N MatchedHook entries', async () => {
    snapshotConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [cmdHook('echo 1'), cmdHook('echo 2'), cmdHook('echo 3')],
        },
      ],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result).toHaveLength(3)
    expect(
      result.map(r => (r.hook.type === 'command' ? r.hook.command : null)),
    ).toEqual(['echo 1', 'echo 2', 'echo 3'])
  })
})

describe('getMatchingHooks — dedup', () => {
  test('two settings matchers with identical command dedupe to one', async () => {
    snapshotConfig = {
      PreToolUse: [matcher('Bash', 'echo dup'), matcher('Bash', 'echo dup')],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result).toHaveLength(1)
  })

  test('different commands are kept separate', async () => {
    snapshotConfig = {
      PreToolUse: [matcher('Bash', 'echo a'), matcher('Bash', 'echo b')],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result).toHaveLength(2)
  })

  test('same command across plugin vs settings is NOT deduped (different scope keys)', async () => {
    snapshotConfig = {
      PreToolUse: [
        matcher('Bash', 'echo shared'),
        {
          matcher: 'Bash',
          hooks: [cmdHook('echo shared')],
          pluginRoot: '/plugins/foo',
          pluginName: 'foo',
        } as unknown as HookMatcher,
      ],
    }
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result).toHaveLength(2)
  })
})

describe('getMatchingHooks — empty / missing', () => {
  test('returns empty array when event has no matchers configured', async () => {
    snapshotConfig = {}
    const result = await hooks.getMatchingHooks(
      undefined,
      'sess-1',
      'PreToolUse',
      bashPreToolInput(),
    )
    expect(result).toEqual([])
  })
})
