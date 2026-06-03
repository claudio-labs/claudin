import axios from 'axios'
import { unzip } from 'fflate'
import { createWriteStream } from 'fs'
import { access, chmod, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { createGunzip } from 'zlib'
import { logError } from '../../utils/log.js'
import { getClaudinConfigHomeDir } from '../../utils/envUtils.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { reinitializeLspServerManager } from './manager.js'
import { getUserLspSettings, isLspGloballyEnabled } from './userSettings.js'
import type { LspServerConfig, ScopedLspServerConfig } from './types.js'

const WHICH_TIMEOUT_MS = 5_000
const IN_PROGRESS_STALE_MS = 30 * 60_000
const FAILED_COOLDOWN_MS = 7 * 24 * 3_600_000
const VERSION_CACHE_TTL_MS = 24 * 3_600_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// exported for testing
export async function whichBinary(name: string): Promise<string | null> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const result = await execFileNoThrowWithCwd(whichCmd, [name], { timeout: WHICH_TIMEOUT_MS })
  return result.code === 0 ? (result.stdout.trim() || null) : null
}

function lspDir(name: string): string {
  return join(getClaudinConfigHomeDir(), 'lsp', name)
}

// ---------------------------------------------------------------------------
// InstallStatus persistence (anti-loop guard)
// ---------------------------------------------------------------------------

type InstallStatus = {
  status: 'in-progress' | 'failed'
  attemptedAt: number
  error?: string
}

async function readInstallStatus(file: string): Promise<InstallStatus | null> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as InstallStatus
  } catch {
    return null
  }
}

async function writeInstallStatus(file: string, status: InstallStatus): Promise<void> {
  try {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(status), 'utf8')
  } catch (err) {
    logError(new Error(`LSP: failed to write install status ${file}: ${String(err)}`))
  }
}

// ---------------------------------------------------------------------------
// Version cache for GitHub downloads
// ---------------------------------------------------------------------------

type VersionCache = { checkedAt: number; tag: string }

async function readVersionCache(file: string): Promise<VersionCache | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as VersionCache
  } catch {
    return null
  }
}

async function writeVersionCache(file: string, cache: VersionCache): Promise<void> {
  try {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(cache), 'utf8')
  } catch {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// GitHub Release helpers
// ---------------------------------------------------------------------------

type GitHubAsset = { name: string; browser_download_url: string }
type GitHubRelease = { tag_name: string; assets: GitHubAsset[] }

async function fetchGitHubRelease(owner: string, repo: string): Promise<GitHubRelease | null> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
    const resp = await axios.get<GitHubRelease>(url, {
      headers: { Accept: 'application/vnd.github+json' },
      timeout: 30_000,
    })
    return resp.data
  } catch (err) {
    logError(new Error(`LSP: failed to fetch GitHub release ${owner}/${repo}: ${String(err)}`))
    return null
  }
}

// ---------------------------------------------------------------------------
// Off-main-thread zip extraction
// ---------------------------------------------------------------------------
//
// fflate.unzip (the async variant) ships its decompression core into a real
// worker_thread under the hood — see node_modules/fflate/lib/node-worker.cjs.
// Calling it instead of unzipSync moves the inflate CPU work off the Ink
// render loop, which fixes the multi-second freeze first-launch users were
// hitting when clangd / kotlin-language-server zips landed.

type UnzippedFiles = Record<string, Uint8Array>

async function unzipOffThread(buf: Uint8Array): Promise<UnzippedFiles> {
  return await new Promise<UnzippedFiles>((resolve, reject) => {
    unzip(buf, (err, files) => {
      if (err) reject(err)
      else resolve(files)
    })
  })
}

