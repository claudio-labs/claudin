import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import {
  _setGlobalConfigCacheForTesting,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { getClaudioConfigHomeDir } from './envUtils.js'
import {
  addProviderProfile,
  getProviderPresetDefaults,
  getProviderProfiles,
  type ProviderProfileInput,
} from './providerProfiles.js'

export type MigrationReport = {
  tokens: number
  settingsKeys: number
  globalConfigKeys: number
  claudeMd: boolean
  plugins: number
  skills: number
  agents: number
  commands: number
  keybindings: boolean
  anthropicProfileCreated: boolean
  errors: string[]
  warnings: string[]
  alreadyMigrated: boolean
  legacyDir: string
  newDir: string
  migratedAt?: string
}

// settings.json keys we forward from ~/.claude/settings.json to ~/.claudio/settings.json.
// agentRouting / agentModels are intentionally excluded — they're part of the
// legacy single-provider routing system that the new providerProfiles[] flow
// replaces.
const SETTINGS_WHITELIST = [
  'theme',
  'model',
  'customApiKeyResponses',
  'permissions',
  'verbose',
  'editorMode',
  'mcpServers',
  'providerProfiles',
  'activeProviderProfileId',
] as const

type AnyJson = Record<string, unknown>

function legacyClaudeDir(home: string): string {
  return join(home, '.claude')
}

function readJson(path: string): AnyJson | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AnyJson
    }
    return null
  } catch {
    return null
  }
}

