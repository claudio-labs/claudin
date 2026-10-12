import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { countSkillInvocations } from 'src/skills/skillUsageCensus.js'

function skillCall(id: string, skill: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Loading it.' },
        { type: 'tool_use', id, name: 'Skill', input: { skill, args: 'x' } },
      ],
    },
  })
}

function typedCommand(uuid: string, name: string, timestamp: string, asBlock = false): string {
  const text = `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp,
    message: { role: 'user', content: asBlock ? [{ type: 'text', text }] : text },
  })
}

/** A tool result that merely quotes both shapes — the census must not count it. */
const QUOTING_TOOL_RESULT = JSON.stringify({
  type: 'user',
  uuid: 'u-quote',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'x',
        content: '{"name":"Skill","input":{"skill":"review"}} and <command-message>review</command-message>',
      },
    ],
  },
})

const NOW = Date.now()
const RECENT = new Date(NOW - 60_000).toISOString()
const EARLIER = new Date(NOW - 3_600_000).toISOString()

function makeTranscripts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skillcensus-'))
  writeFileSync(
    join(dir, 'aaaa.jsonl'),
    [
      skillCall('t1', 'deploy', EARLIER),
      // A resumed session re-records history: the same block counts once.
      skillCall('t1', 'deploy', EARLIER),
      skillCall('t3', '/lint', RECENT),
      typedCommand('u1', 'deploy', RECENT),
      typedCommand('u2', 'ship', RECENT, true),
      typedCommand('u2', 'ship', RECENT, true),
      QUOTING_TOOL_RESULT,
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill"', // torn
    ].join('\n'),
  )
  mkdirSync(join(dir, 'aaaa', 'subagents'), { recursive: true })
  writeFileSync(join(dir, 'aaaa', 'subagents', 'agent-1.jsonl'), skillCall('t2', 'deploy', RECENT))

  const old = join(dir, 'bbbb.jsonl')
  writeFileSync(old, skillCall('t9', 'old', EARLIER))
  const longAgo = (NOW - 90 * 86_400_000) / 1000
  utimesSync(old, longAgo, longAgo)
  return dir
}

describe('countSkillInvocations', () => {
  test('counts model and user invocations apart, sub-agents included', async () => {
    const census = await countSkillInvocations({
      transcriptDir: makeTranscripts(),
      sinceMs: NOW - 30 * 86_400_000,
    })
    expect(Object.fromEntries(census.bySkill)).toEqual({
      deploy: { model: 2, user: 1, lastAt: Date.parse(RECENT) },
      lint: { model: 1, user: 0, lastAt: Date.parse(RECENT) },
      ship: { model: 0, user: 1, lastAt: Date.parse(RECENT) },
    })
    expect(census.sessionsScanned).toBe(1)
    expect(census.filesScanned).toBe(2)
  })

  test('a transcript older than the window is not read', async () => {
    const census = await countSkillInvocations({
      transcriptDir: makeTranscripts(),
      sinceMs: NOW - 30 * 86_400_000,
    })
    expect(census.bySkill.has('old')).toBe(false)

    const wide = await countSkillInvocations({
      transcriptDir: makeTranscripts(),
      sinceMs: NOW - 120 * 86_400_000,
    })
    expect(wide.bySkill.get('old')).toMatchObject({ model: 1 })
    expect(wide.sessionsScanned).toBe(2)
  })

  test('a missing transcript directory is an empty census', async () => {
    const census = await countSkillInvocations({
      transcriptDir: join(tmpdir(), 'skillcensus-does-not-exist'),
      sinceMs: 0,
    })
    expect(census).toEqual({ bySkill: new Map(), sessionsScanned: 0, filesScanned: 0 })
  })
})
