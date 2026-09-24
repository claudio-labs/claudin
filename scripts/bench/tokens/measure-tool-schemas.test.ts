import { describe, expect, test } from 'bun:test'

import { getAllBaseTools } from '../../../src/tools/tools.ts'
import type { Tool } from '../../../src/tools/Tool.ts'
import { importWithReadMulti } from '../../../src/tools/FileReadTool/__testutils__/readMultiFlag.ts'
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
    const expected = [
      'description',
      'descriptionBytes',
      'engine',
      'name',
      'schemaBytes',
      'tokens',
    ]
    for (const k of expected) {
      expect(keys.includes(k)).toBe(true)
    }
    expect(typeof sample.name).toBe('string')
    expect(sample.engine).toBe('anthropic')
    expect(typeof sample.description).toBe('string')
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

  test('Read renders on every engine by default and under its killswitch, which is the smaller schema', async () => {
    // The batch Read is on by default; CLAUDIN_READ_MULTI=0 restores the
    // single-file schema. The flag is read once per process, so the killswitch
    // arm is the same bundle with Read's input schema swapped for the one
    // schemas.ts builds under =0 — the description is left as it is, which
    // makes the byte difference the schema's alone.
    const { inputSchema } = await importWithReadMulti<
      typeof import('../../../src/tools/FileReadTool/schemas.ts')
    >('src/tools/FileReadTool/schemas.js', false)
    const tools = getAllBaseTools().map(tool =>
      tool.name === 'Read' ? ({ ...tool, inputSchema: inputSchema() } as Tool) : tool,
    )
    const killswitched = await measureToolSchemas({ tools })
    const byDefault = await measureToolSchemas()
    for (const engine of ['anthropic', 'openai', 'codex'] as const) {
      const off = killswitched.rows.find(r => r.name === 'Read' && r.engine === engine)
      const on = byDefault.rows.find(r => r.name === 'Read' && r.engine === engine)
      expect({ engine, off: off?.error, on: on?.error }).toEqual({ engine, off: undefined, on: undefined })
      expect(on!.descriptionBytes).toBe(off!.descriptionBytes)
      expect(on!.schemaBytes).toBeGreaterThan(off!.schemaBytes)
    }
  })

  test('Patch is registered unconditionally, right after Write', () => {
    // The tool list is part of the cross-user system-prompt cache prefix, so
    // Patch must always be present and in a fixed position. Inserting it
    // immediately after Write keeps the order deterministic.
    const names = getAllBaseTools().map(t => t.name)
    expect(names).toContain('Patch')
    const writeIdx = names.indexOf('Write')
    expect(writeIdx).toBeGreaterThanOrEqual(0)
    expect(names[writeIdx + 1]).toBe('Patch')
  })

  test('Patch tool schema bytes are stable across renders (cache-safe)', async () => {
    // The tools block is the head of the cached request prefix and carries no
    // cache_control of its own — any byte drift in Patch's schema busts
    // the whole downstream cache. Its description is a static constant and its
    // input schema is identity-cached via lazySchema(), so two independent
    // measurements must be byte-identical for every engine.
    const first = await measureToolSchemas({
      engines: ['anthropic', 'openai', 'codex'],
    })
    const second = await measureToolSchemas({
      engines: ['anthropic', 'openai', 'codex'],
    })

    for (const engine of ['anthropic', 'openai', 'codex'] as const) {
      const a = first.rows.find(
        r => r.name === 'Patch' && r.engine === engine,
      )
      const b = second.rows.find(
        r => r.name === 'Patch' && r.engine === engine,
      )
      expect(a, `expected Patch row for engine ${engine}`).toBeDefined()
      expect(a!.schemaBytes).toBeGreaterThan(0)
      expect(b!.schemaBytes).toBe(a!.schemaBytes)
      expect(b!.descriptionBytes).toBe(a!.descriptionBytes)
    }
  })

  test('disabling the bash_git_instructions attachment restores the git-block growth in the schema', async () => {
    // Sanity: with the attachment toggle off, --git-mode=on must once again
    // grow the Bash description vs --git-mode=off. This guards against the
    // attachment path becoming permanent / unrevertable.
    const previous = process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = 'false'
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
        delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
      } else {
        process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = previous
      }
    }
  })

  test('no tool description says the same thing twice', async () => {
    // A merge once left two copies of the Read tool's "1. Unknown file →
    // start with view='outline'" bullet. They diverge only past ~200
    // characters, and at a comma where the other has a period — so neither an
    // equality check nor a prefix check would have caught them, and the list
    // shipped reading 1, 1, 2, 3, 4 in every request until a prompt audit read
    // the file. Read, Grep, Agent and Patch have no snapshot to diff, so
    // nothing else was watching.
    //
    // The shape that does catch it is a shared-prefix ceiling. Among the lines
    // this check actually examines — `substantial`, i.e. longer than the
    // ceiling itself — the longest legitimate pair across all 40 tools shares
    // 22 characters (SendMessage's `{"to": "researcher", …}` examples), so 60
    // clears every real pair by nearly 3x while sitting far under the 200 the
    // bug had. (A previous note cited TaskUpdate at 27; those lines are 38-40
    // chars and never reach this comparison at all.) Raise it if a legitimate
    // pair ever lands above — never silence a case.
    //
    // Known blind spots, measured by trying to defeat it: a duplicate whose
    // copy was reformatted (`1. ` → `- `) shares no prefix, and one whose first
    // words were paraphrased scores 0. It is also per-tool, so the same
    // sentence living in two different tool descriptions is invisible to it —
    // the cross-tool language list this change removed is exactly that case.
    //
    // Limit worth knowing: feature() reads false under `bun test`, so this
    // sees the ungated text plus the flag-OFF shape of the gated text. The bug
    // it is named for lived in the ungated half.
    const MAX_SHARED_PREFIX = 60
    const { rows } = await measureToolSchemas({ engines: ['anthropic'] })
    expect(rows.length).toBeGreaterThan(0)
    // A row that failed to render carries description: '' and would pass every
    // check below vacuously, so refuse the whole run instead.
    expect(rows.filter(row => row.error !== undefined)).toEqual([])

    const offenders: string[] = []
    for (const row of rows) {
      const substantial = row.description
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > MAX_SHARED_PREFIX)
      // Exact repeats are checked at ANY length: the prefix ceiling below
      // cannot see a duplicated short line, which is the cheapest form of the
      // same bug. What legitimately repeats is *syntax*: blank lines, markup
      // (`<example>`, `})`) and Patch's `*** Begin Patch` envelope, which
      // appears once in its format spec and again in its example. So the check
      // is scoped to lines that read as a sentence — five words AND 24 chars,
      // both floors, which together clear the envelope markers. The char floor
      // is not redundant with the word one: `- do not re-read a file` is six
      // words in 23 chars and is the kind of fragment that repeats innocently.
      const seen = new Set<string>()
      for (const line of row.description.split('\n').map(l => l.trim())) {
        if (line.split(/\s+/).length < 5 || line.length < 24) continue
        if (seen.has(line)) {
          offenders.push(`${row.name}: exact repeat — ${line.slice(0, 80)}…`)
        }
        seen.add(line)
      }
      for (let i = 0; i < substantial.length; i++) {
        for (let j = i + 1; j < substantial.length; j++) {
          const a = substantial[i]!
          const b = substantial[j]!
          let shared = 0
          while (
            shared < a.length &&
            shared < b.length &&
            a[shared] === b[shared]
          ) {
            shared++
          }
          if (shared > MAX_SHARED_PREFIX) {
            offenders.push(`${row.name}: ${shared} shared chars — ${a.slice(0, 80)}…`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
