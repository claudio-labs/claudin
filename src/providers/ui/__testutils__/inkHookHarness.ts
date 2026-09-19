// Mounting a React hook under the forked Ink renderer, for the provider UI
// suites that need a real commit cycle rather than a rendered frame.
//
// The OAuth flow hooks do their work in effects — device-flow polling, browser
// launch, credential persistence — so asserting on them needs an actual root
// driving actual effects. Ink's root wants real streams, which is the whole
// reason this boilerplate exists.
//
// `useCodexOAuthFlow.test.tsx` and `useXaiOAuthFlow.test.tsx` predate this file
// and still carry their own copies. They work, and rewriting them is a
// drive-by change inside an unrelated diff; migrate them the next time either
// one is touched for its own sake.
//
// NOT a `.test` file — it exports helpers, it does not register tests.

import { PassThrough } from 'node:stream'

import type * as React from 'react'

import { createRoot } from 'src/terminal/ink.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

export type TestStreams = {
  stdout: PassThrough
  stdin: TestStdin
  getOutput: () => string
}

export function createTestStreams(columns = 120): TestStreams {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = columns
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return { stdout, stdin, getOutput: () => output }
}

/**
 * Poll until `predicate` holds.
 *
 * Effects settle across several microtask turns under the reconciler, so the
 * suites cannot assert straight after `render`. `label` names what was being
 * waited for — a bare timeout message says nothing about which step stalled.
 */
export async function waitForCondition(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5000
  const intervalMs = options?.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(intervalMs)
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${options?.label ?? 'test condition'}`,
  )
}

export type MountedHook = {
  streams: TestStreams
  /** Unmount and close the streams. Safe to call twice. */
  cleanup: () => Promise<void>
}

/**
 * Render `node` on a real Ink root over throwaway streams.
 *
 * Always call `cleanup()` in a `finally`: an unmounted root leaves the hook's
 * effects running, and a flow hook that is still polling a device endpoint
 * keeps a timer alive past the end of the file — which, per testing.md, kills
 * the run somewhere else entirely with no failing test to point at.
 */
export async function mountHook(node: React.ReactNode): Promise<MountedHook> {
  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(node)

  let done = false
  return {
    streams,
    cleanup: async () => {
      if (done) return
      done = true
      root.unmount()
      streams.stdin.end()
      streams.stdout.end()
      await Bun.sleep(0)
    },
  }
}
