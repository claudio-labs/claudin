// Extracted from src/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.

import type { Command } from '@commander-js/extra-typings'

export function registerInstallCommand(program: Command): void {
  // claude install
  program.command('install [target]').description('Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)').option('--force', 'Force installation even if already installed').action(async (target: string | undefined, options: {
    force?: boolean
  }) => {
    const {
      installHandler
    } = await import('../../cli/handlers/util.js')
    await installHandler(target, options)
  })
}
