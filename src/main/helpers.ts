// Pure helpers extracted from src/main.tsx (ROADMAP 11g, Fase 1).
//
// Critério: funções sem side-effect de boot, sem captura de estado do
// entrypoint, e que podem rodar fora da avaliação de main.tsx.
//
// NÃO entram aqui: os 3 lazy-`require` workarounds de ciclo
// (`getTeammateUtils`, `getTeammatePromptAddendum`, `getTeammateModeSnapshot`)
// — esses ficam em `main.tsx` por design (são específicos do entrypoint).

import chalk from 'chalk'
import { readFileSync } from 'node:fs'
import { SHOW_CURSOR } from 'src/ink/termio/dec.js'
import { setAllowedSettingSources, setFlagSettingsPath } from 'src/bootstrap/state.js'
import { isRunningWithBun } from 'src/utils/bundledMode.js'
import { errorMessage, isENOENT } from 'src/utils/errors.js'
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js'
import { safeParseJSON } from 'src/utils/json.js'
import { logError } from 'src/utils/log.js'
import { peekForStdinData } from 'src/utils/process.js'
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import { writeFileSync_DEPRECATED } from 'src/utils/slowOperations.js'
import { generateTempFilePath } from 'src/utils/tempfile.js'

const INSPECT_RE_BUN = /--inspect(-brk)?/
const INSPECT_RE_NODE = /--inspect(-brk)?|--debug(-brk)?/

export function isBeingDebugged(): boolean {
  const isBun = isRunningWithBun()
  const inspectRe = isBun ? INSPECT_RE_BUN : INSPECT_RE_NODE
  // Note: Bun has an issue with single-file executables where application
  // arguments from process.argv leak into process.execArgv (similar to
  // https://github.com/oven-sh/bun/issues/11673). We skip the legacy --debug
  // check on Bun because Bun doesn't support those flags.
  const hasInspectArg = process.execArgv.some(arg => inspectRe.test(arg))
  const hasInspectEnv = !!process.env.NODE_OPTIONS && INSPECT_RE_NODE.test(process.env.NODE_OPTIONS)

  try {
    // Dynamic import would be better but is async — use global require instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector')
    const hasInspectorUrl = !!inspector.url()
    return hasInspectorUrl || hasInspectArg || hasInspectEnv
  } catch {
    return hasInspectArg || hasInspectEnv
  }
}

export function resetCursor(): void {
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined
  terminal?.write(SHOW_CURSOR)
}

export type TeammateOptions = {
  agentId?: string
  agentName?: string
  teamName?: string
  agentColor?: string
  planModeRequired?: boolean
  parentSessionId?: string
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  agentType?: string
}

export function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {}
  }
  const opts = options as Record<string, unknown>
  const teammateMode = opts.teammateMode
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired: typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode: teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process' ? teammateMode : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined,
  }
}

export function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim()
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}')
    let settingsPath: string
    if (looksLikeJson) {
      const parsedJson = safeParseJSON(trimmedSettings)
      if (!parsedJson) {
        process.stderr.write(chalk.red('Error: Invalid JSON provided to --settings\n'))
        process.exit(1)
      }
      // Content-hash path (not random UUID) so identical settings across
      // subprocesses produce the same path — preserves Anthropic prompt cache
      // (Bash sandbox denyWithinAllow list is part of the tool description,
      // and changing it every call invalidates the prefix cache → 12× tokens).
      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings,
      })
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8')
    } else {
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(getFsImplementation(), settingsFile)
      try {
        readFileSync(resolvedSettingsPath, 'utf8')
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`Error: Settings file not found: ${resolvedSettingsPath}\n`))
          process.exit(1)
        }
        throw e
      }
      settingsPath = resolvedSettingsPath
    }
    setFlagSettingsPath(settingsPath)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`Error processing settings: ${errorMessage(error)}\n`))
    process.exit(1)
  }
}

export function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg)
    setAllowedSettingSources(sources)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`))
    process.exit(1)
  }
}

export async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  // Input hijacking breaks MCP.
  if (!process.stdin.isTTY && !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') {
      return process.stdin
    }
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    // If no data arrives in 3s, stop waiting and warn. Stdin is likely an
    // inherited pipe from a parent that isn't writing (subprocess spawned
    // without explicit stdin handling). 3s covers slow producers like curl,
    // jq on large files, python with import overhead. The warning makes
    // silent data loss visible for the rare producer that's slower still.
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      )
    }
    return [prompt, data].filter(Boolean).join('\n')
  }
  return prompt
}
