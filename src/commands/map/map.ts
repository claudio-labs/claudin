import { join } from 'path'
import { getProjectRoot } from 'src/platform/bootstrap/state.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from 'src/platform/config/config.js'
import { buildRuleMapAnnotatePrompt } from 'src/memory/instructions/ruleMapAnnotatePrompt.js'
import {
  describeRuleMapNotice,
  RULE_MAP_KILLSWITCH,
  RULE_MAP_RELATIVE_PATH,
  type RuleMapSkipReason,
  type RuleMapSyncOutcome,
} from 'src/memory/instructions/ruleMapAutoSync.js'
import {
  getLastRuleMapRun,
  type RuleMapRun,
  syncRuleMapNow,
} from 'src/memory/instructions/ruleMapScheduler.js'
import {
  describeRuleMapWrite,
  type RuleMapKind,
  ruleMapKind,
} from 'src/memory/instructions/rulesMapSync.js'
import { lintRuleFiles } from 'src/memory/instructions/rulesLint.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { formatDuration } from 'src/shared/text/format.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from 'src/shared/types/command.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const USAGE = [
  'Usage:',
  '  /map            Show the navigation map: its kind, the auto-sync, the last sync, and any drift.',
  '  /map sync       Sync it now, whatever changed.',
  '  /map off | on   Stop or resume the end-of-turn sync for this project.',
  '  /map annotate   Have the model replace the `← TODO`s with what each directory is for.',
].join('\n')

/** Drift findings named in the status before it counts the rest. */
const MAX_LISTED_FINDINGS = 3

const TODO_GLOSS_RE = /←\s*TODO\s*$/gm

/** Every reason a sync wrote nothing, in the user's words rather than ours. */
const SKIP_REASON_WORDS: Record<RuleMapSkipReason, string> = {
  killswitch: `${RULE_MAP_KILLSWITCH} is set`,
  'off for this project': 'it is off for this project (/map on)',
  'not a git repo': 'this project is not a git repository',
  worktree: 'this is a linked worktree',
  'nothing to map': 'the code does not group into directories yet',
  'already current': 'it is already current',
  'uncommitted changes': 'it has uncommitted edits of yours',
  error: 'git failed (--debug has the details)',
}

const KIND_WORDS: Record<RuleMapKind, string> = {
  generated: 'generated — its tree and counts are kept current',
  edited:
    'generated, with text inside its tree — only its counts are kept current until that text moves after a `←`',
  'hand-written': 'hand-written — only its counts are kept current',
}

export type MapArgs =
  | { kind: 'status' | 'sync' | 'on' | 'off' | 'annotate' }
  | { kind: 'usage'; arg: string }

/** Parse /map arguments. Exported for tests. */
export function parseMapArgs(args: string): MapArgs {
  const trimmed = args.trim()
  if (trimmed === '' || trimmed === 'status') return { kind: 'status' }
  if (
    trimmed === 'sync' ||
    trimmed === 'on' ||
    trimmed === 'off' ||
    trimmed === 'annotate'
  ) {
    return { kind: trimmed }
  }
  return { kind: 'usage', arg: trimmed }
}

type SyncSwitch = 'on' | 'off for this project' | 'off everywhere'

function syncSwitch(): SyncSwitch {
  if (isEnvTruthy(process.env[RULE_MAP_KILLSWITCH])) return 'off everywhere'
  return getCurrentProjectConfig().ruleMapSyncDisabled === true
    ? 'off for this project'
    : 'on'
}

const AUTO_SYNC_WORDS: Record<SyncSwitch, string> = {
  on: 'Auto-sync: on, at the end of each turn when the tracked files changed',
  'off for this project': 'Auto-sync: off for this project',
  'off everywhere': `Auto-sync: off everywhere (${RULE_MAP_KILLSWITCH} is set)`,
}

/** The verbs that apply now, on one line — the switch shows only its way back. */
function commandsHint(state: SyncSwitch): string {
  const toggle =
    state === 'on' ? ['/map off'] : state === 'off for this project' ? ['/map on'] : []
  return ['/map sync', ...toggle, '/map annotate'].join(' · ')
}

function outcomeWords(outcome: RuleMapSyncOutcome): string {
  return outcome.status === 'skipped'
    ? `nothing written: ${SKIP_REASON_WORDS[outcome.reason]}`
    : describeRuleMapWrite(outcome)
}

/** `Last sync: 2m ago, updated · src/tools/ 682→751`. Exported for tests. */
export function lastSyncLine(run: RuleMapRun | null, now: number): string {
  if (run === null) return 'Last sync: none yet in this session'
  const ago = formatDuration(Math.max(0, now - run.at), {
    mostSignificantOnly: true,
  })
  const by = run.trigger === 'command' ? ' (on demand)' : ''
  return `Last sync: ${ago} ago${by}, ${outcomeWords(run.outcome)}`
}

