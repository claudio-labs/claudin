// Extracted from src/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.

import type { Command } from '@commander-js/extra-typings'
import { getBaseRenderOptions } from 'src/terminal/render/renderOptions.js'

export function registerDoctorCommand(program: Command): void {
  // Doctor command - check installation health
  program.command('doctor').description('Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async () => {
    const [{
      doctorHandler
    }, {
      createRoot
    }] = await Promise.all([import('src/cli/handlers/util.js'), import('src/terminal/ink.js')])
    const root = await createRoot(getBaseRenderOptions(false))
    await doctorHandler(root)
  })
}
