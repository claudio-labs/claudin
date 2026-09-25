/**
 * `then` on Patch and Edit — the light half: the flag, the schema field and
 * the shape of what ran. Kept apart from `editThen.ts` so the agent loop
 * (`toolOrchestration.ts`, `responseChain.ts`) can read the flag and a result
 * without loading the Bash permission pipeline that `editThen.ts` imports.
 *
 * On by default since 2026-09-25; `CLAUDIN_EDIT_THEN=0` turns it off, and with
 * it the response guard it arms (toolOrchestration.ts). One API request is one model
 * response, so an edit and the test that checks it cost two requests unless
 * they share one. In the session A/B, claudin ran the check in a call of its
 * own after ~0.9 edits a session where Claude Code chains `&& bun test` into
 * the same Bash, and in the real corpus an edit followed by a check is 3.2% of
 * all calls (team memory `request-count-levers-2026-09-24`). Saying so in the
 * prompt moved nothing (CLAUDIN_RESPONSE_CHAINS); this makes it a parameter of
 * the edit itself.
 *
 * Measured 2026-09-25 (session A/B, N=8): used in 8/8 sessions, calls −14%
 * against the base and the placebo, cost −7%, every session 18/18. The user
 * turned it on by default the same day.
 */
import { z } from 'zod/v4'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export const EDIT_THEN_ENV = 'CLAUDIN_EDIT_THEN'

export const MAX_THEN_COMMANDS = 3

/** On unless `=0`. Read per call; the schema and the prompts read it once, when they are built. */
export function isEditThenEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env[EDIT_THEN_ENV])
}

const THEN_DESCRIPTION = `Up to ${MAX_THEN_COMMANDS} shell commands to run once the edit has applied — the test, typecheck or build that checks it. They run in order and stop at the first that fails, and their output comes back in this result, so the check needs no call of its own. Nothing runs if the edit fails.`

const thenSchema = () =>
  z.array(z.string()).max(MAX_THEN_COMMANDS).nullish().describe(THEN_DESCRIPTION)

/**
 * The `then` field for an edit tool's input schema. With the flag off (`=0`) it is
 * absent at runtime, so the schema sent to the API and the strict parse are
 * what they were; the static type always carries it, as an optional field
 * nothing sets.
 */
export function thenSchemaFields(): { then: ReturnType<typeof thenSchema> } {
  return (isEditThenEnabled() ? { then: thenSchema() } : {}) as {
    then: ReturnType<typeof thenSchema>
  }
}

/** The input's commands, trimmed. `null`, `[]` and `""` are what a strict-schema provider sends for an unset field, so they mean none. */
export function thenCommands(input: { then?: readonly string[] | null }): string[] {
  return (input.then ?? []).map(command => command.trim()).filter(command => command.length > 0)
}

/** One command of `then`. `ran: false` is one skipped after an earlier failure; `exitCode: null`, one interrupted or sent to the background. */
export type ThenRun = {
  command: string
  ran: boolean
  exitCode: number | null
  output: string
}

/** Whether an edit's result carries a `then` command that failed — a failed check, for the response chain. */
export function thenFailed(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || !('then' in data)) return false
  const runs = (data as { then?: unknown }).then
  return (
    Array.isArray(runs) &&
    runs.some(run => typeof run === 'object' && run !== null && run.ran === true && run.exitCode !== 0)
  )
}
