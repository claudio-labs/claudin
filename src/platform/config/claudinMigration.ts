import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { fileSuffixForOauthConfig } from 'src/shared/constants/oauth.js'
import {
  _setGlobalConfigCacheForTesting,
  getGlobalConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import type { JsonTable } from 'src/platform/import/translate/values.js'
import { ensureDir } from 'src/platform/import/writers/files.js'
import { mergeJsonFileNonDestructive } from 'src/platform/import/writers/settings.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import {
  addProviderProfile,
  getProviderPresetDefaults,
  getProviderProfiles,
  type ProviderProfileInput,
} from 'src/providers/presets/providerProfiles.js'

export type MigrationReport = {
  tokens: number
  settingsKeys: number
  globalConfigKeys: number
  anthropicProfileCreated: boolean
  errors: string[]
  warnings: string[]
  alreadyMigrated: boolean
  legacyDir: string
  newDir: string
  migratedAt?: string
}

// settings.json keys we forward from ~/.claude/settings.json to
// ~/.claudin/settings.json. All three are provider sign-in material: the saved
// profiles and the pointer at the active one, plus the record of which API keys
// the user already approved (without it they get re-prompted for a key they
// just migrated). Everything this list used to carry — theme, model,
// permissions, verbose, editorMode, mcpServers — is `/import`'s job now, along
// with CLAUDE.md, skills, agents, commands and plugins. agentRouting /
// agentModels were never forwarded: they belong to the legacy single-provider
// routing system that providerProfiles[] replaces.
const SETTINGS_WHITELIST = [
  'customApiKeyResponses',
  'providerProfiles',
  'activeProviderProfileId',
] as const

function legacyClaudeDir(home: string): string {
  return join(home, '.claude')
}

function copyCredentialsIfNeeded(
  legacyDir: string,
  newDir: string,
  errors: string[],
  warnings: string[],
): number {
  const src = join(legacyDir, '.credentials.json')
  const dst = join(newDir, '.credentials.json')
  if (!existsSync(src)) return 0
  try {
    if (existsSync(dst)) {
      const srcRaw = readFileSync(src)
      const dstRaw = readFileSync(dst)
      if (srcRaw.equals(dstRaw)) {
        chmodSync(dst, 0o600)
        return 0
      }
      // dst already has different contents; do not clobber. Caller already
      // has live credentials in ~/.claudin — respect them, but surface a
      // warning so the user knows the legacy file was kept untouched.
      warnings.push(
        `${dst} already exists with different content — kept new file untouched`,
      )
      return 0
    }
    ensureDir(newDir)
    const buf = readFileSync(src)
    writeFileSync(dst, buf)
    chmodSync(dst, 0o600)
    return countCredentialTokens(buf)
  } catch (e: unknown) {
    errors.push(
      `failed to copy .credentials.json: ${e instanceof Error ? e.message : String(e)}`,
    )
    return 0
  }
}

function countCredentialTokens(buf: Buffer): number {
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed).length
    }
  } catch {
    // not JSON — treat as single opaque token blob
  }
  return 1
}

function mergeSettings(
  legacyDir: string,
  newDir: string,
  errors: string[],
): number {
  const result = mergeJsonFileNonDestructive(
    join(legacyDir, 'settings.json'),
    join(newDir, 'settings.json'),
    { keys: SETTINGS_WHITELIST },
  )
  if (result.outcome === 'unparseableSource') {
    errors.push('legacy settings.json could not be parsed; skipped')
  } else if (result.outcome === 'writeFailed') {
    errors.push(`failed to write settings.json: ${result.message}`)
  }
  return result.copiedKeys
}

function legacyGlobalConfigPath(home: string): string {
  return join(home, `.claude${fileSuffixForOauthConfig()}.json`)
}

function newGlobalConfigPath(newDir: string): string {
  return join(newDir, `config${fileSuffixForOauthConfig()}.json`)
}

function mergeGlobalConfigFile(
  home: string,
  newDir: string,
  warnings: string[],
): number {
  const src = legacyGlobalConfigPath(home)
  const dst = newGlobalConfigPath(newDir)
  const result = mergeJsonFileNonDestructive(src, dst)
  if (result.outcome === 'unparseableSource') {
    warnings.push(`legacy ${src} could not be parsed; skipped`)
    return 0
  }
  if (result.outcome === 'writeFailed') {
    warnings.push(`failed to write ${dst}: ${result.message}`)
    return 0
  }
  if (result.outcome === 'noSource') return 0

  // Invalidate the in-memory globalConfig cache so the next read picks up
  // the freshly merged file (in particular, any providerProfiles imported
  // from the legacy global config land in saveGlobalConfig's lock-acquired
  // re-read instead of the stale defaults populated by isAlreadyMigrated).
  _setGlobalConfigCacheForTesting(null)
  return result.copiedKeys
}

function isAlreadyMigrated(): { migrated: boolean; at?: string } {
  const config = getGlobalConfig()
  const current = config.claudeToClaudinMigratedAt
  if (typeof current === 'string' && current.length > 0) {
    return { migrated: true, at: current }
  }
  return { migrated: false }
}

