// Extracted from src/platform/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.
// Gate (`feature('DIRECT_CONNECT')`) is embedded so main.tsx stays clean.
//
// The `_pendingConnect` slot is owned by main.tsx (mutated by early argv
// pre-parsing before run() builds Commander). It's passed in here as a
// parameter to preserve that boot-ordering invariant — the slot must
// be the same module-level reference, not a copy.

import type { Command } from '@commander-js/extra-typings'
import { feature } from 'bun:bundle'
import type { PendingConnect } from 'src/platform/main/bootContext.js'
import { getOriginalCwd, setCwdState, setDirectConnectServerUrl, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { createDirectConnectSession, DirectConnectError } from 'src/platform/server/createDirectConnectSession.js'

export function registerOpenCommand(program: Command, pendingConnect: PendingConnect | undefined): void {
  // claude connect — subcommand only handles -p (headless) mode.
  // Interactive mode (without -p) is handled by early argv rewriting in main()
  // which redirects to the main command with full TUI support.
  if (feature('DIRECT_CONNECT')) {
    program.command('open <cc-url>').description('Connect to a Claude Code server (internal — use cc:// URLs)').option('-p, --print [prompt]', 'Print mode (headless)').option('--output-format <format>', 'Output format: text, json, stream-json', 'text').action(async (ccUrl: string, opts: {
      print?: string | boolean
      outputFormat: string
    }) => {
      const {
        parseConnectUrl
      } = await import('../../server/parseConnectUrl.js')
      const {
        serverUrl,
        authToken
      } = parseConnectUrl(ccUrl)
      let connectConfig
      try {
        const session = await createDirectConnectSession({
          serverUrl,
          authToken,
          cwd: getOriginalCwd(),
          dangerouslySkipPermissions: pendingConnect?.dangerouslySkipPermissions
        })
        if (session.workDir) {
          setOriginalCwd(session.workDir)
          setCwdState(session.workDir)
        }
        setDirectConnectServerUrl(serverUrl)
        connectConfig = session.config
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: intentional error output
        console.error(err instanceof DirectConnectError ? err.message : String(err))
        process.exit(1)
      }
      const {
        runConnectHeadless
      } = await import('../../server/connectHeadless.js')
      const prompt = typeof opts.print === 'string' ? opts.print : ''
      const interactive = opts.print === true
      await runConnectHeadless(connectConfig, prompt, opts.outputFormat, interactive)
    })
  }
}
