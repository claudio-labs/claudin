/**
 * Characterization of the extraction prompts (src/memory/extract/prompts.ts).
 *
 * The rewrite brings its own wording, so no sentence is pinned here. What is:
 * the facts a prompt must state (numbers, tool names, file names, formats,
 * limits), the shared sections from src/memory/memdir/memoryTypes.ts it must
 * carry verbatim, and where its inputs (count, manifest, hint) land.
 *
 * The combined prompt with the TEAMMEM build flag on, the one the shipped
 * build sends, is pinned in extractMemories.shipFlags.characterization.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { checkoutRoot } from 'src/memory/extract/__testutils__/extractionHarness.js'
import {
  buildExtractAutoOnlyPrompt,
  buildExtractCombinedPrompt,
  buildLoopHint,
} from 'src/memory/extract/prompts.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  renderTeamCategoriesXml,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from 'src/memory/memdir/memoryTypes.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'

const MANIFEST = [
  '- [feedback] feedback_temp_dirs.md (2026-03-04T05:06:07.000Z): Tests build their own scratch directories',
  '- notes/untyped.md (2026-01-01T00:00:00.000Z)',
].join('\n')

const HINT = buildLoopHint('Bash', 4)

const FORK_TOOLS = [
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  BASH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
]

/** True when every line of `shorter` appears in `longer`, in the same order. */
function keepsEveryLineOf(shorter: string, longer: string): boolean {
  const wanted = shorter.split('\n')
  let next = 0
  for (const line of longer.split('\n')) {
    if (next < wanted.length && line === wanted[next]) next++
  }
  return next === wanted.length
}

describe('buildLoopHint', () => {
  test('names the failing tool in code, and how many times it failed', () => {
    expect(buildLoopHint('Bash', 4)).toContain('`Bash`')
    expect(buildLoopHint('Bash', 4)).toContain('4×')
    expect(buildLoopHint('Edit', 3)).toContain('`Edit`')
    expect(buildLoopHint('Edit', 3)).toContain('3×')
  })

  test('asks for a `feedback` memory with its **Why:** and **How to apply:** lines', () => {
    const hint = buildLoopHint('Grep', 5)
    expect(hint).toContain('`feedback`')
    expect(hint).toContain('**Why:**')
    expect(hint).toContain('**How to apply:**')
  })
})

describe('buildExtractAutoOnlyPrompt', () => {
  test('states the number of new messages as an approximation, and only that varies with it', () => {
    const seven = buildExtractAutoOnlyPrompt(7, MANIFEST)
    const twelve = buildExtractAutoOnlyPrompt(12, MANIFEST)
    expect(seven).toContain('~7')
    expect(seven.replaceAll('~7', '~N')).toBe(twelve.replaceAll('~12', '~N'))
  })

  test('names the tools the fork may use by their registered names, Bash as read-only, and rules out rm', () => {
    const prompt = buildExtractAutoOnlyPrompt(3, '')
    for (const name of FORK_TOOLS) expect(prompt).toContain(name)
    expect(prompt).toMatch(/read-only/)
    expect(prompt).toMatch(/\brm\b/)
  })

  test('carries the private taxonomy and the exclusions verbatim, and nothing about team memory', () => {
    const prompt = buildExtractAutoOnlyPrompt(3, '')
    expect(prompt).toContain(TYPES_SECTION_INDIVIDUAL.join('\n'))
    expect(prompt).toContain(WHAT_NOT_TO_SAVE_SECTION.join('\n'))
    expect(prompt).not.toContain(TYPES_SECTION_COMBINED.join('\n'))
    expect(prompt).not.toContain(renderTeamCategoriesXml().join('\n'))
  })

  test('shows the frontmatter example verbatim', () => {
    expect(buildExtractAutoOnlyPrompt(3, '')).toContain(MEMORY_FRONTMATTER_EXAMPLE.join('\n'))
  })

  test('describes the index: MEMORY.md, one entry per line in the link format, ~150 characters, cut after 200 lines', () => {
    const prompt = buildExtractAutoOnlyPrompt(3, '')
    expect(prompt).toContain('`MEMORY.md`')
    expect(prompt).toContain('`- [Title](file.md) — one-line hook`')
    expect(prompt).toMatch(/\b150\b/)
    expect(prompt).toMatch(/\b200\b/)
  })

  test('explains `paths:` frontmatter in the terms of a rule under .claudin/rules/', () => {
    const prompt = buildExtractAutoOnlyPrompt(3, '')
    expect(prompt).toContain('`paths:`')
    expect(prompt).toContain('`.claudin/rules/`')
  })

  test('lists a manifest verbatim, and says nothing of existing files when there is none', () => {
    const bare = buildExtractAutoOnlyPrompt(3, '')
    const listed = buildExtractAutoOnlyPrompt(3, MANIFEST)
    expect(listed).toContain(MANIFEST)
    expect(keepsEveryLineOf(bare, listed)).toBe(true)
    // The manifest comes with framing of its own, and none of it is in the bare prompt.
    const added = listed.split('\n').length - bare.split('\n').length
    expect(added).toBeGreaterThan(MANIFEST.split('\n').length)
  })

  test('adds a hint verbatim; an empty hint is no hint', () => {
    const plain = buildExtractAutoOnlyPrompt(3, MANIFEST)
    const hinted = buildExtractAutoOnlyPrompt(3, MANIFEST, HINT)
    expect(hinted).toContain(HINT)
    expect(plain).not.toContain(HINT)
    expect(keepsEveryLineOf(plain, hinted)).toBe(true)
    expect(buildExtractAutoOnlyPrompt(3, MANIFEST, '')).toBe(plain)
  })

  test('opens the way the wire proxy recognizes a memory-extraction fork', async () => {
    // scripts/bench/ab/wire-proxy.ts tells a fork from the main loop by how its
    // prompt opens. Loaded by path: src/ has no alias into scripts/.
    const proxy = await import(join(checkoutRoot(), 'scripts', 'bench', 'ab', 'wire-proxy.ts'))
    const loop = { max_tokens: 8_000, tools: [{ name: 'Read' }, { name: 'Edit' }] }
    const task = { role: 'user', content: 'rename the exporter' }
    expect(proxy.requestKind({ ...loop, messages: [task] })).toBe('main')
    const extraction = { role: 'user', content: buildExtractAutoOnlyPrompt(3, MANIFEST, HINT) }
    const forked = [task, { role: 'assistant', content: 'done' }, extraction]
    expect(proxy.requestKind({ ...loop, messages: forked })).toBe('other')
  })
})

describe('buildExtractCombinedPrompt, with the TEAMMEM build flag off', () => {
  test('is exactly the auto-only prompt', () => {
    expect(buildExtractCombinedPrompt(5, MANIFEST, HINT)).toBe(
      buildExtractAutoOnlyPrompt(5, MANIFEST, HINT),
    )
    expect(buildExtractCombinedPrompt(5, '')).toBe(buildExtractAutoOnlyPrompt(5, ''))
  })
})
