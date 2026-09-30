/**
 * The memory format guard: what it refuses, what it lets through — the shapes
 * the extraction and dream forks write included — and the index-line advice.
 *
 * The pure halves take the directories as arguments and carry most of it.
 * The wrappers are asserted on private paths only: they resolve the team dir
 * under feature('TEAMMEM'), which reads false under `bun test`, so a team
 * path through a wrapper is a private one here. The call sites are pinned on
 * the source, as teamMemSecretGuard's are reachable in the bundle only.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CATEGORY_FIELDS,
  checkMemoryFileFormat,
  checkMemoryFileFormatIn,
  memoryIndexAdvice,
  memoryIndexAdviceIn,
  type MemoryDirs,
} from 'src/memory/memdir/memoryFormatGuard.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  type MemoryType,
  TEAM_CATEGORIES,
} from 'src/memory/memdir/memoryTypes.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { buildMemoryWriteRules } from 'src/memory/memdir/teamMemPrompts.js'
import { applyPatchMemoryIndexAdvice } from 'src/tools/ApplyPatchTool/applyPatch.js'

const AUTO = '/repo/.claudin/memory/'
const TEAM = '/repo/.claudin/memory/team/'
const DIRS: MemoryDirs = { autoDir: AUTO, teamDir: TEAM }

const PLACEHOLDER_RE = /\{\{[^}]*\}\}/
const FEEDBACK_BODY =
  'Never use default exports — always named exports.\n\n**Why:** the user corrected it on 2026-09-29.\n**How to apply:** export every symbol by name.'
const DECISION_BODY =
  '**Decision:** the disk cache is gone.\n**Why:** it corrupted on NFS.\n**What changes for a teammate:** no cache dir to clear.\n**Rejected:** a file lock — NFS locks are unreliable.\n**Evidence:** the 2026-09-29 session.'

/**
 * A memory as the extraction and dream forks are told to write it: the
 * shared frontmatter template with its placeholders filled, plus the lines a
 * category adds before the closing `---`.
 */
function fromTemplate(type: MemoryType, extra: string[] = [], body = FEEDBACK_BODY): string {
  const lines = MEMORY_FRONTMATTER_EXAMPLE.filter(line => !line.startsWith('```')).map(line => {
    if (line.startsWith('name:')) return line.replace(PLACEHOLDER_RE, 'named-exports-only')
    if (line.startsWith('description:')) return line.replace(PLACEHOLDER_RE, 'this project never uses default exports')
    if (line.startsWith('type:')) return line.replace(PLACEHOLDER_RE, type)
    return line.replace(PLACEHOLDER_RE, body)
  })
  lines.splice(lines.indexOf('---', 1), 0, ...extra)
  return `${lines.join('\n')}\n`
}

const check = (rel: string, content: string) => checkMemoryFileFormatIn(DIRS, `${AUTO}${rel}`, content)

describe('checkMemoryFileFormatIn — what it lets through', () => {
  test('the template fills every placeholder', () => {
    expect(fromTemplate('feedback')).not.toContain('{{')
    expect(fromTemplate('feedback')).toStartWith('---\nname: named-exports-only\n')
  })

  test('every type, private or at the team root, as the template writes it', () => {
    for (const type of ['user', 'feedback', 'project', 'reference'] as const) {
      expect(check(`${type}-x.md`, fromTemplate(type))).toBeNull()
      if (type !== 'user') expect(check(`team/${type}-x.md`, fromTemplate(type))).toBeNull()
    }
  })

  test('each team category in the shape its bodyStructure asks for', () => {
    // As the extraction/dream prompts render TEAM_CATEGORIES: a decision adds
    // scope and impact, a bug and a doc usually carry `paths:`.
    expect(
      check('team/decisions/drop-disk-cache.md', fromTemplate('project', ['scope: cache', 'impact: rejected'], DECISION_BODY)),
    ).toBeNull()
    expect(check('team/bugs/nfs-lock.md', fromTemplate('project', ['paths:', '  - "src/cache/**"']))).toBeNull()
    // An unquoted glob fails the first YAML parse; the parser's quoting retry takes it.
    expect(check('team/docs/cache-design.md', fromTemplate('reference', ['paths: src/cache/**']))).toBeNull()
  })

  test('a description holding `: ` parses through the quoting retry', () => {
    const content = fromTemplate('project').replace(
      'description: this project never uses default exports',
      'description: 2026-09-29 — the rule: named exports only',
    )
    expect(check('team/x.md', content)).toBeNull()
  })
})

