// `claudin memory audit` — the deterministic memory audit (memoryAudit.ts) as
// a CI step or a pre-commit hook: secret-shaped content in the git-tracked
// team dir exits 1. The handler lives in the memory slice and is imported only
// when the subcommand runs.

import type { Command } from '@commander-js/extra-typings'

export function registerMemoryCommand(program: Command): void {
  const memory = program.command('memory').description('Inspect the memory directories')
  memory.command('audit').description('Scan the memory directories; secret-shaped content in team memory exits 1').option('--json', 'Output as JSON').action(async (opts: {
    json?: boolean
  }) => {
    const {
      memoryAuditHandler
    } = await import('src/memory/memdir/memoryAuditCommand.js')
    process.exit(await memoryAuditHandler(opts))
  })
}
