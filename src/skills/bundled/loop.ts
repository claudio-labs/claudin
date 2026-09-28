/**
 * `/loop`: repeats a prompt in this session, either on a fixed interval (a
 * recurring cron task) or at a pace the model picks after each iteration
 * (one pending wakeup at a time). With no prompt it runs maintenance passes.
 *
 * Maintenance loops schedule a sentinel instead of the instructions
 * themselves; src/agent/loopSentinels.ts expands it when the task fires, so
 * the model has to pass it exactly. Everything handed over verbatim (a
 * prompt, a scheduled body, the maintenance prompt) sits alone between a
 * BEGIN line and an END line.
 */
import {
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  MAINTENANCE_PROMPT,
} from 'src/agent/loopSentinels.js'
import {
  type Interval,
  type LoopRequest,
  formatInterval,
  parseLoopRequest,
} from 'src/skills/bundled/shared/loopRequest.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
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
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'

// -- Prose

const DESCRIPTION =
  'Repeat a prompt on a cron cadence (`/loop 10m <prompt>`), or let each run reschedule the next at a self-chosen interval; a bare `/loop` runs maintenance passes.'

const WHEN_TO_USE =
  'When the user wants to poll a status (CI, a deploy, a queue), babysit a long workflow, run recurring maintenance, or re-run a prompt periodically within the current session.'

/** Text handed over verbatim: alone on its lines, between a BEGIN and an END line. */
function delimited(label: string, body: string): string {
  return `--- BEGIN ${label} ---\n${body}\n--- END ${label} ---`
}

/** Both loop kinds run their first iteration in the turn that sets them up. */
function runNowSection(what: string): string {
  return `## Run it now

Run ${what} immediately, as if the user had just sent it, without waiting for a scheduled run. If it starts with a slash command (\`/name args\`), invoke that through the \`${SKILL_TOOL_NAME}\` tool with \`skill: "name"\` and \`args: "args"\` rather than writing it out.`
}

const CRON_CONVERSION = `Turn the interval into a recurring cron expression (five fields, local time):
- minutes \`Nm\`: \`*/N * * * *\` (\`1m\` is \`* * * * *\`); from 60 minutes on, count in hours
- hours \`Nh\`: \`0 */N * * *\` (\`1h\` is \`0 * * * *\`); from 24 hours on, count in days
- days \`Nd\`: \`0 0 */N * *\` (\`1d\` is \`0 0 * * *\`)
- seconds \`Ns\`: cron counts whole minutes, so round up to the next minute first (\`30s\` becomes \`1m\`, \`90s\` becomes \`2m\`)

A cadence is clean only when it divides the hour or the day evenly. For any other interval (\`7m\`, \`90m\`, \`5h\`), use the nearest clean cadence and tell the user which one you picked.`

function renderFixedLoop(interval: Interval, prompt: string | undefined): string {
  const every = formatInterval(interval)
  const task =
    prompt === undefined
      ? `maintenance to run every \`${every}\` in this session, starting now.`
      : `the prompt below to run every \`${every}\` in this session, starting now. The same text runs now and at every fire:\n\n${delimited('prompt', prompt)}`
  const scheduledBody =
    prompt === undefined
      ? `The scheduled prompt is a sentinel that is expanded into the maintenance instructions each time the task fires, so pass it exactly as written:\n\n${delimited('scheduled prompt', AUTONOMOUS_LOOP_SENTINEL)}`
      : 'The scheduled prompt is the prompt above, exactly as written.'
  const runNow =
    prompt === undefined
      ? `${runNowSection('the maintenance prompt below')}\n\n${delimited('maintenance prompt', MAINTENANCE_PROMPT)}`
      : runNowSection('the prompt above')

  return `# Loop every ${every}

The user asked for ${task}

## Schedule it

${CRON_CONVERSION}

Then call \`${CRON_CREATE_TOOL_NAME}\` with \`cron\` set to that expression, \`prompt\` set to the scheduled prompt, \`recurring: true\` and \`durable: false\`, so the task lives only as long as this session.

${scheduledBody}

## Confirm

Tell the user what was scheduled, the cron expression, how often that is in plain words, that recurring tasks expire after ${DEFAULT_MAX_AGE_DAYS} days, and that \`${CRON_DELETE_TOOL_NAME}\` with the returned job ID cancels it sooner.

${runNow}`
}

function renderSelfPacedLoop(prompt: string | undefined): string {
  const task =
    prompt === undefined
      ? `Run maintenance passes. Each iteration runs \`.claudin/loop.md\` if it exists, otherwise \`~/.claudin/loop.md\`, otherwise the built-in maintenance prompt:\n\n${delimited('maintenance prompt', MAINTENANCE_PROMPT)}`
      : `The prompt to repeat:\n\n${delimited('prompt', prompt)}`
  const wakeupBody =
    prompt === undefined
      ? `The wakeup prompt is a sentinel, expanded into the maintenance instructions when the wakeup fires. Pass it exactly as written rather than pasting the instructions:\n\n${delimited('wakeup prompt', AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)}`
      : `The wakeup prompt sends the next iteration back through \`/loop\`, so the loop stays self-paced:\n\n${delimited('wakeup prompt', `/loop ${prompt}`)}`

  return `# Self-paced loop

You run this task repeatedly in the current session and choose how long to wait between iterations, pacing them with \`${SCHEDULE_WAKEUP_TOOL_NAME}\`.

${task}

${runNowSection(prompt === undefined ? 'whichever of those applies' : 'the prompt above')}

## Schedule the next iteration

As the last action of this turn, call \`${SCHEDULE_WAKEUP_TOOL_NAME}\` exactly once, with:
- \`delaySeconds\`: chosen by the pacing guidance in that tool's description (the runtime clamps it to ${WAKEUP_MIN_DELAY_SECONDS}–${WAKEUP_MAX_DELAY_SECONDS} seconds);
- \`reason\`: one short sentence telling the user why that delay;
- \`prompt\`: the wakeup prompt below.

${wakeupBody}

Only one wakeup is ever pending: a new call replaces the previous one. Never use \`${CRON_CREATE_TOOL_NAME}\` in this mode.

If the next iteration waits on something the \`${MONITOR_TOOL_NAME}\` tool can watch (a CI run, a deploy, an endpoint or a file changing) and that tool is available, start a monitor whose command prints a line when the state changes, and let its notification wake you. Keep \`${SCHEDULE_WAKEUP_TOOL_NAME}\` only as a fallback heartbeat of 1200–1800 seconds.

## End the loop

Stop when the task is complete, when you are blocked on the user, or when the user asks you to stop. Then do not call \`${SCHEDULE_WAKEUP_TOOL_NAME}\`; tell the user the loop ended and why. If a wakeup from an earlier turn is still pending, cancel it by calling \`${SCHEDULE_WAKEUP_TOOL_NAME}\` with \`cancel: true\`.`
}

function renderPrompt(request: LoopRequest): string {
  return request.kind === 'fixed'
    ? renderFixedLoop(request.interval, request.prompt)
    : renderSelfPacedLoop(request.prompt)
}

// -- Registration

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    argumentHint: '[interval] [prompt]',
    userInvocable: true,
    disableModelInvocation: false,
    // Read on every call, so CLAUDIN_DISABLE_CRON hides the skill without a restart.
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: renderPrompt(parseLoopRequest(args)) }]
    },
  })
}
