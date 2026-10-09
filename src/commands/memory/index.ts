import type { Command } from 'src/commands/commands.js'
import { MEMORY_SCOPES } from 'src/memory/memdir/memoryScopes.js'

// The same list as tidy.ts's SUBCOMMANDS (tidy.test.ts pins it), built here
// from the pure memoryScopes.ts so registering the command does not load the
// memory-path chain tidy.ts needs to run one.
const scopes = MEMORY_SCOPES.join('|')

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: `Browse and edit memory and instruction files; /memory ${scopes} opens a memory directory, /memory tidy merges duplicates, /memory sort files team memories into decisions/bugs/docs and promotes what is about you to the global memory`,
  argumentHint: `[tidy|sort|${scopes}]`,
  load: () => import('src/commands/memory/memory.js'),
}

export default memory
