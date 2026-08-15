/**
 * Workflow definition loading + validation.
 *
 * Discovery is project-local only (`.claudin/workflows/*.md`, per the design).
 * The parse + validation helpers are pure (no agent-registry / ink imports) so
 * they load and test cleanly under `bun test`; the agent-existence check takes a
 * pre-computed set (see `agentTypes.ts` for the resolver).
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { isENOENT } from 'src/shared/errors.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'
import { logError } from 'src/shared/log.js'
import { WORKFLOW_ORCHESTRATOR_AGENT_TYPE } from 'src/tools/AgentWorkflow/orchestratorAgent.js'
import { getWorkflowsDir } from 'src/tools/AgentWorkflow/paths.js'
import { type WorkflowDef, WorkflowDefSchema } from 'src/tools/AgentWorkflow/types.js'

/**
 * Parse a single `.md` into a WorkflowDef; returns zod issues on failure.
 * `rawFrontmatter` is the untyped frontmatter object as parsed — the editor
 * carries it through serializeWorkflow so hand-added keys the zod schema
 * strips survive an edit round-trip.
 */
export function parseWorkflow(
  raw: string,
  fallbackName: string,
): { def?: WorkflowDef; errors: string[]; rawFrontmatter: Record<string, unknown> } {
  const { frontmatter, content } = parseFrontmatter(raw)
  const candidate = {
    name:
      typeof frontmatter['name'] === 'string' && frontmatter['name']
        ? frontmatter['name']
        : fallbackName,
    // `?? undefined`: a bare `key:` line parses as YAML null, which the zod
    // string schemas reject — treat it as absent instead.
    description: frontmatter['description'] ?? undefined,
    main: frontmatter['main'] ?? undefined,
    steps: frontmatter['steps'],
    instructions: content.trim(),
  }
  const parsed = WorkflowDefSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(i => `${i.path.join('.') || 'workflow'}: ${i.message}`),
      rawFrontmatter: frontmatter,
    }
  }
  return { def: parsed.data, errors: [], rawFrontmatter: frontmatter }
}

/** Structural checks independent of the agent registry. */
export function validateWorkflowStructure(def: WorkflowDef): string[] {
  const errors: string[] = []
  const names = def.steps.map(s => s.name)

  const seen = new Set<string>()
  for (const n of names) {
    if (seen.has(n)) errors.push(`Duplicate phase name: "${n}"`)
    seen.add(n)
  }

  def.steps.forEach((s, i) => {
    const isLast = i === def.steps.length - 1
    if (s.agents.length === 0 && !isLast) {
      errors.push(`Phase "${s.name}" has no agents (only the final phase may be terminal)`)
    }
    for (const target of s.handbackTo ?? []) {
      const targetIdx = names.indexOf(target)
      if (targetIdx === -1) {
        errors.push(`Phase "${s.name}" hands back to unknown phase "${target}"`)
      } else if (targetIdx >= i) {
        errors.push(`Phase "${s.name}" hands back to "${target}", which must be an earlier phase`)
      }
    }
  })

  return errors
}

/** Agent-existence checks; `known` is the set of available agentTypes. */
export function validateWorkflowAgents(def: WorkflowDef, known: Set<string>): string[] {
  const errors: string[] = []
  for (const s of def.steps) {
    for (const a of s.agents) {
      if (!known.has(a)) errors.push(`Phase "${s.name}" references unknown agent "${a}"`)
    }
  }
  if (def.main && def.main !== WORKFLOW_ORCHESTRATOR_AGENT_TYPE && !known.has(def.main)) {
    errors.push(`Unknown main agent "${def.main}"`)
  }
  return errors
}

/** All workflow definitions in the project (structural errors keyed by file). */
export async function loadWorkflowDefs(): Promise<{
  defs: WorkflowDef[]
  errorsByFile: Record<string, string[]>
}> {
  let files: string[]
  try {
    files = await readdir(getWorkflowsDir())
  } catch (error) {
    if (isENOENT(error)) return { defs: [], errorsByFile: {} }
    logError(error)
    return { defs: [], errorsByFile: {} }
  }

  const defs: WorkflowDef[] = []
  const errorsByFile: Record<string, string[]> = {}
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    let raw: string
    try {
      raw = await readFile(join(getWorkflowsDir(), file), 'utf-8')
    } catch (error) {
      logError(error)
      continue
    }
    const { def, errors } = parseWorkflow(raw, file.slice(0, -'.md'.length))
    if (!def) {
      errorsByFile[file] = errors
      continue
    }
    def.sourceFile = file
    const structural = validateWorkflowStructure(def)
    if (structural.length > 0) errorsByFile[file] = structural
    defs.push(def)
  }
  return { defs, errorsByFile }
}

/** Load one workflow by name (`<name>.md`). Returns null if missing/unparseable. */
export async function loadWorkflowDef(name: string): Promise<WorkflowDef | null> {
  try {
    const raw = await readFile(join(getWorkflowsDir(), `${name}.md`), 'utf-8')
    const def = parseWorkflow(raw, name).def
    if (def) def.sourceFile = `${name}.md`
    return def ?? null
  } catch (error) {
    if (isENOENT(error)) return null
    logError(error)
    return null
  }
}
