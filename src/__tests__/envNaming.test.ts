// Pins the CLAUDE_* -> CLAUDIN_* env-var cut-over.
//
// The rename was a hard break with no dual read (scripts/env-rename-map.json),
// so a reintroduced old name is not a style slip: it is a knob that silently
// stops working, because nothing reads it any more. This test fails if one
// comes back.
//
// The names that legitimately survive are listed here as an explicit
// allowlist rather than derived from the map, so that keeping an upstream name
// stays a visible decision. Two reasons a name is on it:
//
//   C — inbound contract. Something OUTSIDE this process sets it: the Claude
//       Agent SDK, the IDE extension, a managed/enterprise host, or a parent
//       that hands us a file descriptor. Renaming one breaks the caller, not us.
//   D — dead in this fork. CCR/remote, cowork, internal telemetry, flags that
//       are off. A later round removes the CODE; the name goes with it then.
//
// Adding a name here is allowed — reintroducing one silently is not.

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

const SRC = join(import.meta.dir, '..')
const MAP = JSON.parse(
  readFileSync(join(SRC, '..', 'scripts', 'env-rename-map.json'), 'utf-8'),
) as {
  rename: { from: string; to: string }[]
  writeOnlyOutbound: { from: string; to: string }[]
  keep: { name: string; bucket: string }[]
}

/** Names that keep their upstream spelling on purpose (buckets C and D). */
const ALLOWED = new Set(MAP.keep.map(k => k.name))

/**
 * Every `CLAUDE_*`-shaped token still present under `src/` that the rename map
 * does NOT classify, pinned so the set cannot grow silently. Three kinds live
 * here and they are not equally benign:
 *
 *   1. Module constants that were never env vars — `CLAUDE_OPUS_5_CONFIG`,
 *      `CLAUDE_AI_BASE_URL`, `CLAUDE_FOLDER_PERMISSION_PATTERN`. Out of scope
 *      for the cut-over by design; renaming them would have been a bug.
 *   2. Prefix fragments used for matching — `CLAUDE_CODE_`, `CLAUDE_CODE_USE_`.
 *   3. **Real env vars the map never saw.** The map was built from the names
 *      READ via `process.env`, and these are only ever WRITTEN — into a
 *      subprocess, an MCP server, or a teammate agent's environment. That is
 *      the same blind spot that hid bucket B, and it means the outbound
 *      contract is not fully cut over: `CLAUDE_CODE_AGENT_ID`,
 *      `CLAUDE_CODE_AGENT_NAME`, `CLAUDE_CODE_TEAM_NAME`,
 *      `CLAUDE_CODE_PARENT_SESSION_ID`, `CLAUDE_CODE_MCP_SERVER_NAME`,
 *      `CLAUDE_CODE_MCP_SERVER_URL` and friends are still upstream-spelled.
 *      A follow-up round has to classify them; this list is the worklist.
 *
 * A new entry means someone added a `CLAUDE_*` name after the cut-over —
 * decide which kind it is before adding it here.
 */
