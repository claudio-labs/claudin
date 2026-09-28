/**
 * Characterization of the session-memory helpers that travel with the
 * extraction unit:
 *   - where a session's memory file lives (src/memory/session/paths.ts);
 *   - reading it, and the last-summarized message id
 *     (src/memory/session/sessionMemoryUtils.ts);
 *   - the template check and the per-section cap applied before the file goes
 *     into a compaction summary (src/memory/session/prompts.ts).
 *
 * Real files under a scratch CLAUDIN_CONFIG_DIR; the working directory and the
 * session id come from the real bootstrap state, put back after each test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { useScene } from 'src/memory/extract/__testutils__/extractionHarness.js'
import { isAutoManagedMemoryFile } from 'src/memory/memdir/memoryFileDetection.js'
import { getSessionMemoryDir, getSessionMemoryPath } from 'src/memory/session/paths.js'
import {
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
} from 'src/memory/session/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  setLastSummarizedMessageId,
} from 'src/memory/session/sessionMemoryUtils.js'
import {
  getSessionId,
  getSessionProjectDir,
  setCwdState,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getCwd, runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { getActiveModelBytesPerToken } from 'src/shared/tokenEstimation.js'
import type { SessionId } from 'src/shared/types/ids.js'
import { detectSessionFileType } from 'src/tools/FileReadTool/guards.js'

const scene = useScene()

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const FILLED_SUMMARY = readFileSync(join(FIXTURES, 'session-summary.md'), 'utf8')
const CUSTOM_TEMPLATE = readFileSync(join(FIXTURES, 'session-template.md'), 'utf8')

const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0

/** The project-directory key the sessions slice derives from a short path. */
function projectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function customTemplatePath(): string {
  return join(scene().configDir, 'session-memory', 'config', 'template.md')
}

