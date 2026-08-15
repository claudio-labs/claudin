// Extracted from src/platform/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.
// Gate (`feature('KAIROS')`) is embedded so main.tsx stays clean.

import type { Command } from '@commander-js/extra-typings'
import { feature } from 'bun:bundle'

export function registerAssistantCommand(program: Command): void {
  if (feature('KAIROS')) {
    program.command('assistant [sessionId]').description('Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.').action(() => {
      // Argv rewriting above should have consumed `assistant [id]`
      // before commander runs. Reaching here means a root flag came first
      // (e.g. `--debug assistant`) and the position-0 predicate
      // didn't match. Print usage like the ssh stub does.
      process.stderr.write('Usage: claude assistant [sessionId]\n\n' + 'Attach the REPL as a viewer client to a running bridge session.\n' + 'Omit sessionId to discover and pick from available sessions.\n')
      process.exit(1)
    })
  }
}
