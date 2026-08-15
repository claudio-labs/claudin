import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from 'src/tools/ScheduleCronTool/prompt.js'
import {
  SCHEDULE_WAKEUP_TOOL_NAME,
  WAKEUP_MAX_DELAY_SECONDS,
  WAKEUP_MIN_DELAY_SECONDS,
} from 'src/tools/ScheduleWakeupTool/prompt.js'
import {
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  MAINTENANCE_PROMPT,
} from 'src/agent/loopSentinels.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'

type LoopMode =
  | 'dynamic-prompt'
  | 'dynamic-maintenance'
  | 'fixed-prompt'
  | 'fixed-maintenance'

type ParsedLoopArgs = {
  mode: LoopMode
  interval?: string
  prompt?: string
}

// Mirrors MONITOR_TOOL_NAME in src/tools/MonitorTool/MonitorTool.ts. Inlined
// as a literal because importing MonitorTool.ts would eagerly evaluate the
// BashTool permission chain at skill-registration time (this repo lazy-loads
// tool modules — see src/__tests__/lazyToolModuleLoad.test.ts).
const MONITOR_TOOL_NAME = 'Monitor'

function normalizeIntervalUnit(rawUnit: string): 's' | 'm' | 'h' | 'd' | null {
  const unit = rawUnit.toLowerCase()
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) return 's'
  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) return 'm'
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) return 'h'
  if (['d', 'day', 'days'].includes(unit)) return 'd'
  return null
}

function parseIntervalToken(token: string): string | null {
  const match = token.trim().match(/^(\d+)\s*([a-zA-Z]+)$/)
  if (!match) return null
  const value = Number.parseInt(match[1]!, 10)
  if (!Number.isFinite(value) || value < 1) return null
  const unit = normalizeIntervalUnit(match[2]!)
  if (!unit) return null
  return `${value}${unit}`
}

function parseTrailingEveryClause(input: string): {
  prompt: string
  interval: string
} | null {
  const match = input.match(/^(.*?)(?:\s+every\s+)(\d+)\s*([a-zA-Z]+)\s*$/i)
  if (!match) return null
  const interval = parseIntervalToken(`${match[2]!}${match[3]!}`)
  if (!interval) return null
  return {
    prompt: match[1]!.trim(),
    interval,
  }
}

function parseLoopArgs(args: string): ParsedLoopArgs {
  const trimmed = args.trim()
  if (!trimmed) return { mode: 'dynamic-maintenance' }

  const bareInterval = parseIntervalToken(trimmed)
  if (bareInterval) {
    return { mode: 'fixed-maintenance', interval: bareInterval }
  }

  const [firstToken, ...restTokens] = trimmed.split(/\s+/)
  const leadingInterval = parseIntervalToken(firstToken ?? '')
  if (leadingInterval) {
    const prompt = restTokens.join(' ').trim()
    if (!prompt) return { mode: 'fixed-maintenance', interval: leadingInterval }
    return {
      mode: 'fixed-prompt',
      interval: leadingInterval,
      prompt,
    }
  }

  const trailingEvery = parseTrailingEveryClause(trimmed)
  if (trailingEvery) {
    if (!trailingEvery.prompt) {
      return {
        mode: 'fixed-maintenance',
        interval: trailingEvery.interval,
      }
    }
    return {
      mode: 'fixed-prompt',
      interval: trailingEvery.interval,
      prompt: trailingEvery.prompt,
    }
  }

  return {
    mode: 'dynamic-prompt',
    prompt: trimmed,
  }
}