async function downloadAndExtract(
  assetUrl: string,
  destPath: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<boolean> {
  try {
    await mkdir(join(destPath, '..'), { recursive: true })

    if (assetUrl.endsWith('.gz') && !assetUrl.endsWith('.tar.gz')) {
      // Stream HTTP body -> gunzip -> destination file. Avoids buffering the
      // entire archive in memory and keeps decompression off the main loop's
      // synchronous path.
      const resp = await axios.get(assetUrl, {
        responseType: 'stream',
        timeout: 120_000,
        onDownloadProgress: onProgress
          ? (e) => { if (e.total) onProgress({ phase: 'download', pct: Math.round((e.loaded / e.total) * 100) }) }
          : undefined,
      })
      onProgress?.({ phase: 'extract' })
      await pipeline(resp.data, createGunzip(), createWriteStream(destPath))
      await chmod(destPath, 0o755)
      return true
    }

    if (assetUrl.endsWith('.zip')) {
      const resp = await axios.get<ArrayBuffer>(assetUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        onDownloadProgress: onProgress
          ? (e) => { if (e.total) onProgress({ phase: 'download', pct: Math.round((e.loaded / e.total) * 100) }) }
          : undefined,
      })
      const buf = new Uint8Array(resp.data)
      // Decompress off the main thread so Ink can keep redrawing while
      // clangd / other large zips inflate.
      onProgress?.({ phase: 'extract' })
      const files = await unzipOffThread(buf)
      const binName = destPath.split('/').at(-1)!
      const entry =
        files[binName] ??
        files[`${binName}.exe`] ??
        Object.entries(files).find(([name]) => name.endsWith(binName) || name.endsWith(`${binName}.exe`))?.[1]
      if (!entry) {
        logError(new Error(`LSP: no matching binary in zip from ${assetUrl}`))
        return false
      }
      await writeFile(destPath, entry)
      await chmod(destPath, 0o755)
      return true
    }

    if (assetUrl.endsWith('.tar.gz') || assetUrl.endsWith('.tgz')) {
      // tar.gz: download to disk, extract with system tar (available on
      // Linux/macOS). tar extracts into the parent directory, so destPath
      // is not a file after this — skip the chmod which would target the
      // directory.
      const resp = await axios.get(assetUrl, {
        responseType: 'stream',
        timeout: 120_000,
        onDownloadProgress: onProgress
          ? (e) => { if (e.total) onProgress({ phase: 'download', pct: Math.round((e.loaded / e.total) * 100) }) }
          : undefined,
      })
      const tmpTarGz = `${destPath}.tar.gz`
      onProgress?.({ phase: 'extract' })
      await pipeline(resp.data, createWriteStream(tmpTarGz))
      const extractResult = await execFileNoThrowWithCwd(
        'tar',
        ['xzf', tmpTarGz, '-C', join(destPath, '..'), '--strip-components=1'],
        { timeout: 60_000 },
      )
      await unlink(tmpTarGz).catch(() => undefined)
      if (extractResult.code !== 0) {
        logError(new Error(`LSP: tar extraction failed: ${extractResult.stderr}`))
        return false
      }
      return true // tar preserves permissions; no chmod needed here
    }

    // Unknown archive type: write the body to disk verbatim.
    const resp = await axios.get<ArrayBuffer>(assetUrl, { responseType: 'arraybuffer', timeout: 120_000 })
    await writeFile(destPath, new Uint8Array(resp.data))
    await chmod(destPath, 0o755)
    return true
  } catch (err) {
    logError(new Error(`LSP: download/extract failed from ${assetUrl}: ${String(err)}`))
    await unlink(destPath).catch(() => undefined)
    return false
  }
}

// ---------------------------------------------------------------------------
// LspInstaller interface + factories
// ---------------------------------------------------------------------------

interface LspInstaller {
  readonly type: string
  install(onProgress?: (p: InstallProgress) => void): Promise<string | null>
}

function npm(packageName: string, binaryOverride?: string): LspInstaller {
  return {
    type: 'npm',
    async install(onProgress?: (p: InstallProgress) => void): Promise<string | null> {
      onProgress?.({ phase: 'download', pct: 0 })
      const result = await execFileNoThrowWithCwd(
        'npm',
        ['install', '-g', packageName],
        { cwd: homedir(), timeout: 120_000 },
      )
      if (result.code !== 0) {
        logError(new Error(`LSP: npm install -g ${packageName} failed: ${result.stderr}`))
        return null
      }
      // Explicit override takes precedence; for scoped packages fall back to last segment
      const binaryName =
        binaryOverride ?? (packageName.startsWith('@') ? packageName.split('/')[1]! : packageName)
      return whichBinary(binaryName)
    },
  }
}

