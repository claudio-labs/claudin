// Extracted from src/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.

import type { Command } from '@commander-js/extra-typings'

export function registerUpdateCommand(program: Command): void {
  // claude update
  //
  // For SemVer-compliant versioning with build metadata (X.X.X+SHA):
  // - We perform exact string comparison (including SHA) to detect any change
  // - This ensures users always get the latest build, even when only the SHA changes
  // - UI shows both versions including build metadata for clarity
  program.command('update').alias('upgrade').description('Check for updates and install if available').action(async () => {
    const {
      update
    } = await import('src/cli/update.js')
    await update()
  })
}