function writeJson(path: string, data: AnyJson): void {
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf8' })
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
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
      // has live credentials in ~/.claudio — respect them, but surface a
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

function copyClaudeMd(
  legacyDir: string,
  newDir: string,
  errors: string[],
): boolean {
  const src = join(legacyDir, 'CLAUDE.md')
  const dst = join(newDir, 'CLAUDE.md')
  if (!existsSync(src)) return false
  if (existsSync(dst)) return false
  try {
    ensureDir(newDir)
    const buf = readFileSync(src)
    writeFileSync(dst, buf)
    return true
  } catch (e: unknown) {
    errors.push(
      `failed to copy CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }
}

function copyKeybindings(
  legacyDir: string,
  newDir: string,
  errors: string[],
): boolean {
  const src = join(legacyDir, 'keybindings.json')
  const dst = join(newDir, 'keybindings.json')
  if (!existsSync(src)) return false
  if (existsSync(dst)) return false
  try {
    ensureDir(newDir)
    const buf = readFileSync(src)
    writeFileSync(dst, buf)
    return true
  } catch (e: unknown) {
    errors.push(
      `failed to copy keybindings.json: ${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }
}

function copyTopLevelDir(
  legacyDir: string,
  newDir: string,
  name: string,
  errors: string[],
): number {
  const src = join(legacyDir, name)
  const dst = join(newDir, name)
  if (!existsSync(src)) return 0
  let copied = 0
  try {
    if (!statSync(src).isDirectory()) return 0
    ensureDir(newDir)
    cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
    copied = countTopLevelEntries(dst)
  } catch (e: unknown) {
    errors.push(
      `failed to copy ${name}/: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return copied
}

function countTopLevelEntries(dir: string): number {
  try {
    if (!existsSync(dir)) return 0
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

function mergeSettings(
  legacyDir: string,
  newDir: string,
  errors: string[],
): number {
  const src = join(legacyDir, 'settings.json')
  if (!existsSync(src)) return 0

  const legacy = readJson(src)
  if (!legacy) {
    errors.push('legacy settings.json could not be parsed; skipped')
    return 0
  }

  const dst = join(newDir, 'settings.json')
  const existing = existsSync(dst) ? (readJson(dst) ?? {}) : {}

  const merged: AnyJson = { ...existing }
  let copiedKeys = 0
  for (const key of SETTINGS_WHITELIST) {
    if (!(key in legacy)) continue
    if (key in existing) continue // non-destructive: existing wins
    merged[key] = legacy[key]
    copiedKeys += 1
  }

  if (copiedKeys === 0 && existsSync(dst)) {
    return 0
  }

  try {
    ensureDir(newDir)
    writeJson(dst, merged)
  } catch (e: unknown) {
    errors.push(
      `failed to write settings.json: ${e instanceof Error ? e.message : String(e)}`,
    )
    return 0
  }

  return copiedKeys
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
  if (!existsSync(src)) return 0

  const legacy = readJson(src)
  if (!legacy) {
    warnings.push(`legacy ${src} could not be parsed; skipped`)
    return 0
  }

  const dst = newGlobalConfigPath(newDir)
  const existing = existsSync(dst) ? (readJson(dst) ?? {}) : {}

  const merged: AnyJson = { ...existing }
  let copiedKeys = 0
  for (const key of Object.keys(legacy)) {
    if (key in existing) continue
    merged[key] = legacy[key]
    copiedKeys += 1
  }

  if (copiedKeys === 0 && existsSync(dst)) {
    return 0
  }

  try {
    writeJson(dst, merged)
  } catch (e: unknown) {
    warnings.push(
      `failed to write ${dst}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return 0
  }

  // Invalidate the in-memory globalConfig cache so the next read picks up
  // the freshly merged file (in particular, any providerProfiles imported
  // from the legacy global config land in saveGlobalConfig's lock-acquired
  // re-read instead of the stale defaults populated by isAlreadyMigrated).
  _setGlobalConfigCacheForTesting(null)
  return copiedKeys
}

function isAlreadyMigrated(): { migrated: boolean; at?: string } {
  const config = getGlobalConfig()
  const current = config.claudeToClaudioMigratedAt
  if (typeof current === 'string' && current.length > 0) {
    return { migrated: true, at: current }
  }
  return { migrated: false }
}

function markMigrated(at: string): void {
  saveGlobalConfig(prev => ({ ...prev, claudeToClaudioMigratedAt: at }))
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
  const newDir = options.newDir ?? getClaudioConfigHomeDir()

  const errors: string[] = []
  const warnings: string[] = []
  const report: MigrationReport = {
    tokens: 0,
    settingsKeys: 0,
    globalConfigKeys: 0,
    claudeMd: false,
    plugins: 0,
    skills: 0,
    agents: 0,
    commands: 0,
    keybindings: false,
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
    report.claudeMd = copyClaudeMd(legacyDir, newDir, errors)
    report.plugins = copyTopLevelDir(legacyDir, newDir, 'plugins', errors)
    report.skills = copyTopLevelDir(legacyDir, newDir, 'skills', errors)
    report.agents = copyTopLevelDir(legacyDir, newDir, 'agents', errors)
    report.commands = copyTopLevelDir(legacyDir, newDir, 'commands', errors)
    report.keybindings = copyKeybindings(legacyDir, newDir, errors)
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
  let parsed: AnyJson | null
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'))
  } catch (e: unknown) {
    warnings.push(
      `failed to read migrated .credentials.json for profile bootstrap: ${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }

  const claudeAiOauth = (parsed as AnyJson | null)?.claudeAiOauth as
    | AnyJson
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
  parts.push(`${report.claudeMd ? 1 : 0} CLAUDE.md`)
  parts.push(`${report.plugins} plugin${report.plugins === 1 ? '' : 's'}`)
  parts.push(`${report.skills} skill${report.skills === 1 ? '' : 's'}`)
  parts.push(`${report.agents} agent${report.agents === 1 ? '' : 's'}`)
  parts.push(`${report.commands} command${report.commands === 1 ? '' : 's'}`)
  parts.push(`${report.keybindings ? 'keybindings copied' : 'no keybindings'}`)
  parts.push(
    report.anthropicProfileCreated
      ? 'anthropic profile created'
      : 'anthropic profile already present',
  )
  const head = parts.join(', ')
  const suffix = `. ${report.legacyDir} kept untouched.`
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
  if (config.claudeToClaudioMigratedAt) return false
  if (config.legacyMigrationSkipped === true) return false
  return legacyClaudeDirExists(home) || legacyGlobalConfigExists(home)
}

export function markMigrationSkipped(): void {
  saveGlobalConfig(prev => ({ ...prev, legacyMigrationSkipped: true }))
}
