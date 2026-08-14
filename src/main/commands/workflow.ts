// `claudin workflow run|watch` — the self-hosted background agent (R3).
//
// Standalone subcommand group (like `mcp`/`server`): it does NOT go through the
// default `-p` action. `run` drives one workflow to completion headlessly and
// optionally opens a PR; `watch` polls a forge for labeled issues and dispatches
// a `run` per trigger. Gated by the same AGENT_WORKFLOWS flag as /workflows.

import type { Command } from '@commander-js/extra-typings'
import { feature } from 'bun:bundle'

export function registerWorkflowCommand(program: Command): void {
  if (!feature('AGENT_WORKFLOWS')) return

  const workflow = program
    .command('workflow')
    .description('Self-hosted background agent: run or watch agent workflows')

  workflow
    .command('run <name>')
    .description('Run a workflow headlessly and optionally open a PR')
    .requiredOption('--task <text>', 'Task/goal to seed the workflow with')
    .option('--worktree', 'Run inside an isolated git worktree', false)
    .option('--pr', 'On success, commit + push the branch and open a PR', false)
    .option('--base <branch>', 'PR base branch (default: remote default branch)')
    .option('--report <file>', 'Write the markdown run report to this path')
    .action(
      async (
        name: string,
        opts: {
          task: string
          worktree?: boolean
          pr?: boolean
          base?: string
          report?: string
        },
      ) => {
        const { runWorkflowHeadless } = await import(
          'src/cli/workflow/runWorkflowHeadless.js'
        )
        process.exitCode = await runWorkflowHeadless({
          workflow: name,
          task: opts.task,
          worktree: Boolean(opts.worktree),
          pr: Boolean(opts.pr),
          base: opts.base,
          report: opts.report,
        })
      },
    )

  workflow
    .command('watch')
    .description('Poll a source for labeled issues and dispatch workflow runs')
    .requiredOption('--workflow <name>', 'Workflow to run for each trigger')
    .option('--label <label>', 'Issue label that triggers a run (github source)', 'claudin')
    .option('--interval <seconds>', 'Poll interval in seconds', '30')
    .option(
      '--source <source>',
      'Trigger source: "github", "url", or "command"',
      'github',
    )
    .option('--url <url>', 'URL to poll (required for --source url)')
    .option(
      '--command <cmd>',
      'Local shell command to poll (required for --source command)',
    )
    .option(
      '--match <regex>',
      'Only trigger on items whose title/body matches this regex',
    )
    .option('--base <branch>', 'PR base branch (default: remote default branch)')
    .action(
      async (opts: {
        workflow: string
        label: string
        interval: string
        source: string
        url?: string
        command?: string
        match?: string
        base?: string
      }) => {
        const { runWatchLoop } = await import('src/cli/workflow/watchLoop.js')
        await runWatchLoop({
          label: opts.label,
          workflow: opts.workflow,
          intervalSec: Number(opts.interval) || 30,
          source: opts.source,
          url: opts.url,
          command: opts.command,
          match: opts.match,
          base: opts.base,
        })
      },
    )
}
