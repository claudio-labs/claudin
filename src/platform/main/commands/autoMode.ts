// Extracted from src/platform/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.
// The `feature('TRANSCRIPT_CLASSIFIER')` gate is embedded so main.tsx stays
// clean.

import type { Command } from '@commander-js/extra-typings'
import { feature } from 'bun:bundle'

export function registerAutoModeCommand(program: Command): void {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const autoModeCmd = program.command('auto-mode').description('Inspect auto mode classifier configuration')
    autoModeCmd.command('defaults').description('Print the default auto mode environment, allow, and deny rules as JSON').action(async () => {
      const {
        autoModeDefaultsHandler
      } = await import('src/platform/headless/handlers/autoMode.js')
      autoModeDefaultsHandler()
      process.exit(0)
    })
    autoModeCmd.command('config').description('Print the effective auto mode config as JSON: your settings where set, defaults otherwise').action(async () => {
      const {
        autoModeConfigHandler
      } = await import('src/platform/headless/handlers/autoMode.js')
      autoModeConfigHandler()
      process.exit(0)
    })
    autoModeCmd.command('critique').description('Get AI feedback on your custom auto mode rules').option('--model <model>', 'Override which model is used').action(async options => {
      const {
        autoModeCritiqueHandler
      } = await import('src/platform/headless/handlers/autoMode.js')
      await autoModeCritiqueHandler(options)
      process.exit()
    })
  }
}