function writeSummary(text: string): string {
  const path = getSessionMemoryPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('where the session memory lives', () => {
  test('<config>/projects/<key of the working directory>/<session id>/session-memory/, with its separator', () => {
    const { configDir, projectDir } = scene()
    expect(getSessionMemoryDir()).toBe(
      join(configDir, 'projects', projectKey(projectDir), getSessionId(), 'session-memory') + sep,
    )
  })

  test("is the session's folder inside the transcript project directory", () => {
    expect(getSessionMemoryDir()).toBe(
      join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep,
    )
  })

  test('the file is summary.md in that directory', () => {
    expect(getSessionMemoryPath()).toBe(join(getSessionMemoryDir(), 'summary.md'))
    expect(getSessionMemoryPath().startsWith(getSessionMemoryDir())).toBe(true)
  })

  test('follows the working directory, an agent override included', () => {
    const elsewhere = join(scene().root, 'elsewhere')
    setCwdState(elsewhere)
    expect(getSessionMemoryDir()).toContain(`${sep}${projectKey(elsewhere)}${sep}`)
    const overridden = join(scene().root, 'agent-worktree')
    const seen = runWithCwdOverride(overridden, () => getSessionMemoryPath())
    expect(seen).toBe(
      join(getProjectDir(overridden), getSessionId(), 'session-memory', 'summary.md'),
    )
  })

  test('follows the active session, and not the project directory a resumed session names', () => {
    const originalId = getSessionId()
    const originalProjectDir = getSessionProjectDir()
    try {
      switchSession('11111111-2222-4333-8444-555555555555' as SessionId)
      expect(getSessionMemoryDir()).toContain(`${sep}11111111-2222-4333-8444-555555555555${sep}`)
      switchSession(
        '66666666-7777-4888-9999-000000000000' as SessionId,
        join(scene().root, 'another-project-dir'),
      )
      expect(getSessionMemoryDir()).toBe(
        join(getProjectDir(getCwd()), '66666666-7777-4888-9999-000000000000', 'session-memory') + sep,
      )
    } finally {
      switchSession(originalId, originalProjectDir)
    }
  })

  test('the Read tool and the memory-file detector both recognize it as session memory', () => {
    expect(detectSessionFileType(getSessionMemoryPath())).toBe('session_memory')
    expect(isAutoManagedMemoryFile(getSessionMemoryPath())).toBe(true)
  })
})

describe('getSessionMemoryContent', () => {
  test('null when there is no file', async () => {
    expect(await getSessionMemoryContent()).toBeNull()
  })

  test("the file's text exactly, read afresh at every call", async () => {
    const path = writeSummary(FILLED_SUMMARY)
    expect(await getSessionMemoryContent()).toBe(FILLED_SUMMARY)
    writeFileSync(path, 'changed — ação ✓\n')
    expect(await getSessionMemoryContent()).toBe('changed — ação ✓\n')
  })

  test('an empty file reads as an empty string, not null', async () => {
    writeSummary('')
    expect(await getSessionMemoryContent()).toBe('')
  })

  test('null when the path cannot be reached: a file where its directory should be, or a symlink loop', async () => {
    const directory = getSessionMemoryDir()
    mkdirSync(dirname(directory), { recursive: true })
    writeFileSync(directory.slice(0, -1), 'not a directory')
    expect(await getSessionMemoryContent()).toBeNull()

    rmSync(directory.slice(0, -1))
    mkdirSync(directory, { recursive: true })
    symlinkSync(getSessionMemoryPath(), getSessionMemoryPath())
    expect(await getSessionMemoryContent()).toBeNull()
  })

  test.skipIf(!canTestPermissions)('null when the file may not be read', async () => {
    const path = writeSummary(FILLED_SUMMARY)
    chmodSync(path, 0o000)
    try {
      expect(await getSessionMemoryContent()).toBeNull()
    } finally {
      chmodSync(path, 0o600)
    }
  })

  test('any other failure reaches the caller: a directory in place of the file rejects with EISDIR', async () => {
    mkdirSync(getSessionMemoryPath(), { recursive: true })
    await expect(getSessionMemoryContent()).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('the last summarized message id', () => {
  let before: string | undefined

  beforeEach(() => {
    before = getLastSummarizedMessageId()
  })

  afterEach(() => {
    setLastSummarizedMessageId(before)
  })

  // Its initial value is checked in a fresh process: extractMemories.firstUse.characterization.test.ts.

  test('returns what was set, until undefined clears it', () => {
    setLastSummarizedMessageId('message-41')
    expect(getLastSummarizedMessageId()).toBe('message-41')
    setLastSummarizedMessageId('message-42')
    expect(getLastSummarizedMessageId()).toBe('message-42')
    setLastSummarizedMessageId(undefined)
    expect(getLastSummarizedMessageId()).toBeUndefined()
  })
})

describe('DEFAULT_SESSION_MEMORY_TEMPLATE', () => {
  const headers = [
    '# Session Title',
    '# Current State',
    '# Task specification',
    '# Files and Functions',
    '# Workflow',
    '# Errors & Corrections',
    '# Codebase and System Documentation',
    '# Learnings',
    '# Key results',
    '# Worklog',
  ]

  test('ten sections in this order, each a header and one italic line, blank lines between, a newline at both ends', () => {
    const lines = DEFAULT_SESSION_MEMORY_TEMPLATE.split('\n')
    expect(lines).toHaveLength(1 + headers.length * 3)
    expect(lines[0]).toBe('')
    headers.forEach((header, index) => {
      const at = 1 + index * 3
      expect(lines[at]).toBe(header)
      expect(lines[at + 1]).toMatch(/^_[^\n]+_$/)
      expect(lines[at + 2]).toBe('')
    })
  })

  test('asks for a 5-10 word title', () => {
    const titleGuide = DEFAULT_SESSION_MEMORY_TEMPLATE.split('\n')[2]
    expect(titleGuide).toContain('5-10')
  })
})

describe('isSessionMemoryEmpty', () => {
  test('true for the default template, whatever whitespace surrounds it', async () => {
    expect(await isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(true)
    const padded = `\n\n  ${DEFAULT_SESSION_MEMORY_TEMPLATE.trim()}  \n\t\n`
    expect(await isSessionMemoryEmpty(padded)).toBe(true)
  })

  test('false once anything is written into it, or its inner spacing differs', async () => {
    expect(await isSessionMemoryEmpty(FILLED_SUMMARY)).toBe(false)
    const filledIn = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
      '# Worklog\n',
      '# Worklog\n- ran the tests\n',
    )
    expect(await isSessionMemoryEmpty(filledIn)).toBe(false)
    const respaced = DEFAULT_SESSION_MEMORY_TEMPLATE.replace('\n\n# Worklog', '\n\n\n# Worklog')
    expect(await isSessionMemoryEmpty(respaced)).toBe(false)
  })

  test('false for an empty string', async () => {
    expect(await isSessionMemoryEmpty('')).toBe(false)
  })

  test('a template at <config>/session-memory/config/template.md replaces the default, read at every call', async () => {
    mkdirSync(dirname(customTemplatePath()), { recursive: true })
    writeFileSync(customTemplatePath(), CUSTOM_TEMPLATE)
    expect(await isSessionMemoryEmpty(CUSTOM_TEMPLATE.trim())).toBe(true)
    expect(await isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(false)

    rmSync(customTemplatePath())
    expect(await isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(true)
    expect(await isSessionMemoryEmpty(CUSTOM_TEMPLATE)).toBe(false)
  })

  test('an empty template file makes blank content count as empty', async () => {
    mkdirSync(dirname(customTemplatePath()), { recursive: true })
    writeFileSync(customTemplatePath(), '')
    expect(await isSessionMemoryEmpty('  \n')).toBe(true)
    expect(await isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(false)
  })

  test('a template that cannot be read falls back to the default', async () => {
    mkdirSync(customTemplatePath(), { recursive: true })
    expect(await isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(true)
  })
})

describe('truncateSessionMemoryForCompact', () => {
  /** Characters a section body may hold: 2000 tokens at the active model's bytes per token. */
  const cap = () => Math.floor(2000 * getActiveModelBytesPerToken())

  /** Splits a truncated section into what was kept and its closing line. */
  function closingOf(text: string): { kept: string[]; blank: string | undefined; marker: string } {
    const lines = text.split('\n')
    const marker = lines.at(-1) ?? ''
    return { kept: lines.slice(0, -2), blank: lines.at(-2), marker }
  }

  test('text within the cap comes back unchanged', () => {
    expect(truncateSessionMemoryForCompact(FILLED_SUMMARY)).toStrictEqual({
      truncatedContent: FILLED_SUMMARY,
      wasTruncated: false,
    })
  })

  test('a section body of exactly the cap is kept; one character more is cut', () => {
    const exact = `# Worklog\n${'a'.repeat(cap() - 2)}\nb`
    expect(truncateSessionMemoryForCompact(exact)).toStrictEqual({
      truncatedContent: exact,
      wasTruncated: false,
    })

    const over = `# Worklog\n${'a'.repeat(cap() - 2)}\nbb`
    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(over)
    expect(wasTruncated).toBe(true)
    const { kept, blank, marker } = closingOf(truncatedContent)
    expect(kept).toEqual(['# Worklog', 'a'.repeat(cap() - 2)])
    expect(blank).toBe('')
    expect(marker).toMatch(/truncated/)
  })

  test('a long section keeps whole lines up to the cap, then a blank line and a truncation note', () => {
    const fits = Math.floor(cap() / 10)
    const body = Array.from({ length: fits + 50 }, (_, index) => `line ${String(index).padStart(4, '0')}`)
    expect(body[0]).toHaveLength(9)
    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(
      ['# Worklog', ...body].join('\n'),
    )
    expect(wasTruncated).toBe(true)
    const { kept, blank, marker } = closingOf(truncatedContent)
    expect(kept).toEqual(['# Worklog', ...body.slice(0, fits)])
    expect(blank).toBe('')
    expect(marker).toMatch(/truncated/)
    expect(marker).not.toContain('line ')
  })

  test('a first line longer than the cap leaves only the header and the note', () => {
    const { truncatedContent } = truncateSessionMemoryForCompact(`# Worklog\n${'x'.repeat(cap() + 1)}`)
    const { kept, blank } = closingOf(truncatedContent)
    expect(kept).toEqual(['# Worklog'])
    expect(blank).toBe('')
  })

  test('only "# " lines open a section: "## " sub-headers and "#tag" lines are body text', () => {
    const half = 'h'.repeat(Math.floor(cap() / 2))
    const text = ['# Worklog', half, '## Sub-header', half, '#tag', 'end'].join('\n')
    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(text)
    expect(wasTruncated).toBe(true)
    expect(closingOf(truncatedContent).kept).toEqual(['# Worklog', half, '## Sub-header'])
  })

  test('text before the first header is never cut', () => {
    const preamble = 'p'.repeat(cap() * 2)
    const text = `${preamble}\n# Worklog\nshort`
    expect(truncateSessionMemoryForCompact(text)).toStrictEqual({
      truncatedContent: text,
      wasTruncated: false,
    })
  })

  test('each section is capped on its own, and the sections after a cut one survive whole', () => {
    const long = Array.from({ length: Math.floor(cap() / 10) + 5 }, () => 'x'.repeat(9))
    const text = ['intro', '# First', ...long, '# Second', 'kept as it is', '# Third', 'also kept'].join('\n')
    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(text)
    expect(wasTruncated).toBe(true)
    const lines = truncatedContent.split('\n')
    const second = lines.indexOf('# Second')
    expect(lines.slice(0, 2)).toEqual(['intro', '# First'])
    expect(lines[second - 2]).toBe('')
    expect(lines[second - 1]).toMatch(/truncated/)
    expect(lines.slice(second)).toEqual(['# Second', 'kept as it is', '# Third', 'also kept'])
  })

  test('empty input stays empty', () => {
    expect(truncateSessionMemoryForCompact('')).toStrictEqual({
      truncatedContent: '',
      wasTruncated: false,
    })
  })
})
