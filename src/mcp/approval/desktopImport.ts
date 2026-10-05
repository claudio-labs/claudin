import type { ConfigScope, McpServerConfig } from 'src/mcp/types.js'
import { plural } from 'src/shared/text/stringUtils.js'

export type ImportPlanEntry = {
  name: string
  finalName: string
  config: McpServerConfig
}

type ImportRefusal = {
  finalName: string
  reason: string
}

export type ImportOutcome = {
  imported: ImportPlanEntry[]
  refused: ImportRefusal[]
}

export type AddServer = (name: string, config: McpServerConfig, scope: ConfigScope) => Promise<void>

function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  let k = 1
  while (taken.has(`${name}_${k}`)) k += 1
  return `${name}_${k}`
}

/**
 * Which servers to add and under what name, in the order Claude Desktop lists
 * them. A name already configured anywhere, or already given to an earlier
 * server of this import, gets the first free `_<k>` suffix.
 */
export function planDesktopImport(
  servers: Readonly<Record<string, McpServerConfig>>,
  selected: readonly string[],
  existing: ReadonlySet<string>,
): ImportPlanEntry[] {
  const wanted = new Set(selected)
  const taken = new Set(existing)
  const plan: ImportPlanEntry[] = []
  for (const [name, config] of Object.entries(servers)) {
    if (!wanted.has(name)) continue
    const finalName = freeName(name, taken)
    taken.add(finalName)
    plan.push({ name, finalName, config })
  }
  return plan
}

/** Adds every planned server; one refused server does not stop the others. */
export async function executeDesktopImport(
  plan: readonly ImportPlanEntry[],
  scope: ConfigScope,
  add: AddServer,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: [], refused: [] }
  for (const entry of plan) {
    try {
      await add(entry.finalName, entry.config, scope)
      outcome.imported.push(entry)
    } catch (error) {
      outcome.refused.push({ finalName: entry.finalName, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcome
}

export type DesktopImportRequest = {
  servers: Readonly<Record<string, McpServerConfig>>
  selected: readonly string[]
  existing: ReadonlySet<string>
  scope: ConfigScope
}

export type DesktopImportDeps = {
  add: AddServer
  writeOut(text: string): void
  writeErr(text: string): void
  successColour(text: string): string
  shutdown(exitCode?: number): Promise<void>
}

function summaryLine(importedCount: number, scope: ConfigScope, deps: DesktopImportDeps): string {
  if (importedCount === 0) return '\nNo servers were imported.'
  const text = `Successfully imported ${importedCount} MCP ${plural(importedCount, 'server')} to ${scope} config.`
  return `\n${deps.successColour(text)}\n`
}

/**
 * Imports what was selected, reports every refused server with its reason,
 * prints one summary, tells the caller, and ends the process.
 */
export async function runDesktopImport(
  request: DesktopImportRequest,
  onDone: () => void,
  deps: DesktopImportDeps,
): Promise<void> {
  const plan = planDesktopImport(request.servers, request.selected, request.existing)
  const { imported, refused } = await executeDesktopImport(plan, request.scope, deps.add)
  for (const { finalName, reason } of refused) deps.writeErr(`Could not import ${finalName}: ${reason}\n`)
  deps.writeOut(summaryLine(imported.length, request.scope, deps))
  onDone()
  if (refused.length > 0) await deps.shutdown(1)
  else await deps.shutdown()
}