describe('checkMemoryFileFormatIn — what it refuses', () => {
  test('a file with no frontmatter, or one that does not parse', () => {
    expect(check('x.md', 'Use pnpm.\n')).toContain('it has no frontmatter')
    // A more-indented line continues `name:` as a plain scalar, and its `: `
    // is then invalid — the quoting retry only rewrites top-level lines.
    expect(check('x.md', '---\nname: x\n   description: y: z\n---\nbody\n')).toContain('does not parse')
    expect(check('x.md', '---\n---\nbody\n')).toContain('it has no frontmatter')
  })

  test('a missing name, description or type names the key', () => {
    const full = fromTemplate('feedback')
    expect(check('x.md', full.replace(/^name: .*\n/m, ''))).toContain('it lacks `name:`')
    expect(check('x.md', full.replace(/^description: .*\n/m, ''))).toContain('it lacks `description:`')
    expect(check('x.md', full.replace(/^type: .*\n/m, ''))).toContain(
      'it lacks `type:` (user | feedback | project | reference)',
    )
    expect(check('x.md', full.replace('type: feedback', 'type: convention'))).toContain(
      '`type: convention` is not one of',
    )
  })

  test('a user memory in the team dir, at the root or in a category', () => {
    for (const rel of ['team/me.md', 'team/decisions/me.md']) {
      const refusal = check(rel, fromTemplate('user', ['scope: x', 'impact: functional']))
      expect(refusal).toContain('`type: user` is always private')
      expect(refusal).toContain(AUTO)
    }
  })

  test('a category memory whose type is not the category type', () => {
    expect(check('team/docs/x.md', fromTemplate('project'))).toContain(
      'a team doc memory is `type: reference`, not `project`',
    )
    expect(check('team/bugs/x.md', fromTemplate('reference'))).toContain('a team bug memory is `type: project`')
    // Team feedback lives at the team root, never in a category.
    expect(check('team/decisions/x.md', fromTemplate('feedback', ['scope: x', 'impact: functional']))).toContain(
      'a team decision memory is `type: project`',
    )
  })

  test('a decision without scope, without impact, or with an impact off the list', () => {
    const decision = (extra: string[]) =>
      check('team/decisions/x.md', fromTemplate('project', extra, DECISION_BODY))
    expect(decision(['impact: structural'])).toContain('it lacks `scope:`')
    expect(decision(['scope: cache'])).toContain('it lacks `impact:` (structural | functional | rejected)')
    expect(decision(['scope: cache', 'impact: huge'])).toContain(
      '`impact: huge` is not one of structural | functional | rejected',
    )
  })

  test('the refusal names the file and appends the rules for memory files', () => {
    const refusal = check('team/decisions/x.md', fromTemplate('project', [], DECISION_BODY))!
    expect(refusal).toStartWith(`Memory file not written: ${TEAM}decisions/x.md is a team decision memory, and`)
    expect(refusal).toContain('Fix the frontmatter and write it again.')
    expect(refusal).toEndWith(`\n\nThe rules for memory files:\n\n${buildMemoryWriteRules(TEAM)}`)
    expect(refusal).toContain('impact: structural | functional | rejected')
  })

  test('without a team dir the refusal names what is missing and nothing more', () => {
    // The private-only system prompt states every rule itself.
    const refusal = checkMemoryFileFormatIn({ autoDir: AUTO, teamDir: null }, `${AUTO}x.md`, 'body\n')
    expect(refusal).toContain('it has no frontmatter')
    expect(refusal).not.toContain('The rules for memory files')
  })
})

