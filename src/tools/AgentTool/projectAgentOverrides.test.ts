import { describe, expect, test } from 'bun:test'
import {
  PROJECT_AGENT_OVERRIDES_FILENAME,
  applyProjectAgentOverrides,
  getProjectAgentOverridesPath,
  readProjectAgentOverrides,
  writeProjectAgentOverride,
  type ProjectAgentOverridesIO,
} from 'src/tools/AgentTool/projectAgentOverrides.js'

type Agent = {
  agentType: string
  source: string
  baseDir?: string
  model?: string
}

function makeIO(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles))
  const errors: unknown[] = []
  const io: ProjectAgentOverridesIO = {
    exists: path => files.has(path),
    read: path => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    write: (path, contents) => {
      files.set(path, contents)
    },
    logErr: e => errors.push(e),
  }
  return { io, files, errors }
}

describe('getProjectAgentOverridesPath', () => {
  test('places settings.agents.json next to the agents directory', () => {
    expect(
      getProjectAgentOverridesPath('/home/u/proj/.claudin/agents'),
    ).toBe(`/home/u/proj/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`)
  })
})

describe('readProjectAgentOverrides', () => {
  test('returns empty when file does not exist', () => {
    const { io } = makeIO()
    expect(readProjectAgentOverrides('/x/.claudin/agents', io)).toEqual({})
  })

  test('returns overrides map from valid JSON', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io } = makeIO({
      [path]: JSON.stringify({
        agentModelOverrides: { 'dev-app': 'claude-sonnet-4-6' },
      }),
    })
    expect(readProjectAgentOverrides('/x/.claudin/agents', io)).toEqual({
      'dev-app': 'claude-sonnet-4-6',
    })
  })

  test('returns empty and logs on malformed JSON', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io, errors } = makeIO({ [path]: '{ not json' })
    expect(readProjectAgentOverrides('/x/.claudin/agents', io)).toEqual({})
    expect(errors).toHaveLength(1)
  })

  test('returns empty when agentModelOverrides is missing/invalid', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io } = makeIO({ [path]: JSON.stringify({ unrelated: true }) })
    expect(readProjectAgentOverrides('/x/.claudin/agents', io)).toEqual({})
  })
})

describe('writeProjectAgentOverride', () => {
  test('creates file with single override when none exists', () => {
    const { io, files } = makeIO()
    writeProjectAgentOverride(
      '/x/.claudin/agents',
      'dev-app',
      'claude-sonnet-4-6',
      io,
    )
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    expect(JSON.parse(files.get(path)!)).toEqual({
      agentModelOverrides: { 'dev-app': 'claude-sonnet-4-6' },
    })
  })

  test('merges into existing file without touching other keys', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io, files } = makeIO({
      [path]: JSON.stringify({
        agentModelOverrides: { 'dev-app': 'opus' },
        unrelated: { keep: true },
      }),
    })
    writeProjectAgentOverride(
      '/x/.claudin/agents',
      'product-strategist',
      'sonnet',
      io,
    )
    expect(JSON.parse(files.get(path)!)).toEqual({
      agentModelOverrides: {
        'dev-app': 'opus',
        'product-strategist': 'sonnet',
      },
      unrelated: { keep: true },
    })
  })

  test('overwrites existing entry for the same agent', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io, files } = makeIO({
      [path]: JSON.stringify({
        agentModelOverrides: { 'dev-app': 'opus' },
      }),
    })
    writeProjectAgentOverride('/x/.claudin/agents', 'dev-app', 'inherit', io)
    expect(JSON.parse(files.get(path)!)).toEqual({
      agentModelOverrides: { 'dev-app': 'inherit' },
    })
  })

  test('undefined deletes the entry', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io, files } = makeIO({
      [path]: JSON.stringify({
        agentModelOverrides: { 'dev-app': 'opus', other: 'haiku' },
      }),
    })
    writeProjectAgentOverride('/x/.claudin/agents', 'dev-app', undefined, io)
    expect(JSON.parse(files.get(path)!)).toEqual({
      agentModelOverrides: { other: 'haiku' },
    })
  })

  test('removes agentModelOverrides key when last entry deleted', () => {
    const path = `/x/.claudin/${PROJECT_AGENT_OVERRIDES_FILENAME}`
    const { io, files } = makeIO({
      [path]: JSON.stringify({
        agentModelOverrides: { 'dev-app': 'opus' },
        unrelated: { keep: true },
      }),
    })
    writeProjectAgentOverride('/x/.claudin/agents', 'dev-app', undefined, io)
    expect(JSON.parse(files.get(path)!)).toEqual({ unrelated: { keep: true } })
  })
})

