// Extracted from src/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.

import type { Command } from '@commander-js/extra-typings'
import { getBaseRenderOptions } from 'src/utils/renderOptions.js'

export function registerSetupTokenCommand(program: Command): void {
  // Setup token command
  program.command('setup-token').description('Set up a long-lived authentication token (requires Claude subscription)').action(async () => {
    const [{
      setupTokenHandler
    }, {
      createRoot
    }] = await Promise.all([import('src/cli/handlers/util.js'), import('src/ink.js')])
    const root = await createRoot(getBaseRenderOptions(false))
    await setupTokenHandler(root)
  })
}