const UNCLASSIFIED = new Set([
  'CLAUDE_3_5_HAIKU_CONFIG',
  'CLAUDE_3_5_V2_SONNET_CONFIG',
  'CLAUDE_3_7_SONNET_CONFIG',
  'CLAUDE_AI_AUTHORIZE_URL',
  'CLAUDE_AI_BASE_URL',
  'CLAUDE_AI_INFERENCE_SCOPE',
  'CLAUDE_AI_LOCAL_BASE_URL',
  'CLAUDE_AI_MCP_TIMEOUT_MS',
  'CLAUDE_AI_OAUTH_SCOPES',
  'CLAUDE_AI_ORIGIN',
  'CLAUDE_AI_PROFILE_SCOPE',
  'CLAUDE_AI_STAGING_BASE_URL',
  'CLAUDE_ALIAS_REGEX',
  'CLAUDE_API_KEY',
  'CLAUDE_BRIDGE_',
  'CLAUDE_CODE_',
  'CLAUDE_CODE_20250219_BETA_HEADER',
  'CLAUDE_CODE_AGENT_COLOR',
  'CLAUDE_CODE_AGENT_ID',
  'CLAUDE_CODE_AGENT_NAME',
  'CLAUDE_CODE_DOCS_MAP_URL',
  'CLAUDE_CODE_DUMP_AUTO_MODE',
  'CLAUDE_CODE_FORCE_SANDBOX',
  'CLAUDE_CODE_GITHUB_ANTHROPIC_API',
  'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
  'CLAUDE_CODE_GUIDE_AGENT',
  'CLAUDE_CODE_GUIDE_AGENT_TYPE',
  'CLAUDE_CODE_HOOK_CHAINS_CONFIG_PATH',
  'CLAUDE_CODE_MCP_SERVER_NAME',
  'CLAUDE_CODE_MCP_SERVER_URL',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_PERMISSIONS_SETTING',
  'CLAUDE_CODE_PERMISSIONS_VERSION',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_PS_SHELL_PREFIX',
  'CLAUDE_CODE_SETTINGS_SCHEMA_URL',
  'CLAUDE_CODE_STREAM_CLOSE_TIMEOUT',
  'CLAUDE_CODE_TEAMMATE_COMMAND',
  'CLAUDE_CODE_TEAM_NAME',
  'CLAUDE_CODE_USE_',
  'CLAUDE_CONFIG_DIRECTORIES',
  'CLAUDE_CONTEXT_COLLAPSE',
  'CLAUDE_FABLE_5_CONFIG',
  'CLAUDE_FOLDER_PERMISSION_PATTERN',
  'CLAUDE_HAIKU_4_5_CONFIG',
  'CLAUDE_LATEST_MODEL_IDS',
  'CLAUDE_MD_CONTEXT_KEY',
  'CLAUDE_OPUS_4_1_CONFIG',
  'CLAUDE_OPUS_4_5_CONFIG',
  'CLAUDE_OPUS_4_6_CONFIG',
  'CLAUDE_OPUS_4_7_CONFIG',
  'CLAUDE_OPUS_4_8_CONFIG',
  'CLAUDE_OPUS_4_CONFIG',
  'CLAUDE_OPUS_5_CONFIG',
  'CLAUDE_SOCKET_PREFIX',
  'CLAUDE_SONNET_4_5_CONFIG',
  'CLAUDE_SONNET_4_6_CONFIG',
  'CLAUDE_SONNET_4_CONFIG',
  'CLAUDE_SONNET_5_CONFIG',
])

const RENAMED = new Set([
  ...MAP.rename.map(e => e.from),
  ...MAP.writeOnlyOutbound.map(e => e.from).filter(n => !n.includes('<')),
])

const TOKEN = /\bCLAUDE(?:_CODE)?_[A-Z0-9_]+\b/g

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        walk(full)
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push(full)
      }
    }
  }
  walk(SRC)
  return out
}

describe('env var naming', () => {
  test('no renamed CLAUDE_* name reappears under src/', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      // This test file names the old spellings in its own prose.
      if (file.endsWith('envNaming.test.ts')) continue
      const text = readFileSync(file, 'utf-8')
      if (!text.includes('CLAUDE_')) continue
      for (const token of new Set(text.match(TOKEN) ?? [])) {
        if (RENAMED.has(token)) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${token}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the unclassified CLAUDE_* residue matches the pinned inventory', () => {
    const found = new Set<string>()
    for (const file of sourceFiles()) {
      if (file.endsWith('envNaming.test.ts')) continue
      const text = readFileSync(file, 'utf-8')
      if (!text.includes('CLAUDE_')) continue
      for (const token of text.match(TOKEN) ?? []) {
        if (!ALLOWED.has(token)) found.add(token)
      }
    }
    expect([...found].sort()).toEqual([...UNCLASSIFIED].sort())
  })

  test('the map itself is internally consistent', () => {
    const targets = MAP.rename.map(e => e.to)
    expect(new Set(targets).size).toBe(targets.length)
    for (const e of MAP.rename) {
      expect(e.to.startsWith('CLAUDIN_')).toBe(true)
      expect(ALLOWED.has(e.from)).toBe(false)
    }
  })
})
