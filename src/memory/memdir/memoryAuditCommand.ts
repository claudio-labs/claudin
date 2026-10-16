/**
 * `claudin memory audit` — memoryAudit.ts for a CI step or a pre-commit hook,
 * in any repo that carries a team memory dir. Exit 1 when the team dir holds
 * secret-shaped content, 0 otherwise — memories past their `expires:` date
 * are listed for review and never fail it — and 2 when the audit itself
 * fails, so a CI step goes red rather than hanging. Imported only when the
 * subcommand runs (src/platform/main/commands/memory.ts).
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { auditFails, auditMemoryDirs, type MemoryAudit } from 'src/memory/memdir/memoryAudit.js'
import { getMemoryDirs, type MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'
import { committedTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { errorMessage } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { relativeIfInside } from 'src/shared/fs/path.js'
import { findCanonicalGitRoot } from 'src/vcs/git/git.js'

export type MemoryAuditOptions = { json?: boolean }

/**
 * What the audit covers: the session's memory dirs, and the repository's
 * committed team dir whatever they are. A CI gate that a setting could
 * switch off — `autoMemoryEnabled: false` in the repo's own
 * `.claudin/settings.json` — or move — `autoMemoryDirectory` — guards
 * nothing. Pure over its inputs.
 */
export function auditDirsFor(
  sessionDirs: readonly MemoryDir[],
  committedTeamDir: string | null,
): MemoryDir[] {
  if (committedTeamDir === null || sessionDirs.some(dir => dir.root === committedTeamDir)) return [...sessionDirs]
  return [...sessionDirs, { scope: 'team', root: committedTeamDir, index: join(committedTeamDir, ENTRYPOINT_NAME) }]
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
    const findings = audit.findings.map(f => ({ ...f, path: relativeIfInside(f.path, cwd) }))
    return { output: JSON.stringify({ files: audit.files, findings }, null, 2), exitCode }
  }
  if (audit.findings.length === 0) {
    return { output: `Memory audit: ${audit.files} files, no findings.`, exitCode }
  }
  const lines = audit.findings.map(f =>
    f.kind === 'secret'
      ? `${relativeIfInside(f.path, cwd)}: secret-shaped content (${f.labels.join(', ')})`
      : `${relativeIfInside(f.path, cwd)}: expired ${f.expires} — re-verify it, then move the date or remove the memory`,
  )
  return {
    output: [
      `Memory audit: ${audit.files} files, ${audit.findings.length} with findings.`,
      ...lines,
      ...(exitCode === 1 ? ['Team memory is git-tracked: remove the secret, and rotate it if it was ever committed.'] : []),
    ].join('\n'),
    exitCode,
  }
}

export async function memoryAuditHandler(options: MemoryAuditOptions): Promise<number> {
  try {
    const gitRoot = findCanonicalGitRoot(getCwd())
    const committed = gitRoot === null ? null : committedTeamMemPath(gitRoot)
    const dirs = auditDirsFor(getMemoryDirs(), committed !== null && existsSync(committed) ? committed : null)
    const audit = dirs.length === 0 ? null : await auditMemoryDirs(dirs)
    const { output, exitCode } = formatMemoryAudit(audit, getCwd(), options)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(output)
    return exitCode
  } catch (e) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Memory audit failed: ${errorMessage(e)}`)
    return 2
  }
}
