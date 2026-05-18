// Extracted from src/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.
// Gate (`feature('BRIDGE_MODE')`) is embedded so main.tsx stays clean.

import type { Command } from '@commander-js/extra-typings'
import { feature } from 'bun:bundle'

export function registerRemoteControlCommand(program: Command): void {
  // Remote Control command — connect local environment to claude.ai/code.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  // Always hidden: isBridgeEnabled() at this point (before enableConfigs)
  // would throw inside isClaudeAISubscriber → getGlobalConfig and return
  // false via the try/catch — but not before paying ~65ms of side effects
  // (25ms settings Zod parse + 40ms sync `security` keychain subprocess).
  // The dynamic visibility never worked; the command was always hidden.
  if (feature('BRIDGE_MODE')) {
    program.command('remote-control', {
      hidden: true
    }).alias('rc').description('Connect your local environment for remote-control sessions via claude.ai/code').action(async () => {
      // Unreachable — cli.tsx fast-path handles this command before main.tsx loads.
      // If somehow reached, delegate to bridgeMain.
      const {
        bridgeMain
      } = await import('../../bridge/bridgeMain.js')
      await bridgeMain(process.argv.slice(3))
    })
  }
}