async function statusText(root: string): Promise<string> {
  const absPath = join(root, RULE_MAP_RELATIVE_PATH)
  const fs = getFsImplementation()
  const exists = fs.existsSync(absPath)
  const content = exists ? await fs.readFile(absPath, { encoding: 'utf8' }) : ''
  const state = syncSwitch()
  const lines = [
    `Navigation map · ${RULE_MAP_RELATIVE_PATH}`,
    `  Kind: ${exists ? KIND_WORDS[ruleMapKind(content)] : 'not written yet (/map sync writes one)'}`,
    `  ${AUTO_SYNC_WORDS[state]}`,
    `  ${lastSyncLine(getLastRuleMapRun(), Date.now())}`,
  ]
  if (exists) {
    const todos = content.match(TODO_GLOSS_RE)?.length ?? 0
    if (todos > 0) {
      lines.push(
        `  Unexplained: ${todos} ${todos === 1 ? 'entry reads' : 'entries read'} \`← TODO\` (/map annotate)`,
      )
    }
    const findings = (await lintRuleFiles({ root })).findings.filter(
      finding => finding.file === absPath,
    )
    const n = findings.length
    if (n === 0) {
      lines.push('  Drift: none — every path and count checks out')
    } else {
      lines.push(`  Drift: ${n} ${n === 1 ? 'finding' : 'findings'}`)
      for (const finding of findings.slice(0, MAX_LISTED_FINDINGS)) {
        const at = finding.line === undefined ? '' : `line ${finding.line}: `
        lines.push(`    ${at}${finding.message}`)
      }
      if (n > MAX_LISTED_FINDINGS) {
        lines.push(`    … ${n - MAX_LISTED_FINDINGS} more (/refresh-rules lists them all)`)
      }
    }
  }
  lines.push(`  ${commandsHint(state)}`)
  return lines.join('\n')
}

function syncResultText(outcome: RuleMapSyncOutcome): string {
  if (outcome.status !== 'skipped') return describeRuleMapNotice(outcome)
  if (outcome.reason === 'already current') return 'Navigation map already current.'
  return `Navigation map not synced: ${SKIP_REASON_WORDS[outcome.reason]}.`
}

function setProjectSwitch(disabled: boolean): string {
  // `undefined` rather than a deleted key: JSON drops it on disk, and a store
  // that merges (Object.assign) still clears it.
  saveCurrentProjectConfig(current => ({
    ...current,
    ruleMapSyncDisabled: disabled ? true : undefined,
  }))
  const everywhere = isEnvTruthy(process.env[RULE_MAP_KILLSWITCH])
    ? ` (${RULE_MAP_KILLSWITCH} is set, which keeps it off everywhere)`
    : ''
  return disabled
    ? `Navigation map sync off for this project. /map sync still runs it on demand.${everywhere}`
    : `Navigation map sync on for this project: it runs at the end of each turn when the tracked files changed.${everywhere}`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const parsed = parseMapArgs(args)
  const root = getProjectRoot()

  switch (parsed.kind) {
    case 'usage':
      onDone(`Unknown /map argument: ${parsed.arg}\n\n${USAGE}`, {
        display: 'system',
      })
      return null

    case 'status':
      onDone(await statusText(root), { display: 'system' })
      return null

    case 'sync': {
      // The command's own result names the outcome, so the sync itself stays
      // quiet — otherwise a headless run prints it twice.
      const outcome = await syncRuleMapNow({
        setAppState: context.setAppState,
        announce: false,
      })
      onDone(syncResultText(outcome), { display: 'system' })
      return null
    }

    case 'on':
    case 'off':
      onDone(setProjectSwitch(parsed.kind === 'off'), { display: 'system' })
      return null

    case 'annotate': {
      // Annotating a stale tree would explain directories that are about to
      // be renamed or dropped, so the map is brought current first.
      const outcome = await syncRuleMapNow({
        setAppState: context.setAppState,
        announce: false,
      })
      if (!getFsImplementation().existsSync(join(root, RULE_MAP_RELATIVE_PATH))) {
        const why =
          outcome.status === 'skipped' ? SKIP_REASON_WORDS[outcome.reason] : 'no map was written'
        onDone(`No navigation map to annotate: ${why}.`, { display: 'system' })
        return null
      }
      const synced =
        outcome.status === 'skipped' ? '' : `${describeRuleMapNotice(outcome)}\n`
      onDone(`${synced}Annotating the navigation map…`, {
        display: 'system',
        shouldQuery: true,
        metaMessages: [buildRuleMapAnnotatePrompt(RULE_MAP_RELATIVE_PATH)],
      })
      return null
    }
  }
}