function markMigrated(at: string): void {
  saveGlobalConfig(prev => ({ ...prev, claudeToClaudinMigratedAt: at }))
}

export type MigrationOptions = {
  homeDir?: string
  newDir?: string
  force?: boolean
}

export async function migrateLegacyClaudeDir(
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const home = options.homeDir ?? homedir()
  const legacyDir = legacyClaudeDir(home)
  const newDir = options.newDir ?? getClaudinConfigHomeDir()

  const errors: string[] = []
  const warnings: string[] = []
  const report: MigrationReport = {
    tokens: 0,
    settingsKeys: 0,
    globalConfigKeys: 0,
    anthropicProfileCreated: false,
    errors,
    warnings,
    alreadyMigrated: false,
    legacyDir,
    newDir,
  }

  const legacyGlobalConfigExists = existsSync(legacyGlobalConfigPath(home))
  if (!existsSync(legacyDir) && !legacyGlobalConfigExists) {
    return report
  }

  const status = isAlreadyMigrated()
  if (status.migrated && !options.force) {
    report.alreadyMigrated = true
    report.migratedAt = status.at
    return report
  }

  try {
    ensureDir(newDir)
  } catch (e: unknown) {
    errors.push(
      `failed to create ${newDir}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return report
  }

  if (existsSync(legacyDir)) {
    report.tokens = copyCredentialsIfNeeded(legacyDir, newDir, errors, warnings)
    report.settingsKeys = mergeSettings(legacyDir, newDir, errors)
  }

  report.globalConfigKeys = mergeGlobalConfigFile(home, newDir, warnings)
  report.anthropicProfileCreated = ensureAnthropicProfileFromCredentials(
    newDir,
    report.tokens,
    warnings,
  )

  if (errors.length === 0) {
    const at = new Date().toISOString()
    markMigrated(at)
    report.migratedAt = at
  }

  return report
}

function ensureAnthropicProfileFromCredentials(
  newDir: string,
  tokensCopied: number,
  warnings: string[],
): boolean {
  if (tokensCopied <= 0) return false

  const credentialsPath = join(newDir, '.credentials.json')
  let parsed: JsonTable | null
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'))
  } catch (e: unknown) {
    warnings.push(
      `failed to read migrated .credentials.json for profile bootstrap: ${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }

  const claudeAiOauth = (parsed as JsonTable | null)?.claudeAiOauth as
    | JsonTable
    | undefined
  const accessToken = claudeAiOauth?.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return false
  }

  const existingProfiles = getProviderProfiles()
  if (existingProfiles.some(p => p.provider === 'anthropic')) {
    return false
  }

  const defaults = getProviderPresetDefaults('anthropic')
  const payload: ProviderProfileInput = {
    provider: 'anthropic',
    name: defaults.name,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
  }

  try {
    const saved = addProviderProfile(payload, {
      makeActive: existingProfiles.length === 0,
    })
    if (!saved) {
      warnings.push('anthropic profile could not be saved after migration')
      return false
    }
    return true
  } catch (e: unknown) {
    warnings.push(
      `failed to create anthropic profile: ${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }
}

export function formatMigrationReport(report: MigrationReport): string {
  if (report.alreadyMigrated) {
    return `nothing to do (last run: ${report.migratedAt ?? 'unknown'}). Pass --force to re-run.`
  }
  const parts: string[] = []
  parts.push(`${report.tokens} token${report.tokens === 1 ? '' : 's'}`)
  parts.push(
    `${report.settingsKeys} settings key${report.settingsKeys === 1 ? '' : 's'}`,
  )
  parts.push(
    `${report.globalConfigKeys} global config key${report.globalConfigKeys === 1 ? '' : 's'}`,
  )
  parts.push(
    report.anthropicProfileCreated
      ? 'anthropic profile created'
      : 'anthropic profile already present',
  )
  const head = parts.join(', ')
  const suffix = `. ${report.legacyDir} kept untouched. Run /import to bring skills, MCP servers, agents and commands.`
  let summary = `${head}${suffix}`
  if (report.warnings.length > 0) {
    summary += ` Warnings: ${report.warnings.join('; ')}`
  }
  if (report.errors.length > 0) {
    summary += ` Errors: ${report.errors.join('; ')}`
  }
  return summary
}

export function legacyClaudeDirExists(home: string = homedir()): boolean {
  return existsSync(legacyClaudeDir(home))
}

export function legacyGlobalConfigExists(home: string = homedir()): boolean {
  return existsSync(legacyGlobalConfigPath(home))
}

export function shouldShowMigrationBanner(home: string = homedir()): boolean {
  const config = getGlobalConfig()
  if (config.claudeToClaudinMigratedAt) return false
  if (config.legacyMigrationSkipped === true) return false
  return legacyClaudeDirExists(home) || legacyGlobalConfigExists(home)
}

export function markMigrationSkipped(): void {
  saveGlobalConfig(prev => ({ ...prev, legacyMigrationSkipped: true }))
}
