import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeUsageContribution } from 'src/services/usageContribution/usageContribution.js'

type Rec = { ts: number; input: number; output?: number }

function jsonl(records: Rec[]): string {
  return (
    records
      .map(r =>
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(r.ts).toISOString(),
          message: {
            usage: { input_tokens: r.input, output_tokens: r.output ?? 0 },
          },
        }),
      )
      .join('\n') + '\n'
  )
}

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

describe('computeUsageContribution', () => {
  let configDir: string
  let prevEnv: string | undefined
  const now = Date.now()
  const recent = now - 1_000
  const old = now - 8 * 24 * 60 * 60 * 1000 // 8 days ago — outside week window

  beforeEach(async () => {
    prevEnv = process.env.CLAUDIN_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'claudin-usage-'))
    process.env.CLAUDIN_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = prevEnv
  })

  async function writeSession(
    project: string,
    sessionId: string,
    mainRecords: Rec[],
    subagents: { id: string; agentType: string; records: Rec[] }[] = [],
  ): Promise<void> {
    const projectDir = join(configDir, 'projects', project)
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), jsonl(mainRecords))
    if (subagents.length > 0) {
      const subDir = join(projectDir, sessionId, 'subagents')
      await mkdir(subDir, { recursive: true })
      for (const sub of subagents) {
        await writeFile(join(subDir, `agent-${sub.id}.jsonl`), jsonl(sub.records))
        await writeFile(
          join(subDir, `agent-${sub.id}.meta.json`),
          JSON.stringify({ agentType: sub.agentType }),
        )
      }
    }
  }

  test('returns empty on a fresh config dir with no projects', async () => {
    const res = await computeUsageContribution('day')
    expect(res.totalTokens).toBe(0)
    expect(res.sessionCount).toBe(0)
    expect(res.agentBreakdown).toEqual([])
  })

  test('attributes tokens per agent type and flags subagent-heavy sessions', async () => {
    // Session A: 100 main + 900 fork (+10 Explore) → subagent-heavy.
    await writeSession('-proj-a', UUID_A, [{ ts: recent, input: 100 }], [
      { id: 'aaa', agentType: 'fork', records: [{ ts: recent, input: 900 }] },
      { id: 'bbb', agentType: 'Explore', records: [{ ts: recent, input: 10 }] },
    ])
    // Session B: 400 main, no subagents → not heavy. Plus an out-of-window rec.
    await writeSession('-proj-b', UUID_B, [
      { ts: recent, input: 400 },
      { ts: old, input: 99_999 }, // must be excluded by the window filter
    ])

    const res = await computeUsageContribution('week')

    expect(res.totalTokens).toBe(1410) // 100+900+10 + 400
    expect(res.sessionCount).toBe(2)
    // 1010 of 1410 came from the subagent-heavy session A.
    expect(res.subagentHeavyPct).toBeCloseTo((1010 / 1410) * 100, 5)
    // Explore (10/1410 = 0.7%) is below the 5% floor → only fork survives.
    expect(res.agentBreakdown.map(a => a.agentType)).toEqual(['fork'])
    expect(res.agentBreakdown[0]!.tokens).toBe(900)
    expect(res.agentBreakdown[0]!.pct).toBeCloseTo((900 / 1410) * 100, 5)
  })

  test('excludes records older than the window', async () => {
    await writeSession('-proj-a', UUID_A, [{ ts: old, input: 5_000 }])
    const res = await computeUsageContribution('day')
    // The only record is 8 days old — outside the 24h window.
    expect(res.totalTokens).toBe(0)
    expect(res.sessionCount).toBe(0)
  })

  test('prunes files whose mtime predates the window without reading them', async () => {
    await writeSession('-proj-a', UUID_A, [{ ts: recent, input: 123 }])
    // Backdate the file mtime to before the day window; the cheap mtime prune
    // should skip it even though the record timestamp is recent.
    const p = join(configDir, 'projects', '-proj-a', `${UUID_A}.jsonl`)
    const oldDate = new Date(old)
    await utimes(p, oldDate, oldDate)

    const res = await computeUsageContribution('day')
    expect(res.totalTokens).toBe(0)
  })
})
