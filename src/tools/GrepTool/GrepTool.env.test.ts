import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'

// The Read gate asks before a .env, but Grep prints file CONTENT and checks
// only its search root: a recursive search, the --no-ignore fallback or a glob
// naming a .env printed the secret without a word.
const SECRET = 'sk-grep-env-secret'
let root: string
const globals = globalThis as unknown as { MACRO?: { VERSION: string } }
const priorMacro = globals.MACRO

beforeAll(() => {
  globals.MACRO = { ...priorMacro, VERSION: priorMacro?.VERSION ?? 'test' }
  root = mkdtempSync(join(tmpdir(), 'grep-env-'))
  writeFileSync(join(root, '.env'), `OPENAI_API_KEY=${SECRET}\n`)
  writeFileSync(join(root, 'prod.env'), `OPENAI_API_KEY=${SECRET}\n`)
  writeFileSync(join(root, 'app.ts'), 'export const OPENAI_API_KEY = process.env.OPENAI_API_KEY\n')
  // A repo whose .gitignore hides its .env: the first search finds nothing,
  // so Grep retries with --no-ignore.
  mkdirSync(join(root, 'repo', '.git'), { recursive: true })
  writeFileSync(join(root, 'repo', '.gitignore'), '.env\n')
  writeFileSync(join(root, 'repo', '.env'), `OPENAI_API_KEY=${SECRET}\n`)
})

afterAll(() => {
  if (priorMacro === undefined) delete globals.MACRO
  else globals.MACRO = priorMacro
  rmSync(root, { recursive: true, force: true })
})

function context(): ToolUseContext {
  const toolPermissionContext = {
    mode: 'default' as const,
    additionalWorkingDirectories: new Map([[root, { path: root, source: 'session' as const }]]),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

async function grep(input: Record<string, unknown>): Promise<string> {
  const { data } = await runWithCwdOverride(root, () =>
    GrepTool.call({ pattern: 'OPENAI_API_KEY', output_mode: 'content', ...input } as never, context()),
  )
  return (data as { content?: string }).content ?? ''
}

describe('Grep and .env files', () => {
  test('a Grep rooted at a .env asks (control)', async () => {
    const decision = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions({ pattern: 'x', path: join(root, '.env') } as never, context()),
    )
    expect(decision.behavior).toBe('ask')
  })

  test('a glob that names a .env asks', async () => {
    for (const glob of ['.env', '*.env', '.env*']) {
      const decision = await runWithCwdOverride(root, () =>
        GrepTool.checkPermissions({ pattern: 'x', path: root, glob } as never, context()),
      )
      expect([glob, decision.behavior]).toEqual([glob, 'ask'])
    }
  })

  test('a recursive search does not print a .env', async () => {
    const content = await grep({ path: root })
    expect(content).toContain('app.ts')
    expect(content).not.toContain(SECRET)
  })

  test('a bare wildcard glob neither asks nor prints a .env', async () => {
    const decision = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions({ pattern: 'x', path: root, glob: '*' } as never, context()),
    )
    expect(decision.behavior).toBe('allow')
    expect(await grep({ path: root, glob: '*' })).not.toContain(SECRET)
  })

  test('the --no-ignore fallback does not print a .env either', async () => {
    const content = await grep({ path: join(root, 'repo'), pattern: SECRET })
    expect(content).not.toContain(SECRET)
  })
})