type GitHubReleaseSpec = {
  owner: string
  repo: string
  binaryName: string
  getAssetUrl(assets: GitHubAsset[], platform: NodeJS.Platform, arch: string): string | null
  extractAll?: true
  resolveInstalledPath?: (destDir: string) => string
}

async function downloadAndExtractAll(
  assetUrl: string,
  destDir: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<boolean> {
  try {
    await mkdir(destDir, { recursive: true })
    if (!assetUrl.endsWith('.zip')) {
      logError(new Error(`LSP: extractAll only supports .zip archives, got ${assetUrl}`))
      return false
    }
    const resp = await axios.get<ArrayBuffer>(assetUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      onDownloadProgress: onProgress
        ? (e) => { if (e.total) onProgress({ phase: 'download', pct: Math.round((e.loaded / e.total) * 100) }) }
        : undefined,
    })
    const buf = new Uint8Array(resp.data)
    // Decompress off the main thread; kotlin-language-server's server.zip is
    // sizeable and sync inflation freezes Ink for noticeable windows.
    onProgress?.({ phase: 'extract' })
    const files = await unzipOffThread(buf)
    for (const [name, data] of Object.entries(files)) {
      const outPath = join(destDir, name)
      await mkdir(join(outPath, '..'), { recursive: true })
      await writeFile(outPath, data)
      if (!name.endsWith('/')) {
        await chmod(outPath, 0o755)
      }
    }
    return true
  } catch (err) {
    logError(new Error(`LSP: extractAll failed from ${assetUrl}: ${String(err)}`))
    return false
  }
}

function githubRelease(spec: GitHubReleaseSpec): LspInstaller {
  return {
    type: 'github-release',
    async install(onProgress?: (p: InstallProgress) => void): Promise<string | null> {
      const dest = lspDir(spec.binaryName)
      const binPath = spec.resolveInstalledPath ? spec.resolveInstalledPath(dest) : join(dest, spec.binaryName)
      const cacheFile = join(dest, '.version-cache.json')

      const cached = await readVersionCache(cacheFile)
      if (cached && Date.now() - cached.checkedAt < VERSION_CACHE_TTL_MS) {
        try {
          await access(binPath)
          return binPath
        } catch {
          // cache valid but binary gone — re-download
        }
      }

      const release = await fetchGitHubRelease(spec.owner, spec.repo)
      if (!release) return null

      const assetUrl = spec.getAssetUrl(release.assets, process.platform, process.arch)
      if (!assetUrl) {
        logError(new Error(`LSP: no ${spec.binaryName} asset for ${process.platform}/${process.arch}`))
        return null
      }

      const ok = spec.extractAll
        ? await downloadAndExtractAll(assetUrl, dest, onProgress)
        : await downloadAndExtract(assetUrl, binPath, onProgress)
      if (!ok) return null

      await writeVersionCache(cacheFile, { checkedAt: Date.now(), tag: release.tag_name })
      return binPath
    },
  }
}

function goInstall(module: string): LspInstaller {
  return {
    type: 'go-install',
    async install(onProgress?: (p: InstallProgress) => void): Promise<string | null> {
      onProgress?.({ phase: 'download', pct: 0 })
      const go = await whichBinary('go')
      if (!go) return null
      const result = await execFileNoThrowWithCwd(
        'go',
        ['install', `${module}@latest`],
        { cwd: homedir(), timeout: 120_000 },
      )
      if (result.code !== 0) {
        logError(new Error(`LSP: go install ${module}@latest failed: ${result.stderr}`))
        return null
      }
      const binaryName = module.split('/').at(-1) ?? module
      return whichBinary(binaryName)
    },
  }
}

// ---------------------------------------------------------------------------
// BuiltinServerDef + defineServer
// ---------------------------------------------------------------------------

type BuiltinServerDef = {
  readonly name: string
  readonly binary: string
  readonly extensionToLanguage: Record<string, string>
  readonly installer?: LspInstaller
  toConfig(bin: string): LspServerConfig
}

function defineServer(opts: {
  name: string
  binary: string
  extensionToLanguage: Record<string, string>
  installer?: LspInstaller
  toConfig(bin: string): Omit<LspServerConfig, 'extensionToLanguage'>
}): BuiltinServerDef {
  return {
    name: opts.name,
    binary: opts.binary,
    extensionToLanguage: opts.extensionToLanguage,
    installer: opts.installer,
    toConfig: (bin) => ({
      ...opts.toConfig(bin),
      extensionToLanguage: opts.extensionToLanguage,
    }),
  }
}

