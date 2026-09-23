/**
 * Offline check that `--resume` rebuilds the history the live process sent.
 *
 * Renders each recorded session twice, up to the phase-2 prompt: the transcript
 * in write order (what the live process held) and the same bytes through
 * `loadConversationForResume` (what the resumed process rebuilds). Reports the
 * first character where the two API renderings differ. Zero API cost — it found
 * the parallel tool-result ordering bug in src/sessions/resume/chain.ts, which
 * resume-wire-probe.ts cannot see because its session makes one tool call.
 *
 *   RESUME_DIFF_RUN=/tmp/session-cache-ab/<stamp> bun test scripts/bench/ab/resume-transcript-diff.test.ts
 *
 * Reads the claudin arms' `<arm>-r<N>.transcript.jsonl` from a session-cache-ab.ts
 * run dir. Runs as a Bun test so `src/...` imports resolve. A report, not a gate:
 * without RESUME_DIFF_RUN it logs how to use it and passes.
 */
import { test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeMessagesForAPI } from 'src/agent/messages/messages.js'
import { loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import type { Message } from 'src/shared/types/message.js'

const RUN = process.env.RESUME_DIFF_RUN
const PHASE2 = readFileSync(join(import.meta.dir, '__fixtures__', 'session-cache-ab', 'prompts', 'phase2.md'), 'utf8')

function rendered(messages: Message[]): string {
  return JSON.stringify(
    normalizeMessagesForAPI(messages).map(m => ({ role: m.message.role, content: m.message.content })),
  )
}

test('resume rebuilds the recorded history byte for byte', async () => {
  if (!RUN) {
    console.log('set RESUME_DIFF_RUN=<session-cache-ab run dir> to diff its recorded sessions')
    return
  }
  const files = readdirSync(RUN).filter(f => f.endsWith('.transcript.jsonl') && !f.startsWith('claude-'))
  for (const file of files) {
    const lines = readFileSync(join(RUN, file), 'utf8').split('\n').filter(Boolean)
    const entries = lines.map(l => JSON.parse(l) as { type: string; message?: { content?: unknown } })
    const split = entries.findIndex(
      e => e.type === 'user' && typeof e.message?.content === 'string' && PHASE2.startsWith(e.message.content.slice(0, 60)),
    )
    if (split < 0) {
      console.log(`${file}: no phase-2 prompt, skipped`)
      continue
    }
    const live = entries
      .slice(0, split)
      .filter(e => e.type === 'user' || e.type === 'assistant' || e.type === 'attachment') as unknown as Message[]
    const cut = join(mkdtempSync(join(tmpdir(), 'resume-diff-')), 'phase1.jsonl')
    writeFileSync(cut, `${lines.slice(0, split).join('\n')}\n`)
    const resumed = await loadConversationForResume('resume-diff', cut)

    const a = rendered(live)
    const b = rendered(resumed?.messages ?? [])
    if (a === b) {
      console.log(`${file}: identical (${a.length} chars)`)
      continue
    }
    let at = 0
    while (a[at] === b[at]) at++
    console.log(`${file}: differs at char ${at} of ${a.length}`)
    console.log(`  live   : …${a.slice(Math.max(0, at - 120), at + 120)}…`)
    console.log(`  resumed: …${b.slice(Math.max(0, at - 120), at + 120)}…`)
  }
}, 120_000)
