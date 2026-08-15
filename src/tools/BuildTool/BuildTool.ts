import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { statSync } from 'fs'
import path from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolCallProgress, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/fs/cwd.js'
import { lazySchema } from 'src/utils/data/lazySchema.js'
import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import { formatBuildResult } from 'src/tools/BuildTool/budget.js'
import {
  applyQuietFlags,
  detectAllBuildSystems,
  detectBuild,
  detectBuildFor,
  detectBuildSystemFromCommand,
  detectSubprojects,
} from 'src/tools/BuildTool/detect.js'
import { BUILD_TOOL_NAME, DESCRIPTION } from 'src/tools/BuildTool/prompt.js'
import { runBuild } from 'src/tools/BuildTool/run.js'
import type { BuildProgress, BuildResult, BuildSystem } from 'src/tools/BuildTool/types.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  userFacingName,
} from 'src/tools/BuildTool/UI.js'

/**
 * Generous next to `Typecheck`'s 300s, because a cold build genuinely takes
 * longer than any check. The wall ceiling is the backstop, not the mechanism:
 * a build that has actually hung is caught by the idle threshold long before.
 */
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 1_800_000
/**
 * Long enough to cover the phases that are legitimately silent — linking a
 * large binary, a cold Gradle daemon, a javac pass over a big module — and
 * short enough that a genuinely wedged build does not burn the whole ceiling.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000

/** Each progress message needs its own id; the renderer keeps only the last. */
let progressCounter = 0