// Asset URL helpers per platform
function rustAnalyzerAsset(assets: GitHubAsset[], platform: NodeJS.Platform, arch: string): string | null {
  const osMap: Partial<Record<NodeJS.Platform, string>> = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
  const os = osMap[platform]
  const cpu = archMap[arch]
  if (!os || !cpu) return null
  const suffix = '.gz' // all platforms ship .gz archives
  const name = `rust-analyzer-${cpu}-${os}${suffix}`
  return assets.find(a => a.name === name)?.browser_download_url ?? null
}

function clangdAsset(assets: GitHubAsset[], platform: NodeJS.Platform, _arch: string): string | null {
  const osMap: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'mac', win32: 'windows' }
  const os = osMap[platform]
  if (!os) return null
  return assets.find(a => a.name.startsWith(`clangd-${os}`) && a.name.endsWith('.zip'))?.browser_download_url ?? null
}

function taploAsset(assets: GitHubAsset[], platform: NodeJS.Platform, arch: string): string | null {
  const osMap: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'darwin', win32: 'windows' }
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
  const os = osMap[platform]
  const cpu = archMap[arch]
  if (!os || !cpu) return null
  return assets.find(a => a.name.startsWith(`taplo-${os}-${cpu}`))?.browser_download_url ?? null
}

function omnisharpAsset(assets: GitHubAsset[], platform: NodeJS.Platform, arch: string): string | null {
  const osMap: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'osx', win32: 'win' }
  const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64' }
  const os = osMap[platform]
  const cpu = archMap[arch]
  if (!os || !cpu) return null
  const ext = platform === 'win32' ? '.zip' : '.tar.gz'
  return assets.find(a => a.name.includes(`${os}-${cpu}`) && a.name.endsWith(ext))?.browser_download_url ?? null
}

// ---------------------------------------------------------------------------
// JVM-based server detection helpers (jdtls + kotlin-language-server)
// ---------------------------------------------------------------------------

async function findJdtlsJar(jdtlsDir: string): Promise<string | null> {
  try {
    const pluginsDir = join(jdtlsDir, 'plugins')
    const entries = await readdir(pluginsDir)
    const matches = entries
      .filter(e => e.startsWith('org.eclipse.equinox.launcher_') && e.endsWith('.jar'))
      .sort()
    if (matches.length === 0) return null
    return join(pluginsDir, matches.at(-1)!)
  } catch {
    return null
  }
}

