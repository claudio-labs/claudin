import { expect, test } from 'bun:test'
import * as summarizer from 'src/agent/tools/toolResultSummarizer.js'

// The barrel is the import path every caller already uses — src/agent/tools/
// toolResultStorage.ts, src/tools/shared/outputFilter/Bash/pipeline.ts, the
// three colocated suites, src/agent/toolResultCodeOutline.test.ts,
// src/agent/toolResultJsonCompression.cacheSafety.test.ts,
// src/agent/context/tokensSaved.test.ts, and two benches
// (scripts/bench/perf/turn-cpu-bench.ts,
// scripts/bench/tokens/grep-summarizer-replay.ts).
//
// After the split into toolResultSummarizer/ siblings, a name dropped from the
// re-export block is invisible to BOTH `bun run build` (the bundler resolves
// what is imported, not what is absent) and to tsc on the barrel itself. Only
// an assertion over the runtime namespace catches it, so this list is the
// contract. Adding a name here is fine; removing one is a breaking change.
test('the barrel re-exports the whole public surface', () => {
  expect(Object.keys(summarizer).sort()).toEqual([
    'TOOL_RESULT_SUMMARY_CLOSING_TAG',
    'TOOL_RESULT_SUMMARY_TAG',
    'collapseDigitTemplates',
    'collapseIdenticalRuns',
    'getLastSummaryDecision',
    'isSummarizedContent',
    'isToolResultCodeOutlineEnabled',
    'isToolResultJsonCompressionEnabled',
    'maybeSummarizeToolResult',
    'resetLastSummaryDecision',
    'summarizeGrepOutput',
  ])
})

test('every re-exported name is callable through the barrel', () => {
  expect(typeof summarizer.maybeSummarizeToolResult).toBe('function')
  expect(typeof summarizer.summarizeGrepOutput).toBe('function')
  expect(typeof summarizer.collapseIdenticalRuns).toBe('function')
  expect(typeof summarizer.collapseDigitTemplates).toBe('function')
  expect(typeof summarizer.isSummarizedContent).toBe('function')
  expect(typeof summarizer.getLastSummaryDecision).toBe('function')
  expect(typeof summarizer.resetLastSummaryDecision).toBe('function')
  expect(typeof summarizer.isToolResultCodeOutlineEnabled).toBe('function')
  expect(typeof summarizer.isToolResultJsonCompressionEnabled).toBe('function')
  expect(summarizer.TOOL_RESULT_SUMMARY_TAG).toBe('<tool-result-summary')
  expect(summarizer.TOOL_RESULT_SUMMARY_CLOSING_TAG).toBe(
    '</tool-result-summary>',
  )
})

// The decision record is shared mutable module state and must live in exactly
// ONE module (decisionRecord.ts). If a sibling ever declared its own copy, the
// accessor the barrel re-exports would read a different variable than the one
// maybeSummarizeToolResult writes — this pins the round trip through the barrel.
test('the decision record reached through the barrel is the one the entry point writes', () => {
  summarizer.resetLastSummaryDecision()
  expect(summarizer.getLastSummaryDecision()).toBeNull()

  const text = 'x'.repeat(200) + '\n'
  summarizer.maybeSummarizeToolResult(
    { type: 'tool_result', tool_use_id: 't', content: text.repeat(200) },
    'Bash',
  )

  const decision = summarizer.getLastSummaryDecision()
  expect(decision).not.toBeNull()
  expect(decision!.toolName).toBe('Bash')
  summarizer.resetLastSummaryDecision()
})
