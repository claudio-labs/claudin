import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Guard: the three Anthropic provider SDKs (bedrock/vertex/foundry) must stay
// `external` in scripts/build.ts so they are loaded at runtime from
// node_modules instead of being bundled into a shared chunk. Without this,
// Bun's chunk-deduplication co-mingles all three SDKs into the shared chunk
// pulled by every dynamic-import branch — defeating per-provider isolation
// and forcing pure-Anthropic users to parse bedrock+vertex+foundry code.
//
// See ROADMAP.md item 5.1.
// ---------------------------------------------------------------------------

const distDir = join(__dirname, '..', 'dist', 'chunks')

const SDKS = [
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/vertex-sdk',
  '@anthropic-ai/foundry-sdk',
] as const

const SDK_CLASSES = ['AnthropicBedrock', 'AnthropicVertex', 'AnthropicFoundry']

describe('provider SDKs are external (not bundled)', () => {
  test('build.ts lists all three Anthropic provider SDKs as external', () => {
    const buildSrc = readFileSync(join(__dirname, 'build.ts'), 'utf-8')
    for (const sdk of SDKS) {
      expect(buildSrc).toContain(`'${sdk}'`)
    }
  })

  test.skipIf(!existsSync(distDir))(
    'no chunk contains the SDK class declarations',
    () => {
      const offenders: string[] = []
      for (const file of readdirSync(distDir)) {
        if (!file.endsWith('.mjs')) continue
        const content = readFileSync(join(distDir, file), 'utf-8')
        for (const cls of SDK_CLASSES) {
          // Match the class declaration that the SDKs emit. Bare references
          // (e.g. `import("@anthropic-ai/bedrock-sdk")` or a TS type annotation
          // erased at build time) are fine — only the bundled source is bad.
          if (
            new RegExp(`class\\s+${cls}\\b`).test(content) ||
            new RegExp(`var\\s+${cls}\\s*=\\s*class`).test(content)
          ) {
            offenders.push(`${file}: contains class ${cls}`)
          }
        }
      }
      expect(offenders).toEqual([])
    },
  )
})
