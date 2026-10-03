/**
 * A throwaway world for the MCP config characterization suites.
 *
 * Every test gets a fresh temp tree:
 *
 *   <root>/home        CLAUDIN_CONFIG_DIR (user settings.json)
 *   <root>/admin       the managed directory (managed-settings.json, managed-mcp.json)
 *   <root>/repo        an outer directory, for the upward .mcp.json walk
 *   <root>/repo/app    the session's directory (cwd and original cwd)
 *   <root>/plugins/*   plugin directories handed over as --plugin-dir
 *
 * The user and local MCP scopes live in the global config, which under
 * NODE_ENV=test is an in-memory singleton: they are written through
 * saveGlobalConfig and saveCurrentProjectConfig, the same doors the CLI uses.
 * The managed directory and the claude.ai fetch are memoized with no input,
 * so their memo is seeded: /etc/claude-code is not ours to write, and the
 * claude.ai listing is a network call behind an OAuth login.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getAllowedSettingSources,
  getCwdState,
  getInlinePlugins,
  getIsInteractive,
  getOriginalCwd,
  setAllowedSettingSources,
  setCwdState,
  setInlinePlugins,
  setIsInteractive,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  resetGlobalConfigForTests,
  resetProjectConfigForTests,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { setMdmSettingsCache } from 'src/platform/settings/mdm/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { clearPluginCache } from 'src/plugins/pluginLoader.js'
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/mcp/claudeai.js'
import { doesEnterpriseMcpConfigExist } from 'src/mcp/config.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

export type Json = Record<string, unknown>

export type World = {
  root: string
  home: string
  admin: string
  outer: string
  project: string
}

const ALL_SOURCES: SettingSource[] = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']
const EMPTY_MDM = { settings: {}, errors: [] }
const OWNED_ENV = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_SYNC_PLUGIN_INSTALL'] as const

type Saved = {
  env: Record<string, string | undefined>
  cwd: string
  originalCwd: string
  sources: SettingSource[]
  plugins: string[]
  interactive: boolean
}

let saved: Saved | null = null
let current: World | null = null

function dropCaches(): void {
  resetSettingsCache()
  doesEnterpriseMcpConfigExist.cache.clear?.()
  clearPluginCache()
}

/** Builds a fresh world and points every path the unit reads at it. */
export function enterWorld(): World {
  saved ??= {
    env: Object.fromEntries(OWNED_ENV.map(key => [key, process.env[key]])),
    cwd: getCwdState(),
    originalCwd: getOriginalCwd(),
    sources: [...getAllowedSettingSources()],
    plugins: [...getInlinePlugins()],
    interactive: getIsInteractive(),
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-config-char-')))
  const world: World = {
    root,
    home: join(root, 'home'),
    admin: join(root, 'admin'),
    outer: join(root, 'repo'),
    project: join(root, 'repo', 'app'),
  }
  for (const dir of [world.home, world.admin, world.project]) mkdirSync(dir, { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = world.home
  delete process.env.CLAUDIN_SYNC_PLUGIN_INSTALL
  setOriginalCwd(world.project)
  setCwdState(world.project)
  setAllowedSettingSources(ALL_SOURCES)
  setInlinePlugins([])
  // An interactive session, so a project server nobody approved stays pending.
  setIsInteractive(true)
  setMdmSettingsCache(EMPTY_MDM, EMPTY_MDM)
  getManagedFilePath.cache.set(undefined, world.admin)
  getManagedSettingsDropInDir.cache.set(undefined, join(world.admin, 'managed-settings.d'))
  serveClaudeAi({})
  wipeUserAndLocal()
  dropCaches()
  current = world
  return world
}

/** Restores everything enterWorld touched and deletes the temp tree. */
export function leaveWorld(): void {
  if (current) rmSync(current.root, { recursive: true, force: true })
  current = null
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  wipeUserAndLocal()
  if (saved) {
    for (const [key, value] of Object.entries(saved.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setCwdState(saved.cwd)
    setOriginalCwd(saved.originalCwd)
    setAllowedSettingSources(saved.sources)
    setInlinePlugins(saved.plugins)
    setIsInteractive(saved.interactive)
  }
  dropCaches()
}

function wipeUserAndLocal(): void {
  saveGlobalConfig(c => ({ ...c, mcpServers: undefined }))
  saveCurrentProjectConfig(c => ({
    ...c,
    mcpServers: undefined,
    enabledMcpServers: undefined,
    disabledMcpServers: undefined,
  }))
  resetGlobalConfigForTests()
  resetProjectConfigForTests()
}

function world(): World {
  if (!current) throw new Error('enterWorld() first')
  return current
}

function writeText(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  dropCaches()
  return path
}

/** Writes `.mcp.json` (raw text or an object) in the project, or in `dir`. */
export function writeMcpJson(content: Json | string, dir = world().project): string {
  return writeText(join(dir, '.mcp.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

/** Writes the admin's `managed-mcp.json`. */
export function writeManagedMcp(content: Json | string): string {
  return writeText(join(world().admin, 'managed-mcp.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

export type SettingsLayer = 'user' | 'project' | 'local' | 'policy'

/** Writes one settings.json layer. */
export function writeSettings(layer: SettingsLayer, content: Json): string {
  const w = world()
  const path = {
    user: join(w.home, 'settings.json'),
    project: join(w.project, '.claudin', 'settings.json'),
    local: join(w.project, '.claudin', 'settings.local.json'),
    policy: join(w.admin, 'managed-settings.json'),
  }[layer]
  return writeText(path, JSON.stringify(content))
}

/** Puts servers in the user scope (the global config). */
export function setUserServers(servers: Json): void {
  saveGlobalConfig(c => ({ ...c, mcpServers: servers as never }))
}

/** Puts servers in the local scope (this project's entry in the global config). */
export function setLocalServers(servers: Json): void {
  saveCurrentProjectConfig(c => ({ ...c, mcpServers: servers as never }))
}

export function userServersOnRecord(): Json | undefined {
  return getGlobalConfig().mcpServers as Json | undefined
}

export function localRecord(): { mcpServers?: Json; enabledMcpServers?: string[]; disabledMcpServers?: string[] } {
  const p = getCurrentProjectConfig()
  return {
    mcpServers: p.mcpServers as Json | undefined,
    enabledMcpServers: p.enabledMcpServers,
    disabledMcpServers: p.disabledMcpServers,
  }
}

export function setToggles(toggles: { enabled?: string[]; disabled?: string[] }): void {
  saveCurrentProjectConfig(c => ({
    ...c,
    enabledMcpServers: toggles.enabled,
    disabledMcpServers: toggles.disabled,
  }))
}

/** Creates a plugin directory whose manifest declares `mcpServers`, and loads it as --plugin-dir. */
export function addPlugin(name: string, mcpServers: Json): string {
  const dir = join(world().root, 'plugins', name)
  writeText(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', mcpServers }))
  setInlinePlugins([...getInlinePlugins(), dir])
  dropCaches()
  return dir
}

/** What the claude.ai connector listing answers for this session. */
export function serveClaudeAi(servers: Record<string, ScopedMcpServerConfig>): void {
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  fetchClaudeAIMcpConfigsIfEligible.cache.set(undefined, Promise.resolve(servers))
}

/** Sets env vars for one test; returns the undo. */
export function withEnv(vars: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