async function findKotlinLsBinary(kotlinDir: string): Promise<string | null> {
  // kotlin-language-server ships a launcher script at server/bin/, not a jar
  const binPath = join(kotlinDir, 'server', 'bin', 'kotlin-language-server')
  try {
    await access(binPath)
    return binPath
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 12 built-in server definitions
// ---------------------------------------------------------------------------

const SERVER_DEFINITIONS: BuiltinServerDef[] = [
  defineServer({
    name: 'typescript-language-server',
    binary: 'typescript-language-server',
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' },
    installer: npm('typescript-language-server'),
    toConfig: (bin) => ({ command: bin, args: ['--stdio'] }),
  }),

  defineServer({
    name: 'rust-analyzer',
    binary: 'rust-analyzer',
    extensionToLanguage: { '.rs': 'rust' },
    installer: githubRelease({
      owner: 'rust-lang',
      repo: 'rust-analyzer',
      binaryName: 'rust-analyzer',
      getAssetUrl: rustAnalyzerAsset,
    }),
    toConfig: (bin) => ({ command: bin, args: [] }),
  }),

  defineServer({
    name: 'pyright',
    binary: 'pyright-langserver',
    extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
    installer: npm('pyright', 'pyright-langserver'),
    toConfig: (bin) => ({ command: bin, args: ['--stdio'] }),
  }),

  defineServer({
    name: 'gopls',
    binary: 'gopls',
    extensionToLanguage: { '.go': 'go' },
    installer: goInstall('golang.org/x/tools/gopls'),
    toConfig: (bin) => ({ command: bin, args: [] }),
  }),

  defineServer({
    name: 'biome',
    binary: 'biome',
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.json': 'json', '.jsonc': 'jsonc' },
    installer: npm('@biomejs/biome'),
    toConfig: (bin) => ({ command: bin, args: ['lsp-proxy'] }),
  }),

  defineServer({
    name: 'yaml-language-server',
    binary: 'yaml-language-server',
    extensionToLanguage: { '.yml': 'yaml', '.yaml': 'yaml' },
    installer: npm('yaml-language-server'),
    toConfig: (bin) => ({ command: bin, args: ['--stdio'] }),
  }),

  defineServer({
    name: 'taplo',
    binary: 'taplo',
    extensionToLanguage: { '.toml': 'toml' },
    installer: githubRelease({
      owner: 'tamasfe',
      repo: 'taplo',
      binaryName: 'taplo',
      getAssetUrl: taploAsset,
    }),
    toConfig: (bin) => ({ command: bin, args: ['lsp', 'stdio'] }),
  }),

  defineServer({
    name: 'dart',
    binary: 'dart',
    extensionToLanguage: { '.dart': 'dart' },
    installer: undefined, // comes with Dart SDK — no auto-install
    toConfig: (bin) => ({ command: bin, args: ['language-server'] }),
  }),

  defineServer({
    name: 'omnisharp',
    binary: 'OmniSharp',
    extensionToLanguage: { '.cs': 'csharp', '.csx': 'csharp' },
    installer: githubRelease({
      owner: 'OmniSharp',
      repo: 'omnisharp-roslyn',
      binaryName: 'OmniSharp',
      getAssetUrl: omnisharpAsset,
    }),
    toConfig: (bin) => ({ command: bin, args: ['-lsp'] }),
  }),

  // jdtls — special: JVM-based, detect via java + jar glob
  {
    name: 'jdtls',
    binary: 'java',
    extensionToLanguage: { '.java': 'java' },
    installer: githubRelease({
      owner: 'eclipse-jdtls',
      repo: 'eclipse.jdt.ls',
      binaryName: 'jdtls',
      getAssetUrl: (assets) =>
        assets.find(a => a.name.endsWith('.tar.gz') && a.name.startsWith('jdt-language-server'))?.browser_download_url ?? null,
    }),
    toConfig: (jarPath) => ({
      command: 'java',
      args: [
        '--add-modules=ALL-SYSTEM',
        '--add-opens', 'java.base/java.util=ALL-UNNAMED',
        '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
        '-jar', jarPath,
        '-data', join(getClaudinConfigHomeDir(), 'lsp', 'jdtls', 'workspace'),
      ],
      extensionToLanguage: { '.java': 'java' },
    }),
  },

  // kotlin-language-server — special: JVM-based like jdtls, uses raw literal (not defineServer)
  // because the launcher path comes from resolveInstalledPath, not a simple `which` binary.
  // server.zip contains server/bin/kotlin-language-server (launcher script) + server/lib/*.jar
  {
    name: 'kotlin-language-server',
    binary: 'java',
    extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' },
    installer: githubRelease({
      owner: 'fwcd',
      repo: 'kotlin-language-server',
      binaryName: 'kotlin-language-server',
      getAssetUrl: (assets) =>
        assets.find(a => a.name === 'server.zip')?.browser_download_url ?? null,
      extractAll: true,
      resolveInstalledPath: (destDir) => join(destDir, 'server', 'bin', 'kotlin-language-server'),
    }),
    toConfig: (bin) => ({
      command: bin,
      args: [],
      extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' },
    }),
  },

  defineServer({
    name: 'clangd',
    binary: 'clangd',
    extensionToLanguage: { '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'c', '.hpp': 'cpp', '.hxx': 'cpp' },
    installer: githubRelease({
      owner: 'clangd',
      repo: 'clangd',
      binaryName: 'clangd',
      getAssetUrl: clangdAsset,
    }),
    toConfig: (bin) => ({ command: bin, args: [] }),
  }),
]

// Exported for tests
export { SERVER_DEFINITIONS }

// ---------------------------------------------------------------------------
// Public install API
// ---------------------------------------------------------------------------

export type InstallProgress =
  | { phase: 'download'; pct: number }
  | { phase: 'extract' | 'done' | 'failed' }

export async function installServer(
  name: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<boolean> {
  const def = SERVER_DEFINITIONS.find((d) => d.name === name)
  if (!def?.installer) return false
  // Bypass the stale-check in installInBackground — this is an explicit user request.
  const statusFile = join(lspDir(def.name), '.install-status.json')
  await writeInstallStatus(statusFile, { status: 'in-progress', attemptedAt: Date.now() })
  let bin: string | null = null
  try {
    bin = await def.installer.install(onProgress)
  } catch {
    await writeInstallStatus(statusFile, { status: 'failed', attemptedAt: Date.now() })
    onProgress?.({ phase: 'failed' })
    return false
  }
  if (!bin) {
    await writeInstallStatus(statusFile, { status: 'failed', attemptedAt: Date.now() })
    onProgress?.({ phase: 'failed' })
    return false
  }
  await unlink(statusFile).catch(() => undefined)
  reinitializeLspServerManager()
  onProgress?.({ phase: 'done' })
  return true
}

// ---------------------------------------------------------------------------
// LspServerRow — for /lsp dashboard
// ---------------------------------------------------------------------------

export type LspServerStatus = '✓ detected' | '✗ missing' | '⊘ disabled' | '⏳ installing'

export type LspServerRow = {
  name: string
  status: LspServerStatus
  installer: string
  disabled: boolean
  managed: boolean
  found: boolean
  languages: string[]   // unique language IDs, e.g. ['typescript', 'javascript']
  extensions: string[]  // file extensions, e.g. ['.ts', '.tsx', '.js']
}

export async function getLspServerRows(): Promise<LspServerRow[]> {
  const userSettings = getUserLspSettings()
  const lspBase = join(getClaudinConfigHomeDir(), 'lsp') + '/'

  const rows = await Promise.all(
    SERVER_DEFINITIONS.map(async (def): Promise<LspServerRow> => {
      const disabled = userSettings[def.name]?.disabled === true

      const installerLabel: string = (() => {
        if (!def.installer) return 'manual (SDK)'
        switch (def.installer.type) {
          case 'npm': return 'npm'
          case 'github-release': return 'github'
          case 'go-install': return 'go install'
          default: return 'manual (SDK)'
        }
      })()

      const languages = [...new Set(Object.values(def.extensionToLanguage))]
      const extensions = Object.keys(def.extensionToLanguage)

      if (disabled) {
        return { name: def.name, status: '⊘ disabled', installer: installerLabel, disabled: true, managed: false, found: false, languages, extensions }
      }

      const statusFile = join(lspDir(def.name), '.install-status.json')
      const installStatus = await readInstallStatus(statusFile)
      if (installStatus?.status === 'in-progress' && Date.now() - installStatus.attemptedAt < IN_PROGRESS_STALE_MS) {
        return { name: def.name, status: '⏳ installing', installer: installerLabel, disabled: false, managed: false, found: false, languages, extensions }
      }

      let binPath: string | null = null
      if (def.name === 'jdtls') {
        binPath = await Promise.race([
          detectJdtls(),
          new Promise<null>((r) => setTimeout(() => r(null), WHICH_TIMEOUT_MS)),
        ])
      } else if (def.name === 'kotlin-language-server') {
        binPath = await Promise.race([
          detectKotlinLs(),
          new Promise<null>((r) => setTimeout(() => r(null), WHICH_TIMEOUT_MS)),
        ])
      } else {
        binPath = await Promise.race([
          whichBinary(def.binary),
          new Promise<null>((r) => setTimeout(() => r(null), WHICH_TIMEOUT_MS)),
        ])
      }

      const found = binPath !== null
      const managed = found && binPath!.startsWith(lspBase)

      return {
        name: def.name,
        status: found ? '✓ detected' : '✗ missing',
        installer: installerLabel,
        disabled: false,
        managed,
        found,
        languages,
        extensions,
      }
    }),
  )

  return rows
}

// ---------------------------------------------------------------------------
// installInBackground — anti-loop + fire-and-forget
// ---------------------------------------------------------------------------

// Module-level promise chain serializing the heavy install path. On a clean
// machine we may have 12 missing servers, each kicking off a download +
// decompression. Without a cap, multiple large archives inflate concurrently
// and starve the main thread + saturate disk/network. Detection (whichBinary)
// stays unqueued — only the actual install work goes through the queue.
let installQueueTail: Promise<unknown> = Promise.resolve()

function enqueueInstall<T>(work: () => Promise<T>): Promise<T> {
  const next = installQueueTail.then(() => work(), () => work())
  // Prevent unhandled rejections from poisoning subsequent links in the chain.
  installQueueTail = next.catch(() => undefined)
  return next
}

// exported for testing
export async function installInBackground(
  def: BuiltinServerDef,
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  if (!def.installer) return

  const statusFile = join(lspDir(def.name), '.install-status.json')

  const existing = await readInstallStatus(statusFile)
  if (existing) {
    const age = Date.now() - existing.attemptedAt
    if (existing.status === 'in-progress' && age < IN_PROGRESS_STALE_MS) return
    if (existing.status === 'failed' && age < FAILED_COOLDOWN_MS) return
  }

  await writeInstallStatus(statusFile, { status: 'in-progress', attemptedAt: Date.now() })

  let bin: string | null = null
  try {
    bin = await enqueueInstall(() => def.installer!.install(onProgress))
  } catch (err) {
    await writeInstallStatus(statusFile, { status: 'failed', attemptedAt: Date.now(), error: String(err) })
    return
  }

  if (!bin) {
    await writeInstallStatus(statusFile, { status: 'failed', attemptedAt: Date.now() })
    return
  }

  await unlink(statusFile).catch(() => undefined)
  reinitializeLspServerManager()
}

// ---------------------------------------------------------------------------
// JVM server detection (shared logic)
// ---------------------------------------------------------------------------

async function detectJdtls(): Promise<string | null> {
  const java = await whichBinary('java')
  if (!java) return null

  const jdtlsInstallDir = lspDir('jdtls')
  const jar = await findJdtlsJar(jdtlsInstallDir)
  return jar
}

async function detectKotlinLs(): Promise<string | null> {
  const java = await whichBinary('java')
  if (!java) return null

  const kotlinInstallDir = lspDir('kotlin-language-server')
  return findKotlinLsBinary(kotlinInstallDir)
}

// ---------------------------------------------------------------------------
// getBuiltinLspServers — fast startup (detect-only via which)
// ---------------------------------------------------------------------------

export async function getBuiltinLspServers(): Promise<Record<string, ScopedLspServerConfig>> {
  const detected: Record<string, ScopedLspServerConfig> = {}
  if (!isLspGloballyEnabled()) return detected
  const userSettings = getUserLspSettings()

  // Detect in parallel, but preserve SERVER_DEFINITIONS order when populating
  // the result Record. Iteration order matters downstream:
  // LSPServerManager.getServerForFile() picks the first server that claims a
  // file extension, so a "lightweight" server registered earlier (e.g. biome,
  // which only handles diagnostics) would shadow a full-featured one (e.g.
  // typescript-language-server) for `findReferences`, `hover`, etc.
  const results = await Promise.all(
    SERVER_DEFINITIONS.map(async (def): Promise<ScopedLspServerConfig | null> => {
      if (userSettings[def.name]?.disabled) return null

      let bin: string | null = null

      if (def.name === 'jdtls') {
        bin = await Promise.race([
          detectJdtls(),
          new Promise<null>((r) => setTimeout(() => r(null), WHICH_TIMEOUT_MS)),
        ])
      } else if (def.name === 'kotlin-language-server') {
        bin = await Promise.race([
          detectKotlinLs(),
          new Promise<null>((r) => setTimeout(() => r(null), WHICH_TIMEOUT_MS)),
        ])
      } else {
        bin = await Promise.race([
          whichBinary(def.binary),
          new Promise<null>((r) => setTimeout(() => r(null), WHICH_TIMEOUT_MS)),
        ])
      }

      if (!bin) return null

      return {
        ...def.toConfig(bin),
        scope: 'builtin' as const,
        source: 'builtin',
      }
    }),
  )

  SERVER_DEFINITIONS.forEach((def, i) => {
    const config = results[i]
    if (config) detected[def.name] = config
  })

  return detected
}
