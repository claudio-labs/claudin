/**
 * The memory format guard: what it refuses, what it lets through — the shapes
 * the extraction and dream forks write included — and the index-line advice.
 *
 * The pure halves take the directories as arguments and carry most of it.
 * The wrappers resolve the session's private and team dirs, and are asserted
 * on both. The call sites are pinned on the source.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CATEGORY_FIELDS,
  checkMemoryFileFormat,
  checkMemoryFileFormatIn,
  indexTextFromResponse,
  memoryIndexAdvice,
  memoryIndexAdviceIn,
  type MemoryDirs,
} from 'src/memory/memdir/memoryFormatGuard.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_TYPES,
  type MemoryType,
  TEAM_CATEGORIES,
  TYPE_SCOPES,
} from 'src/memory/memdir/memoryTypes.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'
import { getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { buildMemoryWriteRules } from 'src/memory/memdir/teamMemPrompts.js'
import { applyPatchMemoryIndexAdvice } from 'src/tools/ApplyPatchTool/applyPatch.js'

const AUTO = '/repo/.claudin/memory/'
const TEAM = '/repo/.claudin/memory/team/'
const DIRS: MemoryDirs = testMemoryDirs({ private: AUTO, team: TEAM })
const GLOBAL = '/home/u/.claudin/memory/'
const GDIRS: MemoryDirs = testMemoryDirs({ private: AUTO, team: TEAM, global: GLOBAL })

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
      expect(refusal).toContain(`\`type: user\` is ${TYPE_SCOPES.user.withoutGlobal} — write it under \`${AUTO}\` instead`)
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
})

describe('checkMemoryFileFormatIn — the global dir', () => {
  const inGlobal = (rel: string, content: string) => checkMemoryFileFormatIn(GDIRS, `${GLOBAL}${rel}`, content)
  const inPrivate = (rel: string, content: string) => checkMemoryFileFormatIn(GDIRS, `${AUTO}${rel}`, content)

  test('takes who the user is, feedback and a reference, as the template writes them', () => {
    for (const type of ['user', 'feedback', 'reference'] as const) {
      expect(inGlobal(`${type}-x.md`, fromTemplate(type))).toBeNull()
    }
  })

  test('refuses a project memory, naming where it goes instead', () => {
    const refusal = inGlobal('project-x.md', fromTemplate('project'))!
    expect(refusal).toStartWith(`Memory file not written: ${GLOBAL}project-x.md is a global memory, and`)
    expect(refusal).toContain(`\`type: project\` is ${TYPE_SCOPES.project.withGlobal} — write it under \`${AUTO}\` or \`${TEAM}\` instead`)
    // The rules it carries say what the global dir takes, in TYPE_SCOPES' words.
    expect(refusal).toEndWith(`\n\nThe rules for memory files:\n\n${buildMemoryWriteRules(TEAM, GLOBAL)}`)
    expect(refusal).toContain(`The global dir \`${GLOBAL}\` takes \`user\` (${TYPE_SCOPES.user.withGlobal})`)
    for (const type of MEMORY_TYPES.filter(t => TYPE_SCOPES[t].global !== 'never')) {
      expect(refusal).toContain(`\`${type}\` (${TYPE_SCOPES[type].withGlobal})`)
    }
    expect(refusal).toContain('; never `project`, and its memories carry no `paths:`.')
  })

  test('refuses `paths:` — a global memory is not tied to one project', () => {
    expect(inGlobal('feedback-x.md', fromTemplate('feedback', ['paths:', '  - "src/**"']))).toContain(
      'a global memory takes no `paths:`',
    )
  })

  test('a user memory written to the private or team dir is sent to the global one', () => {
    for (const rel of ['me.md', 'team/me.md']) {
      const refusal = inPrivate(rel, fromTemplate('user'))!
      expect(refusal).toContain(`\`type: user\` is ${TYPE_SCOPES.user.withGlobal} — write it under \`${GLOBAL}\` instead`)
      // A file saved here before the global dir existed: move it, or let /memory sort.
      expect(refusal).toContain('move it there with `mv` and move its index line')
      expect(refusal).toContain('`/memory sort` moves them all')
    }
  })

  // Generic over TYPE_SCOPES: whatever type the table marks `never` for the
  // global dir is refused there, whatever it marks `only` is refused outside
  // it — so a new type, or a type that changes its scope, is covered here
  // without a new test.
  test("a type whose TYPE_SCOPES.global is 'never' is refused in the global dir", () => {
    const never = MEMORY_TYPES.filter(type => TYPE_SCOPES[type].global === 'never')
    expect(never.length).toBeGreaterThan(0)
    for (const type of never) {
      const refusal = inGlobal(`${type}-x.md`, fromTemplate(type))
      expect(refusal).toContain(`\`type: ${type}\` is ${TYPE_SCOPES[type].withGlobal}`)
      expect(inPrivate(`${type}-x.md`, fromTemplate(type))).toBeNull()
    }
  })

  test("a type whose TYPE_SCOPES.global is 'only' is refused outside the global dir, quoting withGlobal", () => {
    const only = MEMORY_TYPES.filter(type => TYPE_SCOPES[type].global === 'only')
    expect(only.length).toBeGreaterThan(0)
    for (const type of only) {
      for (const rel of [`${type}-x.md`, `team/${type}-x.md`]) {
        const refusal = inPrivate(rel, fromTemplate(type))
        expect(refusal).toContain(`\`type: ${type}\` is ${TYPE_SCOPES[type].withGlobal} — write it under \`${GLOBAL}\``)
      }
      expect(inGlobal(`${type}-x.md`, fromTemplate(type))).toBeNull()
      // While the global dir is off, the private dir takes it.
      expect(checkMemoryFileFormatIn(DIRS, `${AUTO}${type}-x.md`, fromTemplate(type))).toBeNull()
    }
  })

  test("a type whose TYPE_SCOPES.global is 'allowed' goes in the global or the private dir", () => {
    for (const type of MEMORY_TYPES.filter(t => TYPE_SCOPES[t].global === 'allowed')) {
      expect(inGlobal(`${type}-x.md`, fromTemplate(type))).toBeNull()
      expect(inPrivate(`${type}-x.md`, fromTemplate(type))).toBeNull()
    }
  })

  test('without a global dir a user memory is private, as before', () => {
    expect(checkMemoryFileFormatIn(DIRS, `${AUTO}me.md`, fromTemplate('user'))).toBeNull()
  })

  test('the index advice points at the global index', () => {
    const note = memoryIndexAdviceIn(GDIRS, `${GLOBAL}user-language.md`, () => null)?.message
    expect(note).toContain('`user-language.md` is not in the global memory index yet')
    expect(note).toContain(`to \`${GLOBAL}MEMORY.md\``)
  })
})

// Placement is judged when a file is new or changes its type; completeness
// on every write. `existing` is the file on disk — null when the write
// creates it.
describe('checkMemoryFileFormatIn — a file already on disk', () => {
  const update = (path: string, before: string | null, after: string) =>
    checkMemoryFileFormatIn(GDIRS, path, after, () => before)

  test('a legacy private `type: user` file is updated in place; a new one is sent to the global dir', () => {
    const legacy = fromTemplate('user')
    expect(update(`${AUTO}me.md`, legacy, legacy.replace('Never use', 'Never ever use'))).toBeNull()
    expect(update(`${AUTO}team/me.md`, legacy, `${legacy}More.\n`)).toBeNull()
    expect(update(`${AUTO}me.md`, null, legacy)).toContain(`write it under \`${GLOBAL}\``)
  })

  test('a retype is placed by the table: to `user` outside the global dir, to `project` inside it', () => {
    expect(update(`${AUTO}x.md`, fromTemplate('feedback'), fromTemplate('user'))).toContain(`write it under \`${GLOBAL}\``)
    expect(update(`${GLOBAL}x.md`, fromTemplate('feedback'), fromTemplate('project'))).toContain(
      `\`type: project\` is ${TYPE_SCOPES.project.withGlobal}`,
    )
    // An existing file with no type, or none that parses, counts as retyped.
    expect(update(`${GLOBAL}x.md`, 'no frontmatter\n', fromTemplate('project'))).toContain('`type: project` is')
    expect(update(`${GLOBAL}x.md`, '', fromTemplate('project'))).toContain('`type: project` is')
  })

  test('a team category file keeps the type it was saved with', () => {
    const doc = fromTemplate('project', ['paths: src/cache/**'])
    expect(update(`${TEAM}docs/x.md`, doc, `${doc}More.\n`)).toBeNull()
    expect(update(`${TEAM}docs/x.md`, null, doc)).toContain('a team doc memory is `type: reference`')
  })

  test('`paths:` in the global dir: refused when added, kept when it was already there', () => {
    const withPaths = fromTemplate('feedback', ['paths:', '  - "src/**"'])
    expect(update(`${GLOBAL}x.md`, fromTemplate('feedback'), withPaths)).toContain('a global memory takes no `paths:`')
    expect(update(`${GLOBAL}x.md`, withPaths, `${withPaths}More.\n`)).toBeNull()
    // A retype places the file anew, `paths:` included.
    expect(update(`${GLOBAL}x.md`, fromTemplate('reference', ['paths: src/**']), withPaths)).toContain(
      'a global memory takes no `paths:`',
    )
  })

  test('completeness is asked of every write, existing file or not', () => {
    const legacy = fromTemplate('user')
    expect(update(`${AUTO}me.md`, legacy, legacy.replace(/^name: .*\n/m, ''))).toContain('it lacks `name:`')
    expect(update(`${AUTO}me.md`, legacy, 'no frontmatter\n')).toContain('it has no frontmatter')
  })

  test('the file on disk is asked only for a memory file', () => {
    const asked: string[] = []
    const existing = (abs: string) => {
      asked.push(abs)
      return null
    }
    checkMemoryFileFormatIn(GDIRS, '/repo/src/x.md', 'x', existing)
    checkMemoryFileFormatIn(GDIRS, `${AUTO}MEMORY.md`, 'x', existing)
    checkMemoryFileFormatIn(GDIRS, `${AUTO}x.md`, fromTemplate('feedback'), existing)
    expect(asked).toEqual([`${AUTO}x.md`])
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

describe('the wrappers, on the session dirs', () => {
  const probe = () => join(getPrivateMemPath(), 'memory-format-guard-probe.md')

  test('a malformed write is refused, a complete one is not, and a file outside memory is not looked at', () => {
    expect(checkMemoryFileFormat(probe(), 'no frontmatter\n')).toContain('it has no frontmatter')
    expect(checkMemoryFileFormat(probe(), fromTemplate('feedback'))).toBeNull()
    expect(checkMemoryFileFormat(join(getPrivateMemPath(), 'MEMORY.md'), 'anything\n')).toBeNull()
    expect(checkMemoryFileFormat('/repo/src/notes.md', 'no frontmatter\n')).toBeNull()
  })

  test('a team path is judged as team memory, and the refusal carries the rules', () => {
    const decision = join(getTeamMemPath(), 'decisions', 'memory-format-guard-probe.md')
    const refusal = checkMemoryFileFormat(decision, fromTemplate('project', [], DECISION_BODY))
    expect(refusal).toContain('is a team decision memory, and it lacks `scope:`')
    expect(refusal).toContain('\n\nThe rules for memory files:\n\n')
  })

  test('the advice reads the index on disk, and a line the call adds to it', () => {
    const index = join(getPrivateMemPath(), 'MEMORY.md')
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
  const probe = () => join(getPrivateMemPath(), 'memory-format-guard-probe.md')
  const indexHunk = () => [
    `*** Update File: ${join(getPrivateMemPath(), 'MEMORY.md')}`,
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

  test("a Write of the index beside the patch counts: it runs after the patch's advice", () => {
    const patchText = addPatch(probe(), fromTemplate('feedback'))
    const sibling = {
      input: { file_path: join(getPrivateMemPath(), 'MEMORY.md'), content: '- [Probe](memory-format-guard-probe.md) — hook\n' },
    }
    expect(applyPatchMemoryIndexAdvice({ patchText }, [{ input: { patchText } }, sibling] as never)).toBeNull()
  })
})

// advise runs before the calls after it: a memory file and its index line
// written side by side in one response are only both on disk once the
// response has run (the 2026-09-29 memory-write check: every session wrote
// them in one response, and the note fired anyway until this counted).
describe('the rest of the response (indexTextFromResponse)', () => {
  const INDEX = `${AUTO}MEMORY.md`
  const LINE = '- [Uses pnpm](uses-pnpm.md) — never npm'

  test('reads a Write, an Edit and the lines a Patch adds to an index, by shape', () => {
    const patch = ['*** Begin Patch', `*** Update File: ${TEAM}MEMORY.md`, '@@', ' ## Decisions', '+- [Drop](decisions/drop.md) — x', '*** End Patch'].join('\n')
    const pending = indexTextFromResponse(
      [
        { input: { file_path: INDEX, content: `${LINE}\n` } },
        { input: { file_path: INDEX, old_string: 'a', new_string: '- [B](b.md) — y' } },
        { input: { patchText: patch } },
      ],
      '/',
    )
    expect(pending.get(INDEX)).toContain(LINE)
    expect(pending.get(INDEX)).toContain('- [B](b.md) — y')
    expect(pending.get(`${TEAM}MEMORY.md`)).toContain('- [Drop](decisions/drop.md) — x')
    expect(pending.get(`${TEAM}MEMORY.md`)).not.toContain('## Decisions')
  })

  test('ignores what is not an index, a deleted file, and a call with no text', () => {
    const patch = ['*** Begin Patch', `*** Delete File: ${INDEX}`, `*** Add File: ${AUTO}uses-pnpm.md`, '+---', '*** End Patch'].join('\n')
    const pending = indexTextFromResponse(
      [
        { input: { file_path: `${AUTO}uses-pnpm.md`, content: LINE } },
        { input: { patchText: patch } },
        { input: { command: `echo '${LINE}' >> ${INDEX}` } },
        { input: null },
      ],
      '/',
    )
    expect([...pending.keys()]).toEqual([])
  })

  test("a Patch's relative index path resolves against the working directory", () => {
    const patch = ['*** Begin Patch', '*** Add File: .claudin/memory/MEMORY.md', `+${LINE}`, '*** End Patch'].join('\n')
    expect([...indexTextFromResponse([{ input: { patchText: patch } }], '/repo').keys()]).toEqual([INDEX])
  })

  test('the lines of a section moved onto an index count for that index', () => {
    const patch = ['*** Begin Patch', `*** Update File: ${AUTO}draft.md`, `*** Move to: ${INDEX}`, '@@', `+${LINE}`, '*** End Patch'].join('\n')
    expect(indexTextFromResponse([{ input: { patchText: patch } }], '/').get(INDEX)).toContain(LINE)
  })

  test('the Write advice counts an index line the same response writes', () => {
    const memory = join(getPrivateMemPath(), 'memory-format-guard-probe.md')
    const index = join(getPrivateMemPath(), 'MEMORY.md')
    const response = [
      { input: { file_path: memory, content: fromTemplate('feedback') } },
      { input: { file_path: index, content: '- [Probe](memory-format-guard-probe.md) — hook\n' } },
    ]
    expect(memoryIndexAdvice(memory, indexTextFromResponse(response, '/'))).toBeNull()
    // The same index written for another file does not count.
    const other = [response[0]!, { input: { file_path: index, content: '- [Other](other.md) — x\n' } }]
    expect(memoryIndexAdvice(memory, indexTextFromResponse(other, '/'))?.message).toContain('memory-format-guard-probe.md')
  })
})

describe('the write paths consult the guard', () => {
  // Pinned on the source: the tools' validateInput and staging need a whole
  // ToolUseContext, and every one of these sits beside checkTeamMemSecrets.
  // FileEditTool.memoryGuard.test.ts drives them for real.
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  test('Write, Edit (creating or changing a file), Patch (add, update, move) and the staged rewrite', () => {
    const write = source('../../tools/FileWriteTool/FileWriteTool.ts')
    expect(write).toContain('checkMemoryFileFormat(fullFilePath, content)')
    expect(write).toContain('indexTextFromResponse(context.responseToolUses, getCwd())')

    const edit = source('../../tools/FileEditTool/FileEditTool.ts')
    expect(edit).toContain('const formatError = checkMemoryFileFormat(fullFilePath, content)')
    expect(edit.split('return memoryFormatVerdict(fullFilePath, new_string)')).toHaveLength(3)
    expect(edit).toContain('const verdict = memoryFormatVerdict(\n      fullFilePath,\n      applyEditToFile(')
    expect(edit).toContain('indexTextFromResponse(context.responseToolUses, getCwd())')

    const patch = source('../../tools/ApplyPatchTool/applyPatch.ts')
    expect(patch).toContain('const formatError = checkMemoryFileFormat(absPath, newContent)')
    expect(patch).toContain('const formatError = checkMemoryFileFormat(movePath ?? absPath, text)')
    expect(source('../../tools/ApplyPatchTool/ApplyPatchTool.ts')).toContain(
      'return applyPatchMemoryIndexAdvice(input, context.responseToolUses)',
    )

    expect(source('../../tools/shared/stagedWrite/stagedWrite.ts')).toContain(
      'const formatError = checkMemoryFileFormat(absPath, newContent)',
    )
  })
})
