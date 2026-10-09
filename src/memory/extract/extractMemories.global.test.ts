import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import { withoutTrailingSep } from 'src/memory/memdir/memoryScopes.js'
import {
  createMemoryCanUseTool,
  existingMemoryManifest,
  hasMemoryWritesSince,
} from 'src/memory/extract/extractMemories.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import type { Message } from 'src/shared/types/message.js'
import type { Tool } from 'src/tools/Tool.js'

// The background forks (extraction, dream) write the global memory too: their
// tool gate lets a write through there, the extraction skips a range the main
// agent already saved a global memory in, and its manifest lists what the
// global dir holds. Pinned against a fresh git project and config home.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

const WRITE_TOOL = { name: FILE_WRITE_TOOL_NAME } as unknown as Tool
const EDIT_TOOL = { name: FILE_EDIT_TOOL_NAME } as unknown as Tool

function writeMessage(filePath: string): Message {
  return {
    type: 'assistant',
    uuid: 'a1',
    message: {
      content: [{ type: 'tool_use', name: FILE_WRITE_TOOL_NAME, input: { file_path: filePath } }],
    },
  } as unknown as Message
}

describe('the forks and the global memory', () => {
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let root: string
  let memDir: string
  let globalDir: string
  let teamDir: string

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'extract-global-'))
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    setProjectRoot(join(root, 'project'))
    getAutoMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    memDir = getAutoMemPath()
    globalDir = getGlobalMemPath()
    teamDir = getTeamMemPath()
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(teamDir, { recursive: true })
  })

  beforeEach(() => {
    delete process.env.CLAUDIN_GLOBAL_MEMORY
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    getAutoMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  // The gate reads only the tool and its input (and, for an append-only
  // Write, the file it would replace).
  const gate = (tool: Tool, input: Record<string, unknown>, appendOnly: ('global' | 'private' | 'team')[] = []) =>
    createMemoryCanUseTool(appendOnly)(tool, input, null as never, null as never, 'toolu_1')
  const decide = (filePath: string) => gate(WRITE_TOOL, { file_path: filePath })
  const messageOf = (result: unknown) => (result as { message: string }).message

  test('a fork may write the global, private and team dirs, nothing else', async () => {
    expect((await decide(join(memDir, 'x.md'))).behavior).toBe('allow')
    expect((await decide(join(teamDir, 'x.md'))).behavior).toBe('allow')
    expect((await decide(join(globalDir, 'user-language.md'))).behavior).toBe('allow')
    const denied = await decide(join(root, 'project', 'src', 'x.ts'))
    expect(denied.behavior).toBe('deny')
    const where = [globalDir, memDir, teamDir].map(withoutTrailingSep).join(', ')
    expect(messageOf(denied)).toContain(`within ${where} are allowed`)
  })

  test('with the global dir off, a fork may not write it', async () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    const denied = await decide(join(globalDir, 'user-language.md'))
    expect(denied.behavior).toBe('deny')
    expect(messageOf(denied)).toContain(`within ${[memDir, teamDir].map(withoutTrailingSep).join(', ')} are allowed`)
    expect(messageOf(denied)).not.toContain(withoutTrailingSep(globalDir))
  })

  describe("createMemoryCanUseTool(['global']) — the dream's append-only gate", () => {
    const BODY = '---\nname: lang\ndescription: answers in pt-BR\ntype: user\n---\nAnswer in pt-BR.\n'
    let existing: string

    beforeEach(() => {
      existing = join(globalDir, 'user-existing.md')
      writeFileSync(existing, BODY)
    })

    const edit = (filePath: string, old_string: string, new_string: string) =>
      gate(EDIT_TOOL, { file_path: filePath, old_string, new_string }, ['global'])
    const write = (filePath: string, content: string) =>
      gate(WRITE_TOOL, { file_path: filePath, content }, ['global'])

    test('an Edit that keeps the old text and adds to it is allowed', async () => {
      const result = await edit(existing, 'Answer in pt-BR.', 'Answer in pt-BR.\nAlso in code reviews.')
      expect(result.behavior).toBe('allow')
    })

    test('an Edit that removes or rewrites text is denied, naming the append-only rule', async () => {
      const removing = await edit(existing, 'Answer in pt-BR.\n', '')
      expect(removing.behavior).toBe('deny')
      expect(messageOf(removing)).toContain('the global memory dir is append-only in this run')
      expect((await edit(existing, 'Answer in pt-BR.', 'Answer in English.')).behavior).toBe('deny')
    })

    test('a Write of a new file is allowed', async () => {
      expect((await write(join(globalDir, 'user-new.md'), BODY)).behavior).toBe('allow')
    })

    test('a Write that keeps the existing content and adds is allowed', async () => {
      expect((await write(existing, `${BODY}More.\n`)).behavior).toBe('allow')
      expect((await write(existing, BODY)).behavior).toBe('allow')
    })

    test('a shrinking Write and a rewrite are denied, and the file is untouched', async () => {
      expect((await write(existing, BODY.slice(0, 20))).behavior).toBe('deny')
      expect((await write(existing, BODY.replace('pt-BR', 'English'))).behavior).toBe('deny')
      expect(readFileSync(existing, 'utf8')).toBe(BODY)
    })

    test('private and team writes stay unrestricted', async () => {
      const privateFile = join(memDir, 'feedback-x.md')
      const teamFile = join(teamDir, 'feedback-y.md')
      writeFileSync(privateFile, BODY)
      writeFileSync(teamFile, BODY)
      for (const file of [privateFile, teamFile]) {
        expect((await edit(file, 'Answer in pt-BR.\n', '')).behavior).toBe('allow')
        expect((await write(file, 'x')).behavior).toBe('allow')
      }
    })

    test('without the global scope listed, the global dir is unrestricted too', async () => {
      const result = await gate(EDIT_TOOL, { file_path: existing, old_string: 'Answer in pt-BR.\n', new_string: '' })
      expect(result.behavior).toBe('allow')
    })
  })

  test('a global memory the main agent wrote makes the extraction skip the range', () => {
    expect(hasMemoryWritesSince([writeMessage(join(globalDir, 'user-language.md'))], undefined)).toBe(true)
    expect(hasMemoryWritesSince([writeMessage(join(memDir, 'x.md'))], undefined)).toBe(true)
    expect(hasMemoryWritesSince([writeMessage(join(root, 'project', 'x.md'))], undefined)).toBe(false)
  })

  test('the manifest lists each directory under its own name', async () => {
    writeFileSync(join(memDir, 'project-pnpm.md'), '---\nname: pnpm\ndescription: this repo uses pnpm\ntype: project\n---\nx\n')
    writeFileSync(join(globalDir, 'user-language.md'), '---\nname: lang\ndescription: answers in pt-BR\ntype: user\n---\nx\n')

    const dirs = getMemoryDirs()
    expect(dirs.map(d => d.scope)).toEqual(['global', 'private', 'team'])
    const manifest = await existingMemoryManifest(dirs)
    // Global first (MEMORY_SCOPES order); the team dir is inside the private
    // one, so the private scan covers it and it gets no list of its own.
    expect(manifest.split('\n')[0]).toBe(`In the global dir \`${globalDir}\`:`)
    expect(manifest).toContain(`In the private dir \`${memDir}\`:`)
    expect(manifest).not.toContain('In the team dir')
    expect(manifest).toContain('[project] project-pnpm.md')
    expect(manifest.indexOf('[user] user-language.md')).toBeLessThan(manifest.indexOf('In the private dir'))
    expect(manifest.indexOf('[project] project-pnpm.md')).toBeGreaterThan(manifest.indexOf('In the private dir'))

    // Without the global dir, the manifest is the one that always shipped.
    const own = await existingMemoryManifest(dirs.filter(d => d.scope !== 'global'))
    expect(own).not.toContain('In ')
    expect(own).toContain('[project] project-pnpm.md')
  })
})
