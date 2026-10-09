import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import {
  createAutoMemCanUseTool,
  existingMemoryManifest,
  hasMemoryWritesSince,
} from 'src/memory/extract/extractMemories.js'
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

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'extract-global-'))
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    setProjectRoot(join(root, 'project'))
    getAutoMemPath.cache.clear?.()
    memDir = getAutoMemPath()
    globalDir = getGlobalMemPath()
    mkdirSync(globalDir, { recursive: true })
  })

  beforeEach(() => {
    delete process.env.CLAUDIN_GLOBAL_MEMORY
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    getAutoMemPath.cache.clear?.()
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  // The gate reads only the tool and its input.
  const decide = async (filePath: string) =>
    createAutoMemCanUseTool(memDir)(WRITE_TOOL, { file_path: filePath }, null as never, null as never, 'toolu_1')

  test('a fork may write the private and the global dir, nothing else', async () => {
    expect((await decide(join(memDir, 'x.md'))).behavior).toBe('allow')
    expect((await decide(join(globalDir, 'user-language.md'))).behavior).toBe('allow')
    const denied = await decide(join(root, 'project', 'src', 'x.ts'))
    expect(denied.behavior).toBe('deny')
    expect((denied as { message: string }).message).toContain(`within ${memDir} or ${globalDir}`)
  })

  test('with the global dir off, a fork may not write it', async () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    const denied = await decide(join(globalDir, 'user-language.md'))
    expect(denied.behavior).toBe('deny')
    expect((denied as { message: string }).message).toContain(`within ${memDir} are allowed`)
  })

  test('a global memory the main agent wrote makes the extraction skip the range', () => {
    expect(hasMemoryWritesSince([writeMessage(join(globalDir, 'user-language.md'))], undefined)).toBe(true)
    expect(hasMemoryWritesSince([writeMessage(join(memDir, 'x.md'))], undefined)).toBe(true)
    expect(hasMemoryWritesSince([writeMessage(join(root, 'project', 'x.md'))], undefined)).toBe(false)
  })

  test('the manifest lists each directory under its own name', async () => {
    writeFileSync(join(memDir, 'project-pnpm.md'), '---\nname: pnpm\ndescription: this repo uses pnpm\ntype: project\n---\nx\n')
    writeFileSync(join(globalDir, 'user-language.md'), '---\nname: lang\ndescription: answers in pt-BR\ntype: user\n---\nx\n')

    const manifest = await existingMemoryManifest(memDir, globalDir)
    const lines = manifest.split('\n')
    expect(lines[0]).toBe(`In \`${memDir}\`:`)
    expect(manifest).toContain('[project] project-pnpm.md')
    expect(manifest).toContain(`In the global dir \`${globalDir}\`:`)
    expect(manifest.indexOf('[user] user-language.md')).toBeGreaterThan(manifest.indexOf('In the global dir'))

    // Without the global dir, the manifest is the one that always shipped.
    const own = await existingMemoryManifest(memDir, null)
    expect(own).not.toContain('In ')
    expect(own).toContain('[project] project-pnpm.md')
  })
})
