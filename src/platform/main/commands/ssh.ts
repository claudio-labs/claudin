// Extracted from src/platform/main.tsx (ROADMAP 11g, Fase 5a).
// Pure relocation — behavior identical. See main.tsx for the original site.
// Gate (`feature('SSH_REMOTE')`) is embedded so main.tsx stays clean.

import type { Command } from '@commander-js/extra-typings'
import { feature } from 'bun:bundle'

export function registerSshCommand(program: Command): void {
  // `claude ssh <host> [dir]` — registered here only so --help shows it.
  // The actual interactive flow is handled by early argv rewriting in main()
  // (parallels the DIRECT_CONNECT/cc:// pattern above). If commander reaches
  // this action it means the argv rewrite didn't fire (e.g. user ran
  // `claude ssh` with no host) — just print usage.
  if (feature('SSH_REMOTE')) {
    program.command('ssh <host> [dir]').description('Run Claude Code on a remote host over SSH. Deploys the binary and ' + 'tunnels API auth back through your local machine — no remote setup needed.').option('--permission-mode <mode>', 'Permission mode for the remote session').option('--dangerously-skip-permissions', 'Skip all permission prompts on the remote (dangerous)').option('--local', 'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' + 'Exercises the auth proxy and unix-socket plumbing without a remote host.').action(async () => {
      // Argv rewriting in main() should have consumed `ssh <host>` before
      // commander runs. Reaching here means host was missing or the
      // rewrite predicate didn't match.
      process.stderr.write('Usage: claude ssh <user@host | ssh-config-alias> [dir]\n\n' + "Runs Claude Code on a remote Linux host. You don't need to install\n" + 'anything on the remote or run `claude auth login` there — the binary is\n' + 'deployed over SSH and API auth tunnels back through your local machine.\n')
      process.exit(1)
    })
  }
}
