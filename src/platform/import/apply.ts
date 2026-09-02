/**
 * Writes a plan.
 *
 * One writer per artifact kind, and a per-artifact try/catch: a single MCP
 * server refused by enterprise policy, or one unwritable file, must not abandon
 * the other nineteen artifacts halfway through.
 *
 * `conflict` and `identical` artifacts are skipped unless the caller asked to
 * overwrite, which is what makes a second run of `/import` a no-op.
 */
import { writeFileSync } from 'fs'
import { dirname } from 'path'

import { addMcpConfig, removeMcpConfig } from 'src/mcp/config.js'
import type { Providers } from 'src/platform/config/config.js'
import { readJson, writeJson, ensureDir, copyTreeWithoutOverwriting } from 'src/platform/import/writers/files.js'
import type {
  ImportArtifact,
  ImportPlan,
  ImportReport,
  ImportScope,
} from 'src/platform/import/types.js'
import { addProviderProfile } from 'src/providers/presets/providerProfiles.js'
import { logError } from 'src/shared/log.js'

export type ApplyOptions = {
  /**
   * Apply artifacts whose status is `conflict` too, replacing what is there.
   * `identical` artifacts are still skipped — rewriting the same bytes is not
   * an overwrite anyone asked for.
   */
  overwriteConflicts?: boolean
}

export type ApplyDeps = {
  writeTextFile: (path: string, contents: string) => void
  copyDirectory: (sourceDir: string, destDir: string) => void
  addMcpServer: (
    name: string,
    config: unknown,
    scope: ImportScope,
    replace: boolean,
  ) => Promise<void>
  setSettingsKey: (settingsPath: string, key: string, value: unknown) => void
  createProviderProfile: (input: {
    name: string
    provider: Providers
    baseUrl: string
    model: string
  }) => void
}

/**
 * A project-scope MCP server is written to this project's PRIVATE config
 * (`local`), not to a shared `.mcp.json` — an import should not add an entry to
 * a file the user is likely to commit.
 */
function mcpScope(scope: ImportScope): 'user' | 'local' {
  return scope === 'user' ? 'user' : 'local'
}

export const defaultApplyDeps: ApplyDeps = {
  writeTextFile: (path, contents) => {
    ensureDir(dirname(path))
    writeFileSync(path, contents, { encoding: 'utf8' })
  },
  copyDirectory: (sourceDir, destDir) => {
    copyTreeWithoutOverwriting(sourceDir, destDir)
  },
  addMcpServer: async (name, config, scope, replace) => {
    if (replace) {
      await removeMcpConfig(name, mcpScope(scope))
    }
    await addMcpConfig(name, config, mcpScope(scope))
  },
  setSettingsKey: (settingsPath, key, value) => {
    const existing = readJson(settingsPath) ?? {}
    ensureDir(dirname(settingsPath))
    writeJson(settingsPath, { ...existing, [key]: value })
  },
  createProviderProfile: input => {
    addProviderProfile(
      {
        provider: input.provider,
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
      },
      { makeActive: false },
    )
  },
}

async function applyOne(
  artifact: ImportArtifact,
  replace: boolean,
  deps: ApplyDeps,
): Promise<void> {
  switch (artifact.kind) {
    case 'mcpServer':
      await deps.addMcpServer(
        artifact.name,
        artifact.config,
        artifact.scope,
        replace,
      )
      return
    case 'instructions':
      deps.writeTextFile(artifact.destination, artifact.text)
      return
    case 'command':
    case 'agent':
    case 'rule':
      deps.writeTextFile(artifact.destination, artifact.markdown)
      return
    case 'skillDir':
      deps.copyDirectory(artifact.sourceDir, artifact.destination)
      return
    case 'settingsKey':
      deps.setSettingsKey(artifact.destination, artifact.key, artifact.value)
      return
    case 'providerHint':
      deps.createProviderProfile({
        name: artifact.name,
        provider: artifact.provider,
        baseUrl: artifact.baseUrl,
        model: artifact.model,
      })
      return
  }
}

export async function applyImportPlan(
  plan: ImportPlan,
  selected: readonly ImportArtifact[],
  options: ApplyOptions = {},
  deps: ApplyDeps = defaultApplyDeps,
): Promise<ImportReport> {
  const report: ImportReport = {
    applied: [],
    skipped: [],
    notImportable: plan.notImportable,
    warnings: [...plan.warnings],
    errors: [],
  }

  for (const artifact of selected) {
    if (artifact.status === 'identical') {
      report.skipped.push({
        ...artifact,
        statusReason: artifact.statusReason ?? 'already identical',
      })
      continue
    }
    const isConflict = artifact.status === 'conflict'
    if (isConflict && !options.overwriteConflicts) {
      report.skipped.push(artifact)
      continue
    }

    try {
      await applyOne(artifact, isConflict, deps)
      report.applied.push(artifact)
    } catch (e: unknown) {
      logError(e)
      report.errors.push(
        `${artifact.kind} ${describeName(artifact)}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  return report
}

function describeName(artifact: ImportArtifact): string {
  if ('name' in artifact) return artifact.name
  if ('key' in artifact) return artifact.key
  return artifact.destination
}
