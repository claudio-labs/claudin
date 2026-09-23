import { describe, expect, test } from 'bun:test'
import type { CacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import { summaryForkParams } from 'src/agent/summary/agentSummary.js'

describe('summaryForkParams', () => {
  const cacheSafeParams = {} as CacheSafeParams

  test.each(['agent_summary', 'agent_result_summary'] as const)(
    '%s skips the cache write: no later request reads a summary tail',
    forkLabel => {
      const params = summaryForkParams(
        'Describe your most recent action',
        cacheSafeParams,
        forkLabel,
        new AbortController(),
      )
      expect(params.skipCacheWrite).toBe(true)
      expect(params.forkLabel).toBe(forkLabel)
      // Both forks keep the parent's cache key: same params, tools denied by
      // callback rather than removed.
      expect(params.cacheSafeParams).toBe(cacheSafeParams)
      expect(params.skipTranscript).toBe(true)
    },
  )
})