describe('applyProjectAgentOverrides', () => {
  const mkDeps = (
    overridesByDir: Record<string, Record<string, string>>,
    availableModels: Set<string> | undefined = undefined,
  ) => ({
    readOverrides: (baseDir: string) => overridesByDir[baseDir] ?? {},
    resolve: {
      getAvailableModelIds: () => availableModels,
      logDebug: () => {},
      logErr: () => {},
    },
  })

  test('passes through built-in agents (different override path)', () => {
    const agents: Agent[] = [
      { agentType: 'Plan', source: 'built-in', baseDir: 'built-in' },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps({ 'built-in': { Plan: 'haiku' } }),
    )
    expect(out[0]?.model).toBeUndefined()
  })

  test('passes through agents without baseDir unchanged', () => {
    const agents: Agent[] = [
      { agentType: 'orphan', source: 'projectSettings', model: 'opus' },
    ]
    expect(applyProjectAgentOverrides(agents, mkDeps({}))).toEqual(agents)
  })

  test('applies override to a project agent', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
      },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps({ '/x/.claudin/agents': { 'dev-app': 'claude-sonnet-4-6' } }),
    )
    expect(out[0]?.model).toBe('claude-sonnet-4-6')
  })

  test('preserves frontmatter model when no override is present', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
        model: 'opus',
      },
    ]
    expect(applyProjectAgentOverrides(agents, mkDeps({}))[0]?.model).toBe(
      'opus',
    )
  })

  test('override beats frontmatter model (override is user preference)', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
        model: 'opus',
      },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps({ '/x/.claudin/agents': { 'dev-app': 'haiku' } }),
    )
    expect(out[0]?.model).toBe('haiku')
  })

  test('orphan override (not in active profile list) falls back to inherit', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
      },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps(
        { '/x/.claudin/agents': { 'dev-app': 'deepseek-chat' } },
        new Set(['claude-sonnet-4-6', 'claude-opus-4-7']),
      ),
    )
    expect(out[0]?.model).toBe('inherit')
  })

  test('alias overrides bypass the active-profile check', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
      },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps(
        { '/x/.claudin/agents': { 'dev-app': 'sonnet' } },
        new Set(['gpt-5']),
      ),
    )
    expect(out[0]?.model).toBe('sonnet')
  })

  test('reads each baseDir at most once across multiple agents', () => {
    const calls: string[] = []
    const agents: Agent[] = [
      {
        agentType: 'a',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
      },
      {
        agentType: 'b',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
      },
      {
        agentType: 'c',
        source: 'userSettings',
        baseDir: '/home/u/.claudin/agents',
      },
    ]
    applyProjectAgentOverrides(agents, {
      readOverrides: baseDir => {
        calls.push(baseDir)
        return {}
      },
      resolve: {
        getAvailableModelIds: () => undefined,
        logDebug: () => {},
        logErr: () => {},
      },
    })
    expect(calls).toEqual([
      '/x/.claudin/agents',
      '/home/u/.claudin/agents',
    ])
  })

  test('trims whitespace in override values', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
      },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps({ '/x/.claudin/agents': { 'dev-app': '  haiku  ' } }),
    )
    expect(out[0]?.model).toBe('haiku')
  })

  test('whitespace-only override is treated as missing', () => {
    const agents: Agent[] = [
      {
        agentType: 'dev-app',
        source: 'projectSettings',
        baseDir: '/x/.claudin/agents',
        model: 'opus',
      },
    ]
    const out = applyProjectAgentOverrides(
      agents,
      mkDeps({ '/x/.claudin/agents': { 'dev-app': '   ' } }),
    )
    expect(out[0]?.model).toBe('opus')
  })
})