const SYSTEMS = [
  'cargo',
  'gradle',
  'maven',
  'sbt',
  'mill',
  'dotnet',
  'go',
  'cmake',
  'make',
  'ninja',
  'swift',
  'xcodebuild',
  'zig',
  'mix',
  'rebar3',
  'node',
  'flutter',
  'dart',
  'rake',
  'luarocks',
  'cabal',
  'stack',
] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .optional()
      .describe('Exact build command to run. When omitted, the build system is auto-detected.'),
    system: z
      .enum(SYSTEMS)
      .optional()
      .describe('Override build-system detection. Rarely needed.'),
    directory: z
      .string()
      .optional()
      .describe(
        'Directory to build, absolute or relative to the current one. Detection runs there. Use this for one package of a monorepo instead of a `cd` in Bash.',
      ),
    path: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Filter the reported diagnostics to one file or directory, or to several at once. Does not narrow what is built.',
      ),
    severity: z
      .enum(['errors', 'all'])
      .optional()
      .describe('Which diagnostics to list. Default "errors"; "all" also lists warnings.'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Wall-clock ceiling in ms (default ${DEFAULT_TIMEOUT_MS}).`),
    idleTimeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Stop the build after this many ms with no output at all (default ${DEFAULT_IDLE_TIMEOUT_MS}). Raise it for a build with a long silent phase.`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * Every field the RESULT RENDERER reads has to be declared here, not just the
 * ones MCP wants: `UserToolSuccessMessage` validates `toolUseResult` against
 * this schema before rendering and hands the renderer the PARSED value, and a
 * `z.object` strips whatever it does not declare. `durationMs` and `stall` were
 * missing, so the TUI rendered a bare "built" with no time for every build, and
 * a stopped one could not report itself as stopped at all.
 */
const outputSchema = lazySchema(() =>
  z.object({
    system: z.string(),
    command: z.string(),
    upToDate: z.boolean(),
    errors: z.number(),
    warnings: z.number(),
    durationMs: z.number().optional(),
    degraded: z.boolean(),
    exitCode: z.number(),
    runError: z.string().optional(),
    stall: z
      .object({
        reason: z.enum(['idle', 'ceiling']),
        ranMs: z.number(),
        silentMs: z.number(),
        lastLine: z.string().optional(),
      })
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = BuildResult

export type ResolvedBuild = {
  command: string
  system: BuildSystem
}

/**
 * Where the build runs. `directory` exists because detection, the build itself
 * and the diagnostic paths must all agree on one root: an A/B over a five-
 * package workspace had the model fall back to `cd pkg && …` in Bash for 18 of
 * 22 builds, because the tool could only ever build the session's cwd.
 */
export function resolveBuildCwd(directory: string | undefined): string {
  const cwd = getCwd()
  if (!directory) return cwd
  return path.isAbsolute(directory) ? directory : path.resolve(cwd, directory)
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the concrete command for a given input: an explicit `command`
 * verbatim, otherwise the auto-detected one — then inject the flag that makes
 * its output readable.
 *
 * Shared by `call()` and the UI so the user sees the command before it runs,
 * mirroring how Bash shows its command. Declared as a hoisted function so
 * UI.tsx can import it despite the module cycle.
 */
export function resolveBuildCommand(
  input: Pick<Input, 'command' | 'system' | 'directory'>,
): ResolvedBuild | null {
  const cwd = resolveBuildCwd(input.directory)
  if (input.command) {
    const system = input.system ?? detectBuildSystemFromCommand(input.command)
    return { command: applyQuietFlags(system, input.command), system }
  }

  // An override must resolve the command for THAT system. Pairing it with the
  // first-detected command would run, say, `bun run build` and then parse its
  // output as cargo JSON.
  const detected = input.system ? detectBuildFor(cwd, input.system) : detectBuild(cwd)
  if (!detected) return null
  return { command: applyQuietFlags(detected.system, detected.command), system: detected.system }
}

export const BuildTool = buildTool({
  name: BUILD_TOOL_NAME,
  aliases: ['Compile'],
  searchHint: 'build compile artifact cargo gradle maven make cmake',
  maxResultSizeChars: 30_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Constant, never a detection result. The tool list is pinned to a shared
    // system-prompt cache config (see getAllBaseTools in src/tools.ts), so a
    // per-project answer here would fragment that cache for every user. "No
    // build system here" is answered at call time instead.
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    // Two builds sharing one `target/` or `build/` corrupt each other.
    return false
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  userFacingName,
  toAutoClassifierInput(input) {
    return input.command ?? '<detect build system>'
  },
  async checkPermissions(input, context) {
    // A build runs project tooling — scripts, plugins, code generators — so
    // gate it exactly like a Bash command and let the user's allowlist apply.
    const command = resolveBuildCommand(input)?.command ?? 'build'
    const bashDecision = await bashToolHasPermission({ command }, context)
    // Use Bash's verdict but NEVER its `updatedInput`: that is Bash-shaped
    // (`{ command }`) and the harness applies it verbatim, which would drop our
    // system/path/severity fields. Echo our own input instead.
    if (bashDecision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: input }
    }
    return bashDecision
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(input: Input, context, _canUseTool, _parentMessage, onProgress?: ToolCallProgress<BuildProgress>) {
    const cwd = resolveBuildCwd(input.directory)
    if (input.directory && !isDirectory(cwd)) {
      const output: BuildResult = {
        system: 'unknown',
        command: '',
        upToDate: false,
        errors: 0,
        warnings: 0,
        diagnostics: [],
        artifacts: [],
        alsoDetected: [],
        degraded: false,
        exitCode: 0,
        runError: `No such directory: ${cwd}`,
      }
      return { data: output }
    }
    const resolved = resolveBuildCommand(input)
    if (!resolved) {
      const subprojects = input.system ? [] : detectSubprojects(cwd)
      const output: BuildResult = {
        system: 'unknown',
        command: '',
        upToDate: false,
        errors: 0,
        warnings: 0,
        diagnostics: [],
        artifacts: [],
        alsoDetected: [],
        degraded: false,
        exitCode: 0,
        runError: input.system
          ? `This project has no ${input.system} setup, or its default target is not a build. Pass an explicit \`command\` to run it anyway.`
          : `Could not detect a build system in ${cwd}.${
              subprojects.length > 0
                ? ` These subdirectories each have one — pass \`directory\` to build one of them: ${subprojects.join(', ')}.`
                : ''
            } Note that a Makefile with no \`all\` target and a Rakefile whose default task is the test suite are skipped on purpose — pass an explicit \`command\` (e.g. "make install" or "cargo build --release") to run one anyway.`,
      }
      return { data: output }
    }

    const result = await runBuild({
      command: resolved.command,
      system: resolved.system,
      cwd,
      abortSignal: context.abortController.signal,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: input.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
      severity: input.severity ?? 'errors',
      pathFilter: input.path,
      alsoDetected: detectAllBuildSystems(cwd),
      // Purely a TUI signal: every `progress` message is dropped before the
      // request is serialized (`utils/messages/normalize.ts:965`), so this
      // cannot add a token to what the model reads.
      onProgress: onProgress
        ? data => onProgress({ toolUseID: `build-progress-${progressCounter++}`, data })
        : undefined,
    })

    return { data: result }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatBuildResult(output),
    }
  },
} satisfies ToolDef<InputSchema, Output, BuildProgress>)