describe('checkMemoryFileFormatIn — what it ignores', () => {
  test('the indexes, in either directory', () => {
    for (const rel of ['MEMORY.md', 'team/MEMORY.md']) expect(check(rel, '- [X](x.md) — hook\n')).toBeNull()
  })

  test('a file that is not markdown, or outside both directories', () => {
    expect(check('notes.txt', 'body\n')).toBeNull()
    expect(checkMemoryFileFormatIn(DIRS, '/repo/src/x.md', 'body\n')).toBeNull()
    // A sibling sharing the prefix: the trailing separator keeps it out.
    expect(checkMemoryFileFormatIn(DIRS, '/repo/.claudin/memory-old/x.md', 'body\n')).toBeNull()
  })

  test('a category applies only directly inside its subdirectory of the team dir', () => {
    // Nested one level deeper, or a private dir that happens to be called
    // `decisions`: the frontmatter rules still apply, the decision fields do not.
    expect(check('team/decisions/sub/x.md', fromTemplate('project'))).toBeNull()
    expect(check('team/notes/decisions/x.md', fromTemplate('project'))).toBeNull()
    expect(check('decisions/x.md', fromTemplate('project'))).toBeNull()
    // Without a team dir, the team subtree is private memory.
    expect(
      checkMemoryFileFormatIn({ autoDir: AUTO, teamDir: null }, `${TEAM}decisions/x.md`, fromTemplate('user')),
    ).toBeNull()
  })
})

describe('CATEGORY_FIELDS matches the TEAM_CATEGORIES text', () => {
  test('one entry per category, and every field is stated where the prompts render it', () => {
    expect(Object.keys(CATEGORY_FIELDS).sort()).toEqual(TEAM_CATEGORIES.map(c => c.dir).sort())
    for (const category of TEAM_CATEGORIES) {
      for (const field of CATEGORY_FIELDS[category.dir]) {
        const stated = field.values ? `${field.key}: ${field.values.join(' | ')}` : `${field.key}:`
        expect(category.lean).toContain(stated)
        expect(category.bodyStructure).toContain(stated)
      }
    }
  })
})

describe('memoryIndexAdviceIn', () => {
  const advise = (rel: string, index: string | null) =>
    memoryIndexAdviceIn(DIRS, `${AUTO}${rel}`, () => index)?.message ?? null

  test('a private memory the index does not list, or with no index at all', () => {
    for (const index of [null, '- [Other](other.md) — hook\n']) {
      const note = advise('uses-pnpm.md', index)
      expect(note).toContain('`uses-pnpm.md` is not in the private memory index yet')
      expect(note).toContain(`add \`- [Title](uses-pnpm.md) — one-line hook\``)
      expect(note).toContain(`to \`${AUTO}MEMORY.md\``)
    }
  })

  test('a listed memory gets nothing — plain, `./`, or with an anchor', () => {
    expect(advise('uses-pnpm.md', '- [Uses pnpm](uses-pnpm.md) — never npm\n')).toBeNull()
    expect(advise('uses-pnpm.md', '- [Uses pnpm](./uses-pnpm.md) — never npm\n')).toBeNull()
    expect(advise('uses-pnpm.md', '- [Uses pnpm](uses-pnpm.md#why) — never npm\n')).toBeNull()
  })

  test('a link whose name merely ends the same way does not count', () => {
    expect(advise('pnpm.md', '- [Uses pnpm](uses-pnpm.md) — never npm\n')).not.toBeNull()
  })

  test('a team category memory is linked with its subdirectory, under its section', () => {
    const note = advise('team/decisions/drop-cache.md', '## Decisions\n- [Other](decisions/other.md) — x\n')
    expect(note).toContain('`decisions/drop-cache.md` is not in the team memory index yet')
    expect(note).toContain(`under the \`## Decisions\` section of \`${TEAM}MEMORY.md\``)
    expect(advise('team/decisions/drop-cache.md', '- [Drop](decisions/drop-cache.md) — x\n')).toBeNull()
    // The same name at the team root is another file.
    expect(advise('team/decisions/drop-cache.md', '- [Drop](drop-cache.md) — x\n')).not.toBeNull()
  })

  test('each directory is judged by its own index', () => {
    const seen: string[] = []
    const record = (path: string) => {
      seen.push(path)
      return null
    }
    memoryIndexAdviceIn(DIRS, `${TEAM}x.md`, record)
    memoryIndexAdviceIn(DIRS, `${AUTO}x.md`, record)
    expect(seen).toEqual([`${TEAM}MEMORY.md`, `${AUTO}MEMORY.md`])
  })

  test('an index or a file outside memory gets nothing', () => {
    expect(advise('MEMORY.md', null)).toBeNull()
    expect(memoryIndexAdviceIn(DIRS, '/repo/src/x.md', () => null)).toBeNull()
  })
})

