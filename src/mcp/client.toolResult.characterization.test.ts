/**
 * Characterization of how an MCP tool result reaches the model, pinned before
 * the clean-base rewrite (src/mcp/client/toolResult.ts, src/mcp/mcpValidation.ts,
 * src/mcp/mcpOutputStorage.ts):
 *
 * - each content type turned into message blocks, binary blobs saved to disk;
 * - which result shape wins, and the schema hint that goes with it;
 * - the size gate: when output is counted, when it is cut, when it is saved
 *   to a file the model is told to read, and what happens when saving fails;
 * - the file names, extensions and paths used on disk.
 *
 * Files land in the session's tool-results directory under a temp
 * CLAUDIN_CONFIG_DIR. The one boundary replaced is the model's token-counting
 * endpoint: it is spied per test with the count the case needs (or with no
 * answer, as from a provider without that endpoint), so no request leaves.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  inferCompactSchema,
  processMCPResult,
  transformMCPResult,
  transformResultContent,
} from 'src/mcp/client.js'
import {
  extensionForMimeType,
  getBinaryBlobSavedMessage,
  getFormatDescription,
  getLargeOutputInstructions,
  isBinaryContentType,
  persistBinaryContent,
} from 'src/mcp/mcpOutputStorage.js'
import {
  getContentSizeEstimate,
  getMaxMcpOutputTokens,
  IMAGE_TOKEN_ESTIMATE,
  MCP_TOKEN_COUNT_THRESHOLD_FACTOR,
  mcpContentNeedsTruncation,
  truncateMcpContent,
  truncateMcpContentIfNeeded,
} from 'src/mcp/mcpValidation.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import * as tokenEstimation from 'src/shared/tokenEstimation.js'
import { formatFileSize } from 'src/shared/text/format.js'

const OWNED_ENV = ['CLAUDIN_CONFIG_DIR', 'MAX_MCP_OUTPUT_TOKENS', 'ENABLE_MCP_LARGE_OUTPUT_FILES'] as const
let savedEnv: Record<string, string | undefined> = {}
let savedOriginalCwd = ''
let root = ''
let counter: ReturnType<typeof spyOn<typeof tokenEstimation, 'countMessagesTokensWithAPI'>>

beforeEach(() => {
  savedEnv = Object.fromEntries(OWNED_ENV.map(k => [k, process.env[k]]))
  for (const key of OWNED_ENV) delete process.env[key]
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-result-char-')))
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'project'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  savedOriginalCwd = getOriginalCwd()
  setOriginalCwd(join(root, 'project'))
  // The counting endpoint: no answer unless a test says otherwise.
  counter = spyOn(tokenEstimation, 'countMessagesTokensWithAPI').mockResolvedValue(null)
})

afterEach(() => {
  counter.mockRestore()
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedOriginalCwd)
  try {
    chmodSync(getToolResultsDir(), 0o755)
  } catch {}
  rmSync(root, { recursive: true, force: true })
})

// A 2x1 PNG, the smallest real image the resizer accepts.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGGEMAD0SA/2Z7uGqAAAAAElFTkSuQmCC'
const b64 = (text: string) => Buffer.from(text).toString('base64')
const savedFiles = () => (existsSync(getToolResultsDir()) ? readdirSync(getToolResultsDir()) : [])

// --- one content item at a time ---------------------------------------------------------

describe('transformResultContent', () => {
  test('text and links become text blocks; unknown types and empty resources disappear', async () => {
    const cases: Array<[unknown, unknown[]]> = [
      [{ type: 'text', text: 'hello' }, [{ type: 'text', text: 'hello' }]],
      [{ type: 'text', text: 'hid\u200Bden\u{E0041}' }, [{ type: 'text', text: 'hidden' }]],
      [{ type: 'resource_link', uri: 'file:///a.md', name: 'notes' }, [{ type: 'text', text: '[Resource link: notes] file:///a.md' }]],
      [
        { type: 'resource_link', uri: 'file:///a.md', name: 'notes', description: 'meeting notes' },
        [{ type: 'text', text: '[Resource link: notes] file:///a.md (meeting notes)' }],
      ],
      [
        { type: 'resource', resource: { uri: 'mem://doc', text: 'body\u202E text' } },
        [{ type: 'text', text: '[Resource from srv at mem://doc] body text' }],
      ],
      [{ type: 'resource', resource: { uri: 'mem://odd' } }, []],
      [{ type: 'hologram', data: 'x' }, []],
    ]
    for (const [item, blocks] of cases) {
      expect({ item, blocks: (await transformResultContent(item as never, 'srv')) as unknown }).toEqual({ item, blocks })
    }
    expect(savedFiles()).toEqual([])
  })

  test('images stay images, re-encoded; an image resource is prefixed with where it came from', async () => {
    const [image] = await transformResultContent({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' } as never, 'srv')
    expect(image).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    const bytes = Buffer.from((image as { source: { data: string } }).source.data, 'base64')
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')

    const blocks = await transformResultContent(
      { type: 'resource', resource: { uri: 'mem://pic', blob: PNG_BASE64, mimeType: 'image/png' } } as never,
      'srv',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: '[Resource from srv at mem://pic] ' })
    expect(blocks[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    expect(savedFiles()).toEqual([])
  })

  test('audio and non-image blobs are written to disk as raw bytes, and the model gets the path', async () => {
    const cases: Array<{ item: unknown; bytes: string; ext: string; prefix: string; mime: string }> = [
      { item: { type: 'audio', data: b64('RIFF-audio'), mimeType: 'audio/wav' }, bytes: 'RIFF-audio', ext: 'wav', prefix: '[Audio from my srv] ', mime: 'audio/wav' },
      {
        item: { type: 'resource', resource: { uri: 'mem://r.pdf', blob: b64('%PDF-1.7 tiny'), mimeType: 'application/pdf' } },
        bytes: '%PDF-1.7 tiny',
        ext: 'pdf',
        prefix: '[Resource from my srv at mem://r.pdf] ',
        mime: 'application/pdf',
      },
      {
        item: { type: 'resource', resource: { uri: 'mem://blob', blob: b64('opaque') } },
        bytes: 'opaque',
        ext: 'bin',
        prefix: '[Resource from my srv at mem://blob] ',
        mime: 'unknown type',
      },
      {
        item: { type: 'resource', resource: { uri: 'mem://svg', blob: b64('<svg/>'), mimeType: 'image/svg+xml' } },
        bytes: '<svg/>',
        ext: 'svg',
        prefix: '[Resource from my srv at mem://svg] ',
        mime: 'image/svg+xml',
      },
    ]
    for (const { item, bytes, ext, prefix, mime } of cases) {
      const [block] = (await transformResultContent(item as never, 'my srv')) as Array<{ type: string; text: string }>
      const path = block!.text.slice(block!.text.lastIndexOf(' saved to ') + ' saved to '.length)
      expect(block!.type).toBe('text')
      expect(block!.text).toBe(`${prefix}Binary content (${mime}, ${formatFileSize(bytes.length)}) saved to ${path}`)
      expect(dirname(path)).toBe(getToolResultsDir())
      expect(path.startsWith(join(root, 'config'))).toBe(true)
      expect(path).toMatch(new RegExp(`/mcp-my_srv-blob-\\d+-[a-z0-9]{1,6}\\.${ext}$`))
      expect(readFileSync(path).toString()).toBe(bytes)
    }
  })

  test('a server name cannot steer the blob out of the tool-results directory', async () => {
    const [block] = (await transformResultContent({ type: 'audio', data: b64('x'), mimeType: 'audio/mpeg' } as never, '../../../etc/evil')) as Array<{ text: string }>
    const path = block!.text.slice(block!.text.lastIndexOf(' saved to ') + ' saved to '.length)
    expect(dirname(path)).toBe(getToolResultsDir())
    expect(path).toMatch(/\/mcp-_________etc_evil-blob-\d+-[a-z0-9]+\.mp3$/)
  })

  test('when the blob cannot be written, the model is told why instead', async () => {
    mkdirSync(dirname(getToolResultsDir()), { recursive: true })
    writeFileSync(getToolResultsDir(), 'a file where the directory should be')
    const [block] = (await transformResultContent({ type: 'audio', data: b64('12345'), mimeType: 'audio/ogg' } as never, 'srv')) as Array<{ text: string }>
    expect(block!.text).toStartWith('[Audio from srv] Binary content (audio/ogg, 5 bytes) could not be saved to disk: ')
    expect(block!.text.length).toBeGreaterThan('[Audio from srv] Binary content (audio/ogg, 5 bytes) could not be saved to disk: '.length)
  })
})

// --- result shapes --------------------------------------------------------------------------

describe('transformMCPResult and inferCompactSchema', () => {
  test('toolResult wins over structuredContent, which wins over content', async () => {
    const cases: Array<[unknown, unknown]> = [
      [{ toolResult: 42, structuredContent: { a: 1 }, content: [] }, { content: '42', type: 'toolResult' }],
      [{ toolResult: { deep: true } }, { content: '[object Object]', type: 'toolResult' }],
      [
        { structuredContent: { title: 'x', items: [{ id: 1, name: 'n' }] }, content: [{ type: 'text', text: 'ignored' }] },
        { content: '{"title":"x","items":[{"id":1,"name":"n"}]}', type: 'structuredContent', schema: '{title: string, items: [{...}]}' },
      ],
      [
        { structuredContent: undefined, content: [{ type: 'text', text: 'hi' }] },
        { content: [{ type: 'text', text: 'hi' }], type: 'contentArray', schema: '[{type: string, text: string}]' },
      ],
      [{ content: [] }, { content: [], type: 'contentArray', schema: '[]' }],
    ]
    for (const [result, expected] of cases) {
      expect(await transformMCPResult(result, 'tool', 'srv')).toEqual(expected as never)
    }
  })

  test('anything else is refused with the server and tool named', async () => {
    for (const odd of [null, undefined, 'text', 12345, { nothing: 'useful' }, { content: 'not an array' }]) {
      await expect(transformMCPResult(odd, 'search', 'slack')).rejects.toThrow('MCP server "slack" tool "search": unexpected response format')
    }
  })

  test('the schema hint is two levels deep, first array element, ten keys at most', () => {
    const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]))
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      ['s', 'string'],
      [1, 'number'],
      [true, 'boolean'],
      [undefined, 'undefined'],
      [[], '[]'],
      [[1, 'x'], '[number]'],
      [{ a: { b: { c: 1 } } }, '{a: {b: {...}}}'],
      [[{ a: [{ b: 1 }] }], '[{a: [{...}]}]'],
      [{ a: null, b: [] }, '{a: null, b: []}'],
      [wide, `{${Array.from({ length: 10 }, (_, i) => `k${i}: number`).join(', ')}, ...}`],
    ]
    for (const [value, schema] of cases) expect(inferCompactSchema(value)).toBe(schema)
    expect(inferCompactSchema({ a: { b: 1 } }, 1)).toBe('{a: {...}}')
    expect(inferCompactSchema({ a: 1 }, 0)).toBe('{...}')
  })
})

// --- the size gate -------------------------------------------------------------------------

describe('processMCPResult', () => {
  const big = (chars: number) => 'x'.repeat(chars)

  test('output under half the token cap is passed through without counting', async () => {
    const small = { content: [{ type: 'text', text: 'small' }] }
    expect(await processMCPResult(small, 'tool', 'srv')).toEqual([{ type: 'text', text: 'small' }])
    expect(await processMCPResult({ toolResult: 'plain' }, 'tool', 'srv')).toBe('plain')
    expect(counter).not.toHaveBeenCalled()
  })

  test('the ide server is never counted, cut or saved', async () => {
    counter.mockResolvedValue(10_000_000)
    expect(await processMCPResult({ toolResult: big(400_000) }, 'getDiagnostics', 'ide')).toBe(big(400_000))
    expect(counter).not.toHaveBeenCalled()
    expect(savedFiles()).toEqual([])
  })

  test('large output that the counter puts within the cap, or cannot count, is passed through whole', async () => {
    for (const answer of [25_000, null]) {
      counter.mockResolvedValue(answer)
      expect(await processMCPResult({ toolResult: big(200_000) }, 'tool', 'srv')).toBe(big(200_000))
    }
    counter.mockRejectedValue(new Error('counting endpoint down'))
    expect(await processMCPResult({ toolResult: big(200_000) }, 'tool', 'srv')).toBe(big(200_000))
    expect(counter).toHaveBeenCalledTimes(3)
    expect(savedFiles()).toEqual([])
  })

  test('large output over the cap is saved under tool-results, and the model is told how to read it', async () => {
    counter.mockResolvedValue(30_000)
    const cases: Array<{ result: unknown; tool: string; server: string; format: string; written: string }> = [
      { result: { toolResult: big(200_000) }, tool: 'dump', server: 'my srv', format: 'Plain text', written: big(200_000) },
      {
        result: { structuredContent: { rows: [big(120_000)] } },
        tool: 'rows',
        server: 'db',
        format: 'JSON with schema: {rows: [string]}',
        written: JSON.stringify({ rows: [big(120_000)] }),
      },
      {
        result: { content: [{ type: 'text', text: big(150_000) }] },
        tool: 'read.all',
        server: '../up',
        format: 'JSON array with schema: [{type: string, text: string}]',
        written: JSON.stringify([{ type: 'text', text: big(150_000) }], null, 2),
      },
    ]
    for (const { result, tool, server, format, written } of cases) {
      const before = new Set(savedFiles())
      const message = (await processMCPResult(result, tool, server)) as string
      const [file] = savedFiles().filter(f => !before.has(f))
      const path = join(getToolResultsDir(), file!)
      // Named by server, tool and time; what follows the time is free (see the spec's findings).
      expect(file).toMatch(new RegExp(`^mcp-${server.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}-\\d+[^/]*\\.txt$`))
      expect(readFileSync(path, 'utf8')).toBe(written)
      expect(typeof message).toBe('string')
      expect(message).toContain(`(${written.length.toLocaleString()} characters) exceeds maximum allowed tokens`)
      expect(message).toContain(`Output has been saved to ${path}.\n`)
      expect(message).toContain(`\nFormat: ${format}\n`)
      expect(message).toContain(`read the content from the file at ${path} in sequential chunks until 100% of the content has been read`)
      expect(message).toContain('offset and limit')
      expect(message).toContain('jq')
      expect(message).toContain('reduce the chunk size')
      expect(message).toContain('If you did not read the entire content, you MUST explicitly state this.')
    }
  })

  test('with large output files switched off, or images in the content, the output is cut instead', async () => {
    counter.mockResolvedValue(30_000)
    process.env.ENABLE_MCP_LARGE_OUTPUT_FILES = 'false'
    const cut = (await processMCPResult({ toolResult: big(200_000) }, 'tool', 'srv')) as string
    expect(cut.startsWith(big(100_000))).toBe(true)
    expect(cut).toContain('[OUTPUT TRUNCATED - exceeded 25000 token limit]')
    expect(cut.indexOf('[OUTPUT')).toBe(100_000 + 2)

    delete process.env.ENABLE_MCP_LARGE_OUTPUT_FILES
    const withImage = (await processMCPResult(
      { content: [{ type: 'text', text: big(150_000) }, { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] },
      'tool',
      'srv',
    )) as Array<{ type: string; text?: string }>
    expect(withImage.map(b => b.type)).toEqual(['text', 'text'])
    expect(withImage[0]!.text).toBe(big(100_000))
    expect(withImage[1]!.text).toContain('[OUTPUT TRUNCATED - exceeded 25000 token limit]')
    expect(savedFiles()).toEqual([])
  })

  test('when the file cannot be saved, the model gets the size and the reason instead of the output', async () => {
    counter.mockResolvedValue(30_000)
    mkdirSync(dirname(getToolResultsDir()), { recursive: true })
    writeFileSync(getToolResultsDir(), 'in the way')
    const message = (await processMCPResult({ toolResult: big(200_000) }, 'tool', 'srv')) as string
    expect(message).toStartWith('Error: result (200,000 characters) exceeds maximum allowed tokens. Failed to save output to file: ')
    expect(message).toContain('pagination or filtering tools')
    expect(message).not.toContain('x'.repeat(100))
  })

  test('MAX_MCP_OUTPUT_TOKENS moves the cap', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000'
    counter.mockResolvedValue(1_001)
    process.env.ENABLE_MCP_LARGE_OUTPUT_FILES = '0'
    const cut = (await processMCPResult({ toolResult: big(10_000) }, 'tool', 'srv')) as string
    expect(cut.startsWith(big(4_000) + '\n\n[OUTPUT TRUNCATED - exceeded 1000 token limit]')).toBe(true)
  })
})

// --- validation -----------------------------------------------------------------------------

describe('mcpValidation', () => {
  test('the cap and its constants', () => {
    expect({ factor: MCP_TOKEN_COUNT_THRESHOLD_FACTOR, image: IMAGE_TOKEN_ESTIMATE }).toEqual({ factor: 0.5, image: 1600 })
    const cases: Array<[string | undefined, number]> = [
      [undefined, 25_000],
      ['', 25_000],
      ['8000', 8_000],
      ['8000tokens', 8_000],
      ['0', 25_000],
      ['-5', 25_000],
      ['lots', 25_000],
    ]
    for (const [value, cap] of cases) {
      if (value === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS
      else process.env.MAX_MCP_OUTPUT_TOKENS = value
      expect({ value, cap: getMaxMcpOutputTokens() }).toEqual({ value, cap })
    }
  })

  test('the size estimate counts text, 1600 per image, and nothing for other blocks', () => {
    const rough = tokenEstimation.roughTokenCountEstimation
    expect(getContentSizeEstimate(undefined)).toBe(0)
    expect(getContentSizeEstimate('')).toBe(0)
    expect(getContentSizeEstimate('abcdefgh'.repeat(100))).toBe(rough('abcdefgh'.repeat(100)))
    expect(
      getContentSizeEstimate([
        { type: 'text', text: 'y'.repeat(400) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'z'.repeat(10_000) } } as never,
      ]),
    ).toBe(rough('y'.repeat(400)) + 1600)
  })

  test('counting is asked only above half the cap, and only an answer over the cap means too big', async () => {
    const atHalf = 'h'.repeat(Math.ceil(12_500 * tokenEstimation.getActiveModelBytesPerToken()))
    expect(getContentSizeEstimate(atHalf)).toBe(12_500)
    expect(await mcpContentNeedsTruncation(atHalf)).toBe(false)
    expect(await mcpContentNeedsTruncation(undefined)).toBe(false)
    expect(counter).not.toHaveBeenCalled()

    const over = atHalf + 'hhhhhhhh'
    const cases: Array<[number | null, boolean]> = [
      [25_001, true],
      [25_000, false],
      [0, false],
      [null, false],
    ]
    for (const [answer, needs] of cases) {
      counter.mockResolvedValueOnce(answer)
      expect({ answer, needs: await mcpContentNeedsTruncation(over) }).toEqual({ answer, needs })
    }
    expect(counter).toHaveBeenCalledTimes(4)
    expect(counter.mock.calls[0]).toEqual([[{ role: 'user', content: over }], []])
  })

  test('cutting text: strings and text blocks share one budget of four characters per token', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '10'
    expect(await truncateMcpContent(undefined)).toBeUndefined()
    const cutString = (await truncateMcpContent('0123456789'.repeat(10))) as string
    expect(cutString.slice(0, 42)).toBe('0123456789012345678901234567890123456789\n\n')
    expect(cutString).toContain('[OUTPUT TRUNCATED - exceeded 10 token limit]')
    expect(cutString).toContain('If this MCP server provides pagination or filtering tools, use them')
    expect(cutString).toContain('inform the user that you are working with truncated output')

    const blocks = (await truncateMcpContent([
      { type: 'text', text: 'a'.repeat(25) },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'doc' } } as never,
      { type: 'text', text: 'b'.repeat(25) },
      { type: 'text', text: 'never reached' },
    ])) as Array<{ type: string; text?: string }>
    expect(blocks.map(b => b.text ?? b.type) as unknown[]).toEqual(['a'.repeat(25), 'document', 'b'.repeat(15), blocks[3]!.text])
    expect(blocks).toHaveLength(4)
    expect(blocks[3]!.text).toContain('[OUTPUT TRUNCATED - exceeded 10 token limit]')
  })

  test('cutting images: kept while they fit, squeezed into what is left, dropped when nothing is left', async () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } } as const
    process.env.MAX_MCP_OUTPUT_TOKENS = '1600'
    const fits = (await truncateMcpContent([image, { type: 'text', text: 'after' }])) as Array<{ type: string; text?: string }>
    expect(fits.map(b => b.type)).toEqual(['image', 'text'])
    expect(fits[1]!.text).toContain('[OUTPUT TRUNCATED')

    process.env.MAX_MCP_OUTPUT_TOKENS = '1700'
    const squeezed = (await truncateMcpContent([{ type: 'text', text: 't'.repeat(6_700) }, image])) as Array<{ type: string }>
    expect(squeezed.map(b => b.type)).toEqual(['text', 'image', 'text'])

    process.env.MAX_MCP_OUTPUT_TOKENS = '10'
    const dropped = (await truncateMcpContent([{ type: 'text', text: 't'.repeat(40) }, image])) as Array<{ type: string }>
    expect(dropped.map(b => b.type)).toEqual(['text', 'text'])
  })

  test('cut-if-needed returns the very same content when no cut is needed', async () => {
    const content = [{ type: 'text' as const, text: 'tiny' }]
    expect(await truncateMcpContentIfNeeded(content)).toBe(content)
    counter.mockResolvedValueOnce(99_999)
    const cut = (await truncateMcpContentIfNeeded('q'.repeat(200_000))) as string
    expect(cut.length).toBeLessThan(200_000)
    expect(cut).toContain('[OUTPUT TRUNCATED - exceeded 25000 token limit]')
  })
})

// --- storage --------------------------------------------------------------------------------

describe('mcpOutputStorage', () => {
  test('format descriptions', () => {
    const cases: Array<[Parameters<typeof getFormatDescription>[0], unknown, string]> = [
      ['toolResult', '{a: number}', 'Plain text'],
      ['structuredContent', '{a: number}', 'JSON with schema: {a: number}'],
      ['structuredContent', undefined, 'JSON'],
      ['contentArray', '[{type: string}]', 'JSON array with schema: [{type: string}]'],
      ['contentArray', '', 'JSON array'],
    ]
    for (const [type, schema, text] of cases) expect(getFormatDescription(type, schema)).toBe(text)
  })

  test('the read-the-file instructions name the path twice, the size, the format, and the reading rules', () => {
    const plain = getLargeOutputInstructions('/tmp/out.txt', 1234567, 'Plain text')
    const bash = getLargeOutputInstructions('/tmp/out.txt', 50, 'JSON', 30000)
    for (const text of [plain, bash]) {
      expect(text.split('/tmp/out.txt').length - 1).toBe(2)
      expect(text).toContain('MUST read the content from the file')
      expect(text).toContain('sequential chunks until 100% of the content has been read')
      expect(text).toContain('Before producing ANY summary or analysis')
      expect(text.endsWith('\n')).toBe(true)
    }
    expect(plain).toStartWith('Error: result (1,234,567 characters) exceeds maximum allowed tokens.')
    // [which form, a fact it must state, whether it is there]
    const facts: Array<[string, string, RegExp, boolean]> = [
      ['plain', plain, /\nFormat: Plain text\n/, true],
      ['plain', plain, /30,000/, false],
      ['plain', plain, /PROCEED/, false],
      ['plain', plain, /\[N lines truncated\]/, false],
      ['bash', bash, /\nFormat: JSON\n/, true],
      ['bash', bash, /limited to 30,000 chars/, true],
      ['bash', bash, /\[N lines truncated\]/, true],
      ['bash', bash, /\*{3}DO NOT PROCEED UNTIL YOU HAVE DONE THIS\*{3}/, true],
    ]
    for (const [form, text, fact, present] of facts) expect([form, String(fact), fact.test(text)]).toEqual([form, String(fact), present])
  })

  test('extensions come from a fixed list of mime types; anything else is bin', () => {
    const cases: Array<[string | undefined, string]> = [
      ['application/pdf', 'pdf'],
      ['application/json', 'json'],
      ['text/csv', 'csv'],
      ['text/plain', 'txt'],
      ['text/html', 'html'],
      ['text/markdown', 'md'],
      ['application/zip', 'zip'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
      ['application/msword', 'doc'],
      ['application/vnd.ms-excel', 'xls'],
      ['audio/mpeg', 'mp3'],
      ['audio/wav', 'wav'],
      ['audio/ogg', 'ogg'],
      ['video/mp4', 'mp4'],
      ['video/webm', 'webm'],
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/gif', 'gif'],
      ['image/webp', 'webp'],
      ['image/svg+xml', 'svg'],
      ['Text/Plain; charset=utf-8', 'txt'],
      ['  application/PDF ;x=1', 'pdf'],
      ['application/x-sh', 'bin'],
      ['../../etc/passwd', 'bin'],
      ['text/plain/../../x', 'bin'],
      ['', 'bin'],
      [undefined, 'bin'],
    ]
    for (const [mime, ext] of cases) expect({ mime, ext: extensionForMimeType(mime) }).toEqual({ mime, ext })
  })

  test('which content types count as binary', () => {
    const cases: Array<[string, boolean]> = [
      ['', false],
      ['text/html; charset=utf-8', false],
      ['TEXT/CSV', false],
      ['application/json', false],
      ['application/ld+json', false],
      ['application/xml', false],
      ['image/svg+xml', false],
      ['application/javascript', false],
      ['application/javascript; charset=utf-8', false],
      ['application/x-www-form-urlencoded', false],
      ['application/pdf', true],
      ['application/octet-stream', true],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
      ['application/jsonl', true],
      ['image/png', true],
      ['audio/mpeg', true],
    ]
    for (const [type, binary] of cases) expect({ type, binary: isBinaryContentType(type) }).toEqual({ type, binary })
  })

  test('raw bytes are written as given under tool-results with the derived extension', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255])
    const result = await persistBinaryContent(bytes, 'application/zip', 'webfetch-123-abc')
    expect(result).toEqual({ filepath: join(getToolResultsDir(), 'webfetch-123-abc.zip'), size: 5, ext: 'zip' })
    expect(readFileSync(join(getToolResultsDir(), 'webfetch-123-abc.zip'))).toEqual(bytes)
    expect(statSync(getToolResultsDir()).isDirectory()).toBe(true)

    const again = await persistBinaryContent(Buffer.from('second'), 'application/zip', 'webfetch-123-abc')
    expect(again).toEqual({ filepath: join(getToolResultsDir(), 'webfetch-123-abc.zip'), size: 6, ext: 'zip' })
    expect(readFileSync(join(getToolResultsDir(), 'webfetch-123-abc.zip'), 'utf8')).toBe('second')
  })

  test('a write that fails is reported, not thrown', async () => {
    mkdirSync(dirname(getToolResultsDir()), { recursive: true })
    writeFileSync(getToolResultsDir(), 'blocking file')
    const result = await persistBinaryContent(Buffer.from('x'), 'application/pdf', 'doomed')
    expect(Object.keys(result)).toEqual(['error'])
    expect((result as { error: string }).error.length).toBeGreaterThan(0)
  })

  test('the saved-blob message', () => {
    const cases: Array<[string | undefined, number, string, string]> = [
      ['application/pdf', 2048, '[Resource from a at b] ', '[Resource from a at b] Binary content (application/pdf, 2KB) saved to /p/f.pdf'],
      [undefined, 12, '', 'Binary content (unknown type, 12 bytes) saved to /p/f.pdf'],
      ['audio/wav', 3 * 1024 * 1024, '[Audio from s] ', '[Audio from s] Binary content (audio/wav, 3MB) saved to /p/f.pdf'],
    ]
    for (const [mime, size, prefix, text] of cases) expect(getBinaryBlobSavedMessage('/p/f.pdf', mime, size, prefix)).toBe(text)
  })
})
