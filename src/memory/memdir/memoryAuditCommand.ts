/**
 * `claudin memory audit` — memoryAudit.ts for a CI step or a pre-commit hook,
 * in any repo that carries a team memory dir. Exit 1 when the team dir holds
 * secret-shaped content, 0 otherwise. Imported only when the subcommand runs
 * (src/platform/main/commands/memory.ts).
 */
import { isAbsolute, relative } from 'path'
import { auditFails, auditMemoryDirs, type MemoryAudit } from 'src/memory/memdir/memoryAudit.js'
import { getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import { getCwd } from 'src/shared/fs/cwd.js'

export type MemoryAuditOptions = { json?: boolean }

/** `path` relative to `cwd` when it is inside it, as a CI log should show it. */
function shown(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

/** What the subcommand prints and the code it exits with. Pure. */
export function formatMemoryAudit(
  audit: MemoryAudit | null,
  cwd: string,
  options: MemoryAuditOptions = {},
): { output: string; exitCode: number } {
  if (audit === null) {
    return {
      output: options.json
        ? JSON.stringify({ memory: 'off', files: 0, findings: [] }, null, 2)
        : 'Memory is off (autoMemoryEnabled is false, or CLAUDIN_DISABLE_AUTO_MEMORY is set): nothing to audit.',
      exitCode: 0,
    }
  }
  const exitCode = auditFails(audit) ? 1 : 0
  if (options.json) {
    const findings = audit.findings.map(f => ({ ...f, path: shown(f.path, cwd) }))
    return { output: JSON.stringify({ files: audit.files, findings }, null, 2), exitCode }
  }
  if (audit.findings.length === 0) {
    return { output: `Memory audit: ${audit.files} files, no findings.`, exitCode }
  }
  const lines = audit.findings.map(f => `${shown(f.path, cwd)}: secret-shaped content (${f.labels.join(', ')})`)
  return {
    output: [
      `Memory audit: ${audit.files} files, ${audit.findings.length} with findings.`,
      ...lines,
      'Team memory is git-tracked: remove the secret, and rotate it if it was ever committed.',
    ].join('\n'),
    exitCode,
  }
}

export async function memoryAuditHandler(options: MemoryAuditOptions): Promise<number> {
  const dirs = getMemoryDirs()
  const audit = dirs.length === 0 ? null : await auditMemoryDirs(dirs)
  const { output, exitCode } = formatMemoryAudit(audit, getCwd(), options)
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(output)
  return exitCode
}
