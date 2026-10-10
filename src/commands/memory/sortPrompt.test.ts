import { describe, expect, test } from 'bun:test'
import { MEMORY_TYPES, TEAM_CATEGORIES, TYPE_SCOPES } from 'src/memory/memdir/memoryTypes.js'
import { buildMemorySortPrompt } from 'src/commands/memory/sortPrompt.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

const TEAM = testMemoryDirs({ private: '/repo/.claudin/memory/', team: '/repo/.claudin/memory/team/' })
const WITH_GLOBAL = testMemoryDirs({
  private: '/repo/.claudin/memory/',
  team: '/repo/.claudin/memory/team/',
  global: '/home/u/.claudin/memory/',
})

describe('buildMemorySortPrompt', () => {
  const prompt = buildMemorySortPrompt(TEAM)

  test('names the team dir without the trailing separator', () => {
    expect(prompt).toContain('/repo/.claudin/memory/team/MEMORY.md')
    expect(prompt).not.toContain('//MEMORY.md')
    expect(prompt).not.toContain('team//')
  })

  test('renders every category with its bar, from the table', () => {
    for (const category of TEAM_CATEGORIES) {
      expect(prompt).toContain(`<dir>${category.dir}/</dir>`)
      expect(prompt).toContain(category.whenToSave)
      expect(prompt).toContain(category.whenNotToSave)
      expect(prompt).toContain(`## ${category.section}`)
    }
  })

  test('moves go through git mv so the permission prompt is the veto', () => {
    expect(prompt).toContain('`git mv /repo/.claudin/memory/team/<file>.md')
    expect(prompt).toContain('`git mv`, not `mv`')
    expect(prompt).toContain('permission prompt for each move')
  })

  test('is scoped to the team root and idempotent', () => {
    expect(prompt).toContain('Only files directly at the team root move')
    expect(prompt).toContain('never a private memory, never between subdirectories')
    expect(prompt).toContain('A second run over a sorted directory moves nothing')
    expect(prompt).toContain('Never create or delete a memory')
  })

  test('asks for the decisions frontmatter and forbids invented paths', () => {
    expect(prompt).toContain('`decisions/`: `scope:` and `impact:`')
    expect(prompt).toContain('Never invent a path')
  })

  test('keeps the index edit surgical', () => {
    expect(prompt).toContain('`(file.md)` → `(<category>/file.md)`')
    expect(prompt).toContain('Everything else stays byte-for-byte')
  })
})

describe('buildMemorySortPrompt — promoting to the global dir', () => {
  test('without it the team prompt is the one that always shipped', () => {
    expect(buildMemorySortPrompt(TEAM)).not.toContain('global')
    expect(buildMemorySortPrompt(TEAM)).not.toContain('Part 2')
  })

  test('with a global dir it is a second part, with rules of its own', () => {
    const prompt = buildMemorySortPrompt(WITH_GLOBAL)
    expect(prompt).toStartWith(buildMemorySortPrompt(TEAM))
    expect(prompt).toContain('# Part 2 — promote what is about the user to the global memory')
    expect(prompt).toContain('The hard rules above are about the team dir; this part has its own.')
  })

  test('renders where each type goes from TYPE_SCOPES, and mixed files split', () => {
    const prompt = buildMemorySortPrompt(WITH_GLOBAL)
    for (const type of MEMORY_TYPES) {
      expect(prompt).toContain(`- \`${type}\`: ${TYPE_SCOPES[type].withGlobal}.`)
    }
    expect(prompt).toContain('is a split: what holds anywhere goes global, the rest stays')
    expect(prompt).toContain("only the `.md` files directly in it are candidates; never `team/`")
  })

  test('moves go through mv -n, merges through rm, both with the permission prompt as the veto', () => {
    const prompt = buildMemorySortPrompt(WITH_GLOBAL)
    expect(prompt).toContain('`mv -n /repo/.claudin/memory/<file>.md /home/u/.claudin/memory/<file>.md`')
    expect(prompt).not.toContain('`mv /repo/')
    expect(prompt).toContain('permission prompt for each move')
    expect(prompt).toContain('delete the private file with `rm`')
    expect(prompt).toContain('drop a `paths:` key from the moved file')
  })

  test('a name collision is compared, then merged or moved under a new name — never overwritten', () => {
    const prompt = buildMemorySortPrompt(WITH_GLOBAL)
    expect(prompt).toContain('**Name collision**: when `/home/u/.claudin/memory/<file>.md` already exists')
    expect(prompt).toContain('If they hold the same fact, it is a merge')
    expect(prompt).toContain('`mv -n /repo/.claudin/memory/<file>.md /home/u/.claudin/memory/<new-name>.md`')
    expect(prompt).toContain('**Renamed on a collision**')
  })

  test('says which steps the user approves and which are written without a prompt', () => {
    const prompt = buildMemorySortPrompt(WITH_GLOBAL)
    expect(prompt).toContain('Each `mv` and each `rm` goes through a Bash permission prompt')
    expect(prompt).toContain(
      "a split's new global file, the edit that folds a merge into a global memory, the edit that cuts a split's private file down, the dropped `paths:` key and the index edits of Step 4 are all written without a prompt",
    )
    expect(prompt).toContain('**Written without a prompt**: every file you created or edited in either directory')
  })

  test('the team part says the same of its own unprompted writes', () => {
    const prompt = buildMemorySortPrompt(TEAM)
    expect(prompt).toContain('The user approves each `git mv`; nothing else here asks them.')
    expect(prompt).toContain('**Written without a prompt**: every frontmatter key you added')
  })

  test('reads both indexes and edits them surgically', () => {
    const prompt = buildMemorySortPrompt(WITH_GLOBAL)
    expect(prompt).toContain('Read `/repo/.claudin/memory/MEMORY.md` and `/home/u/.claudin/memory/MEMORY.md`')
    expect(prompt).not.toContain('//MEMORY.md')
    expect(prompt).toContain('Everything else in both stays byte-for-byte')
    expect(prompt).toContain('A second run over a sorted directory moves nothing')
  })
})
