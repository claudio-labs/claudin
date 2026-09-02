/**
 * The vocabulary `/import` speaks.
 *
 * Eight foreign CLIs store the same handful of things in eight different
 * shapes. An adapter's whole job is to turn its agent's files into this closed
 * set of artifacts; `apply.ts` then has exactly one writer per `kind`, and
 * nothing downstream of `collect()` knows which agent an artifact came from
 * except to name it in the report.
 */
import type { McpServerConfig } from 'src/mcp/types.js'
import type { ProviderProfileInput } from 'src/providers/presets/providerProfiles.js'

export type ForeignAgentId =
  | 'claude'
  | 'openclaude'
  | 'codex'
  | 'gemini'
  | 'qwen'
  | 'opencode'
  | 'kimi'
  | 'cursor'

/**
 * Where an artifact came from and where it lands. `user` is `~/.claudin`,
 * `project` is `<cwd>/.claudin` — an agent that keeps the same surface in both
 * places produces one artifact per scope, not one merged artifact.
 */
export type ImportScope = 'user' | 'project'

export type ArtifactStatus = 'new' | 'conflict' | 'identical'

export type ImportArtifactBody =
  | { kind: 'mcpServer'; name: string; config: McpServerConfig }
  | { kind: 'instructions'; text: string }
  | { kind: 'command'; name: string; markdown: string }
  | { kind: 'agent'; name: string; markdown: string }
  | { kind: 'rule'; name: string; markdown: string }
  | { kind: 'skillDir'; name: string; sourceDir: string }
  | { kind: 'settingsKey'; key: string; value: unknown }
  | {
      kind: 'providerHint'
      /** Display name for the profile this would create. */
      name: string
      provider: NonNullable<ProviderProfileInput['provider']>
      baseUrl: string
      model: string
      /**
       * The NAME of the environment variable the foreign config points at —
       * never its value. `/import` does not move secrets.
       */
      envKey?: string
    }

export type ImportArtifactKind = ImportArtifactBody['kind']

export type ImportArtifact = ImportArtifactBody & {
  agent: ForeignAgentId
  scope: ImportScope
  /** Absolute path this was read from. Shown in the tree and in the report. */
  source: string
  /** Absolute path it would be written to. */
  destination: string
  status: ArtifactStatus
  /** Why `status` is 'conflict' or 'identical', in one user-facing clause. */
  statusReason?: string
}

/**
 * Something the adapter found and deliberately did not turn into an artifact —
 * a credential file, an approval policy, a permission list in a syntax we will
 * not guess at. Naming these is the difference between an importer that is
 * honest about its coverage and one that quietly drops half a config.
 */
export type NotImportable = {
  agent: ForeignAgentId
  label: string
  detail: string
}

export type ImportPlan = {
  artifacts: ImportArtifact[]
  notImportable: NotImportable[]
  warnings: string[]
}

export type ImportReport = {
  applied: ImportArtifact[]
  /** Conflicts left alone because the destination already had a value. */
  skipped: ImportArtifact[]
  notImportable: NotImportable[]
  warnings: string[]
  errors: string[]
}

export type CollectContext = {
  /** `$HOME`. Injected so tests never read the developer's real home. */
  homeDir: string
  /** The project directory being imported into. */
  cwd: string
  /** Where user-scoped artifacts land — `~/.claudin` in production. */
  claudinHomeDir: string
  /**
   * The environment, injected for the same reason as `homeDir`: two agents
   * relocate their config dir with a variable (`CODEX_HOME`, `KIMI_CODE_HOME`),
   * and reading `process.env` directly would let the developer's own shell leak
   * into a test.
   */
  env: Record<string, string | undefined>
}

export type ProbePath = {
  path: string
  scope: ImportScope
}

/**
 * An adapter is a table entry, not a class. Adding a ninth agent means adding
 * one of these and one line in `registry.ts`; nothing else in the slice needs
 * to learn the agent exists.
 */
export type ForeignAgentAdapter = {
  id: ForeignAgentId
  /** How the agent is named to the user, e.g. 'OpenAI Codex'. */
  label: string
  /**
   * Paths whose mere existence means "this agent is configured here". Kept
   * separate from `collect` so detection stays a handful of `existsSync` calls
   * and never parses anything.
   */
  probePaths: (ctx: CollectContext) => ProbePath[]
  collect: (ctx: CollectContext) => Promise<ImportPlan>
}

export type DetectedAgent = {
  id: ForeignAgentId
  label: string
  /** The probe paths that actually exist, in registry order. */
  roots: ProbePath[]
}

export function emptyPlan(): ImportPlan {
  return { artifacts: [], notImportable: [], warnings: [] }
}

export function mergePlans(plans: ImportPlan[]): ImportPlan {
  return {
    artifacts: plans.flatMap(plan => plan.artifacts),
    notImportable: plans.flatMap(plan => plan.notImportable),
    warnings: plans.flatMap(plan => plan.warnings),
  }
}
