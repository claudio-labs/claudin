/**
 * Adversarial unit tests for classifyBashCommand and generateGenericDescription.
 * sideQuery is mocked so these tests are deterministic and cost zero API tokens.
 *
 * What they cover:
 * - Tool-use response with valid match → matches: true
 * - Tool-use response with matchedIndex: null → matches: false
 * - Out-of-range matchedIndex → matches: false (defensive bounds check)
 * - No tool_use block in response → matches: false, low confidence
 * - Schema validation failure → matches: false, low confidence
 * - Underlying API throws → matches: false, error message in reason
 * - Aborted signal → propagates throw
 * - Empty descriptions short-circuits without calling sideQuery
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

const mockSideQuery = mock(async (_opts: unknown) => ({
  content: [],
  usage: { input_tokens: 0, output_tokens: 0 },
})) as any

mock.module('src/agent/sideQuery.js', () => ({
  sideQuery: mockSideQuery,
}))

import {
  classifyBashCommand,
  generateGenericDescription,
  __setBashClassifierEnabledForTests,
} from 'src/services/permissions/bashClassifier.js'

// At test time `feature('BASH_CLASSIFIER')` returns false (no build-time
// preprocessing in `bun test`), which would short-circuit classifyBashCommand
// before sideQuery. Force-enable so we exercise the real path.
beforeAll(() => __setBashClassifierEnabledForTests(true))
afterAll(() => __setBashClassifierEnabledForTests(undefined))

afterEach(() => {
  mockSideQuery.mockReset()
})

const sig = () => new AbortController().signal

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', name: 'classify_match', input }],
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

function descriptionToolUseResponse(description: string) {
  return {
    content: [
      { type: 'tool_use', name: 'propose_description', input: { description } },
    ],
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

describe('classifyBashCommand', () => {
  test('returns matches:true with high confidence when classifier matches', async () => {
    mockSideQuery.mockImplementationOnce(async () =>
      toolUseResponse({
        matchedIndex: 0,
        confidence: 'high',
        reason: 'matches "list git remotes"',
      }),
    )
    const result = await classifyBashCommand(
      'git remote -v',
      '/home/u/repo',
      ['list git remotes'],
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(true)
    expect(result.confidence).toBe('high')
    expect(result.matchedDescription).toBe('list git remotes')
  })

  test('returns matches:false when matchedIndex is null', async () => {
    mockSideQuery.mockImplementationOnce(async () =>
      toolUseResponse({
        matchedIndex: null,
        confidence: 'high',
        reason: 'no match',
      }),
    )
    const result = await classifyBashCommand(
      'rm -rf /',
      '/home/u/repo',
      ['list git remotes'],
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(false)
    expect(result.matchedDescription).toBeUndefined()
  })

  test('rejects out-of-range matchedIndex (defensive against hallucinated index)', async () => {
    mockSideQuery.mockImplementationOnce(async () =>
      toolUseResponse({
        matchedIndex: 99,
        confidence: 'high',
        reason: 'fabricated',
      }),
    )
    const result = await classifyBashCommand(
      'echo hi',
      '/home/u/repo',
      ['list git remotes'], // length 1, index 99 invalid
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(false)
  })

  test('returns matches:false low confidence when no tool_use block', async () => {
    mockSideQuery.mockImplementationOnce(async () => ({
      content: [{ type: 'text', text: 'I refuse to call the tool.' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }))
    const result = await classifyBashCommand(
      'echo hi',
      '/home/u/repo',
      ['list git remotes'],
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(false)
    expect(result.confidence).toBe('low')
    expect(result.reason).toContain('no tool_use')
  })

  test('returns matches:false low confidence when response fails schema validation', async () => {
    mockSideQuery.mockImplementationOnce(async () =>
      toolUseResponse({ matchedIndex: 'not-a-number', confidence: 'super' }),
    )
    const result = await classifyBashCommand(
      'echo hi',
      '/home/u/repo',
      ['list git remotes'],
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(false)
    expect(result.confidence).toBe('low')
    expect(result.reason).toContain('malformed')
  })

  test('returns matches:false on API error (does not auto-allow on failure)', async () => {
    mockSideQuery.mockImplementationOnce(async () => {
      throw new Error('500 server error')
    })
    const result = await classifyBashCommand(
      'echo hi',
      '/home/u/repo',
      ['list git remotes'],
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(false)
    expect(result.reason).toContain('500 server error')
  })

  test('propagates throw when signal aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    mockSideQuery.mockImplementationOnce(async () => {
      throw new Error('aborted')
    })
    await expect(
      classifyBashCommand(
        'echo hi',
        '/home/u/repo',
        ['list git remotes'],
        'allow',
        ctrl.signal,
        false,
      ),
    ).rejects.toThrow()
  })

  test('skips API call when descriptions array is empty', async () => {
    const result = await classifyBashCommand(
      'echo hi',
      '/home/u/repo',
      [],
      'allow',
      sig(),
      false,
    )
    expect(result.matches).toBe(false)
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('passes correct behavior-specific system prompt for deny bucket', async () => {
    mockSideQuery.mockImplementationOnce(async () =>
      toolUseResponse({
        matchedIndex: null,
        confidence: 'high',
        reason: 'no match',
      }),
    )
    await classifyBashCommand(
      'echo hi',
      '/home/u/repo',
      ['delete production data'],
      'deny',
      sig(),
      false,
    )
    const calledOpts = mockSideQuery.mock.calls[0][0]
    expect(calledOpts.system).toContain('deny rule')
  })
})

describe('generateGenericDescription', () => {
  test('returns the model-proposed description on success', async () => {
    mockSideQuery.mockImplementationOnce(async () =>
      descriptionToolUseResponse('list git remotes'),
    )
    const result = await generateGenericDescription(
      'git remote -v',
      'show remotes',
      sig(),
    )
    expect(result).toBe('list git remotes')
  })

  test('falls back to user draft when model returns no tool_use', async () => {
    mockSideQuery.mockImplementationOnce(async () => ({
      content: [{ type: 'text', text: 'no idea' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }))
    const result = await generateGenericDescription(
      'git remote -v',
      'user draft',
      sig(),
    )
    expect(result).toBe('user draft')
  })

  test('falls back to user draft on API error', async () => {
    mockSideQuery.mockImplementationOnce(async () => {
      throw new Error('500')
    })
    const result = await generateGenericDescription(
      'git remote -v',
      'user draft',
      sig(),
    )
    expect(result).toBe('user draft')
  })

  test('returns null when no draft and no proposal', async () => {
    mockSideQuery.mockImplementationOnce(async () => ({
      content: [{ type: 'text', text: 'no idea' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }))
    const result = await generateGenericDescription(
      'git remote -v',
      undefined,
      sig(),
    )
    expect(result).toBeNull()
  })
})