function buildFixedPrompt(parsed: ParsedLoopArgs): string {
  const targetInstructions = parsed.prompt
    ? `Use this prompt verbatim for both the immediate run and the recurring scheduled task:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

For the recurring scheduled task, use this exact one-line prompt body. It is a sentinel the runtime expands at delivery time (full maintenance instructions on the first fire and whenever loop.md changes, a short reminder afterwards), which keeps the long instruction text in the cached prefix. Pass it exactly — do not inline the instructions:

--- BEGIN SCHEDULED PROMPT ---
${AUTONOMOUS_LOOP_SENTINEL}
--- END SCHEDULED PROMPT ---

For the immediate run in step 4, follow this maintenance prompt:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`

  return `# /loop — fixed recurring interval

The user invoked /loop with a fixed interval.

Requested interval: ${parsed.interval}

${targetInstructions}
## Instructions

1. Convert the requested interval to a recurring cron expression.
   - Supported suffixes: s, m, h, d.
   - Seconds must be rounded up to the nearest minute because cron has minute granularity.
   - If the requested interval does not map cleanly to cron cadence, choose the nearest clean recurring interval and tell the user what you picked.
2. Call ${CRON_CREATE_TOOL_NAME} with:
   - the recurring cron expression
   - the scheduled prompt body above (for maintenance loops, the one-line sentinel exactly as given)
   - recurring: true
   - durable: false
3. Briefly confirm what was scheduled, the cron expression, the human cadence, that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days, and that the user can cancel sooner with ${CRON_DELETE_TOOL_NAME} using the returned job ID.
4. Immediately execute the effective prompt now — do not wait for the first cron fire.
   - If the effective prompt starts with a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
`
}

function buildDynamicPrompt(parsed: ParsedLoopArgs): string {
  const effectivePromptInstructions = parsed.prompt
    ? `Use this prompt verbatim as the effective prompt for this iteration:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

Determine the effective prompt in this order:
1. If .claudin/loop.md exists, read it and use it.
2. Otherwise, if ~/.claudin/loop.md exists, read it and use it.
3. Otherwise, use this built-in maintenance prompt:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`

  const reschedulePrompt = parsed.prompt
    ? `/loop ${parsed.prompt}`
    : AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
  const sentinelNote = parsed.prompt
    ? ''
    : ' (a sentinel the runtime expands at delivery time — pass it exactly, do not inline the maintenance instructions)'

  return `# /loop — dynamic rescheduling

The user invoked /loop without a fixed interval — you pace the iterations yourself with ${SCHEDULE_WAKEUP_TOOL_NAME}.

${effectivePromptInstructions}
## Instructions

1. Execute the effective prompt now.
   - If it starts with a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
2. Then, as the LAST action of this turn, call ${SCHEDULE_WAKEUP_TOOL_NAME} exactly once to schedule the next iteration:
   - delaySeconds: choose it yourself per the pacing guidance in the ${SCHEDULE_WAKEUP_TOOL_NAME} tool description. The runtime clamps to [${WAKEUP_MIN_DELAY_SECONDS}, ${WAKEUP_MAX_DELAY_SECONDS}] seconds.
   - reason: one short sentence telling the user what delay you picked and why.
   - prompt: set it to this exact text${sentinelNote} so the next iteration stays in dynamic mode:

--- BEGIN SCHEDULED PROMPT ---
${reschedulePrompt}
--- END SCHEDULED PROMPT ---

3. Only one wakeup is alive at a time — calling ${SCHEDULE_WAKEUP_TOOL_NAME} again replaces the pending one. Do not use ${CRON_CREATE_TOOL_NAME} in this mode.
4. If the next iteration is gated on an external event the ${MONITOR_TOOL_NAME} tool can watch (a CI run, a deploy, an endpoint or file changing) and ${MONITOR_TOOL_NAME} is available in this session, arm a persistent ${MONITOR_TOOL_NAME} as the primary wake signal and use ${SCHEDULE_WAKEUP_TOOL_NAME} only as a 1200–1800s fallback heartbeat.
5. To end the loop (the task is complete, you are blocked on the user, or the user asked to stop), do not call ${SCHEDULE_WAKEUP_TOOL_NAME} — and briefly tell the user the loop ended and why. If a wakeup is already pending from a previous turn (e.g. the user interrupted to ask you to stop), call ${SCHEDULE_WAKEUP_TOOL_NAME} with cancel: true to kill it.
`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt on a fixed interval or dynamically reschedule it, including bare maintenance-mode loops.',
    whenToUse:
      'When the user wants to poll for status, babysit a workflow, run recurring maintenance, or keep re-running a prompt within the current session.',
    argumentHint: '[interval] [prompt]',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const parsed = parseLoopArgs(args)
      const text =
        parsed.mode === 'fixed-prompt' || parsed.mode === 'fixed-maintenance'
          ? buildFixedPrompt(parsed)
          : buildDynamicPrompt(parsed)
      return [{ type: 'text', text }]
    },
  })
}
