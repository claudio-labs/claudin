import { describe, expect, test } from 'bun:test'

import { measureToolSchemas } from './measure-tool-schemas.ts'

describe('measureToolSchemas', () => {
  test('reports a populated tool bundle with sane totals (default = all engines)', async () => {
    const { rows, totalsByEngine } = await measureToolSchemas()

    // Bundle is large; threshold is intentionally permissive so feature-gated
    // tools toggling on/off across environments don't break this gate.
    expect(rows.length).toBeGreaterThanOrEqual(30)
    expect(totalsByEngine.size).toBe(3)
    for (const [, totals] of totalsByEngine) {
      expect(totals.schemaBytes).toBeGreaterThan(0)
      expect(totals.tokens).toBeGreaterThan(0)
    }

    // At least one core tool must be present in the anthropic rows.
    const anthropicNames = new Set(
      rows.filter(r => r.engine === 'anthropic').map(r => r.name),
    )
    expect(anthropicNames.has('Bash') || anthropicNames.has('Read')).toBe(true)
  })

  test('row shape matches the documented contract', async () => {
    const { rows } = await measureToolSchemas({ engines: ['anthropic'] })
    expect(rows.length).toBeGreaterThan(0)

    const sample = rows[0]!
    const keys = Object.keys(sample).sort()
    const expected = ['descriptionBytes', 'engine', 'name', 'schemaBytes', 'tokens']
    for (const k of expected) {
      expect(keys.includes(k)).toBe(true)
    }
    expect(typeof sample.name).toBe('string')
    expect(sample.engine).toBe('anthropic')
    expect(typeof sample.descriptionBytes).toBe('number')
    expect(typeof sample.schemaBytes).toBe('number')
    expect(typeof sample.tokens).toBe('number')
  })

  test('per-engine measurements report bytes > 0 and differ between engines', async () => {
    const anthropic = await measureToolSchemas({ engines: ['anthropic'] })
    const openai = await measureToolSchemas({ engines: ['openai'] })
    const codex = await measureToolSchemas({ engines: ['codex'] })

    const anthropicTotal = anthropic.totalsByEngine.get('anthropic')!.schemaBytes
    const openaiTotal = openai.totalsByEngine.get('openai')!.schemaBytes
    const codexTotal = codex.totalsByEngine.get('codex')!.schemaBytes

    expect(anthropicTotal).toBeGreaterThan(0)
    expect(openaiTotal).toBeGreaterThan(0)
    expect(codexTotal).toBeGreaterThan(0)

    // Engines apply different wrappers / strict-schema rules; totals must
    // diverge at least pairwise. If any two collapse to the same number the
    // shim chain is short-circuiting and we want to know.
    const totals = new Set([anthropicTotal, openaiTotal, codexTotal])
    expect(totals.size).toBe(3)
  })

  test('--git-mode does not affect Bash schema bytes once the git block is delivered via attachment', async () => {
    // After the bash_git_instructions attachment migration, the git block
    // lives outside the tool description regardless of `gitMode`. The script
    // measures the wire payload of the tool schema only, so on/off must
    // agree byte-for-byte. If this test ever fails, either the attachment
    // path regressed (block leaked back into the description) or the script
    // grew a measurement surface beyond the tool schema.
    const onResult = await measureToolSchemas({
      engines: ['anthropic', 'openai', 'codex'],
      gitMode: 'on',
    })
    const offResult = await measureToolSchemas({
      engines: ['anthropic', 'openai', 'codex'],
      gitMode: 'off',
    })

    for (const engine of ['anthropic', 'openai', 'codex'] as const) {
      const onBash = onResult.rows.find(
        r => r.name === 'Bash' && r.engine === engine,
      )
      const offBash = offResult.rows.find(
        r => r.name === 'Bash' && r.engine === engine,
      )
      expect(onBash, `expected Bash row for engine ${engine} (git on)`).toBeDefined()
      expect(offBash, `expected Bash row for engine ${engine} (git off)`).toBeDefined()
      expect(offBash!.schemaBytes).toBe(onBash!.schemaBytes)
    }
  })

  test('disabling the bash_git_instructions attachment restores the git-block growth in the schema', async () => {
    // Sanity: with the attachment toggle off, --git-mode=on must once again
    // grow the Bash description vs --git-mode=off. This guards against the
    // attachment path becoming permanent / unrevertable.
    const previous = process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = 'false'
    try {
      const onResult = await measureToolSchemas({
        engines: ['anthropic', 'openai', 'codex'],
        gitMode: 'on',
      })
      const offResult = await measureToolSchemas({
        engines: ['anthropic', 'openai', 'codex'],
        gitMode: 'off',
      })

      for (const engine of ['anthropic', 'openai', 'codex'] as const) {
        const onBash = onResult.rows.find(
          r => r.name === 'Bash' && r.engine === engine,
        )
        const offBash = offResult.rows.find(
          r => r.name === 'Bash' && r.engine === engine,
        )
        expect(offBash!.schemaBytes).toBeLessThan(onBash!.schemaBytes)
      }
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
      } else {
        process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = previous
      }
    }
  })
})
