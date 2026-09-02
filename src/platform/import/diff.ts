/**
 * Decides what each artifact would actually do if applied.
 *
 * This is what makes the preview honest: `new` writes something, `identical`
 * would rewrite the same bytes, and `conflict` would overwrite a value the user
 * already has. Nothing here writes, and every read goes through injected deps
 * so a test can describe the destination state instead of building it.
 */
import { existsSync, readFileSync } from 'fs'
import { basename } from 'path'

import {
  getCurrentProjectConfig,
  getGlobalConfig,
} from 'src/platform/config/config.js'
import { existingProjectInstructionCandidates } from 'src/platform/import/destinations.js'
import { readJson } from 'src/platform/import/writers/files.js'
import type {
  CollectContext,
  ImportArtifact,
  ImportPlan,
  ImportScope,
} from 'src/platform/import/types.js'
import { getProviderProfiles } from 'src/providers/presets/providerProfiles.js'

export type DiffDeps = {
  fileExists: (path: string) => boolean
  readFileIfExists: (path: string) => string | null
  /** Server names already configured in the scope we would write to. */
  mcpServerNames: (scope: ImportScope) => Set<string>
  /** Top-level keys already present in the settings file at this path. */
  settingsKeys: (settingsPath: string) => Set<string>
  providerProfiles: () => ReadonlyArray<{ baseUrl: string; model: string }>
}

export const defaultDiffDeps: DiffDeps = {
  fileExists: existsSync,
  readFileIfExists: path => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  mcpServerNames: scope =>
    new Set(
      Object.keys(
        (scope === 'user'
          ? getGlobalConfig().mcpServers
          : getCurrentProjectConfig().mcpServers) ?? {},
      ),
    ),
  settingsKeys: settingsPath => new Set(Object.keys(readJson(settingsPath) ?? {})),
  providerProfiles: () =>
    getProviderProfiles().map(profile => ({
      baseUrl: profile.baseUrl,
      model: profile.model,
    })),
}

function markOne(
  artifact: ImportArtifact,
  ctx: CollectContext,
  deps: DiffDeps,
): ImportArtifact {
  // A collision between two selected agents was already resolved in collect();
  // re-deciding it here would lose the reason naming the winner.
  if (artifact.status === 'conflict') return artifact

  switch (artifact.kind) {
    case 'mcpServer': {
      if (!deps.mcpServerNames(artifact.scope).has(artifact.name)) {
        return artifact
      }
      return {
        ...artifact,
        status: 'conflict',
        statusReason: `an MCP server called "${artifact.name}" is already configured — see /mcp`,
      }
    }

    case 'instructions': {
      // At project scope the question is not "does the destination exist" but
      // "does this project already have instructions", since AGENTS.md and
      // CLAUDE.md are two spellings of one thing.
      const candidates =
        artifact.scope === 'project'
          ? existingProjectInstructionCandidates(ctx)
          : [artifact.destination]
      const existing = candidates.find(deps.fileExists)
      if (!existing) return artifact
      if (deps.readFileIfExists(existing) === artifact.text) {
        return { ...artifact, status: 'identical' }
      }
      return {
        ...artifact,
        status: 'conflict',
        statusReason: `${basename(existing)} already exists here`,
      }
    }

    case 'command':
    case 'agent':
    case 'rule': {
      if (!deps.fileExists(artifact.destination)) return artifact
      if (deps.readFileIfExists(artifact.destination) === artifact.markdown) {
        return { ...artifact, status: 'identical' }
      }
      return {
        ...artifact,
        status: 'conflict',
        statusReason: `${basename(artifact.destination)} already exists`,
      }
    }

    case 'skillDir': {
      if (!deps.fileExists(artifact.destination)) return artifact
      return {
        ...artifact,
        status: 'conflict',
        statusReason: `a skill called "${artifact.name}" already exists`,
      }
    }

    case 'settingsKey': {
      if (!deps.settingsKeys(artifact.destination).has(artifact.key)) {
        return artifact
      }
      return {
        ...artifact,
        status: 'conflict',
        statusReason: `"${artifact.key}" is already set — see /config`,
      }
    }

    case 'providerHint': {
      const match = deps
        .providerProfiles()
        .some(
          profile =>
            profile.baseUrl === artifact.baseUrl &&
            profile.model === artifact.model,
        )
      if (!match) return artifact
      return {
        ...artifact,
        status: 'identical',
        statusReason: 'a provider profile with this base URL and model exists',
      }
    }
  }
}

export function markStatuses(
  plan: ImportPlan,
  ctx: CollectContext,
  deps: DiffDeps = defaultDiffDeps,
): ImportPlan {
  return {
    ...plan,
    artifacts: plan.artifacts.map(artifact => markOne(artifact, ctx, deps)),
  }
}