describe('the wrappers, on the private dir', () => {
  const probe = () => join(getAutoMemPath(), 'memory-format-guard-probe.md')

  test('a malformed write is refused, a complete one is not, and a file outside memory is not looked at', () => {
    expect(checkMemoryFileFormat(probe(), 'no frontmatter\n')).toContain('it has no frontmatter')
    expect(checkMemoryFileFormat(probe(), fromTemplate('feedback'))).toBeNull()
    expect(checkMemoryFileFormat(join(getAutoMemPath(), 'MEMORY.md'), 'anything\n')).toBeNull()
    expect(checkMemoryFileFormat('/repo/src/notes.md', 'no frontmatter\n')).toBeNull()
  })

  test('the advice reads the index on disk, and a line the call adds to it', () => {
    const index = join(getAutoMemPath(), 'MEMORY.md')
    expect(memoryIndexAdvice(probe())?.message).toContain('memory-format-guard-probe.md')
    const pending = new Map([[index, '- [Probe](memory-format-guard-probe.md) — hook']])
    expect(memoryIndexAdvice(probe(), pending)).toBeNull()
  })
})

function addPatch(path: string, content: string, ...more: string[]): string {
  const added = content.replace(/\n$/, '').split('\n').map(line => `+${line}`)
  return ['*** Begin Patch', `*** Add File: ${path}`, ...added, ...more, '*** End Patch'].join('\n')
}

describe("the Patch tool's advice (applyPatchMemoryIndexAdvice)", () => {
  const probe = () => join(getAutoMemPath(), 'memory-format-guard-probe.md')
  const indexHunk = () => [
    `*** Update File: ${join(getAutoMemPath(), 'MEMORY.md')}`,
    '@@',
    '+- [Probe](memory-format-guard-probe.md) — hook',
  ]

  test('a memory the patch adds without its index line gets the note', () => {
    const advice = applyPatchMemoryIndexAdvice({ patchText: addPatch(probe(), fromTemplate('feedback')) })
    expect(advice?.message).toContain('`memory-format-guard-probe.md` is not in the private memory index yet')
  })

  test('the index line in the same patch counts', () => {
    const patchText = addPatch(probe(), fromTemplate('feedback'), ...indexHunk())
    expect(applyPatchMemoryIndexAdvice({ patchText })).toBeNull()
  })

  test('an Add the guard will refuse gets no note: its refusal carries the rules', () => {
    expect(applyPatchMemoryIndexAdvice({ patchText: addPatch(probe(), 'no frontmatter\n') })).toBeNull()
  })

  test('a patch that touches no memory file gets nothing', () => {
    expect(applyPatchMemoryIndexAdvice({ patchText: addPatch('/repo/src/a.ts', 'export const a = 1\n') })).toBeNull()
  })
})

describe('the write paths consult the guard', () => {
  // Pinned on the source: the tools' validateInput and staging need a whole
  // ToolUseContext, and every one of these sits beside checkTeamMemSecrets.
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  test('Write, Edit (creating a file), Patch (add, update, move) and the staged rewrite', () => {
    const write = source('../../tools/FileWriteTool/FileWriteTool.ts')
    expect(write).toContain('checkMemoryFileFormat(fullFilePath, content)')
    expect(write).toContain('return memoryIndexAdvice(expandPath(file_path))')

    const edit = source('../../tools/FileEditTool/FileEditTool.ts')
    expect(edit).toContain('const formatError = checkMemoryFileFormat(fullFilePath, content)')
    expect(edit.split('return createFileVerdict(fullFilePath, new_string)')).toHaveLength(3)

    const patch = source('../../tools/ApplyPatchTool/applyPatch.ts')
    expect(patch).toContain('const formatError = checkMemoryFileFormat(absPath, newContent)')
    expect(patch).toContain('const formatError = checkMemoryFileFormat(movePath ?? absPath, text)')
    expect(source('../../tools/ApplyPatchTool/ApplyPatchTool.ts')).toContain(
      'return applyPatchMemoryIndexAdvice(input)',
    )

    expect(source('../../tools/shared/stagedWrite/stagedWrite.ts')).toContain(
      'const formatError = checkMemoryFileFormat(absPath, newContent)',
    )
  })
})
