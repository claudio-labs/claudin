/**
 * WorkflowDef → `.md` serialization (frontmatter YAML + instructions body).
 *
 * Inverse of parseWorkflow (loadWorkflows.ts). Pure — no agent-registry / ink
 * imports — so it loads and tests cleanly under `bun test`, matching the
 * loader's constraint.
 */
import { stringifyYaml } from 'src/utils/data/yaml.js'
import type { WorkflowDef, WorkflowStep } from 'src/tools/AgentWorkflow/types.js'

/** Frontmatter keys owned by the structured editor / WorkflowDefSchema. */
const OWNED_KEYS = new Set(['name', 'description', 'main', 'steps'])

/** Emit a step without empty/undefined optionals (matches hand-written style). */
function stepForYaml(s: WorkflowStep): Record<string, unknown> {
  const out: Record<string, unknown> = { name: s.name }
  if (s.agents.length > 0) out['agents'] = s.agents
  if (s.handbackTo?.length) out['handbackTo'] = s.handbackTo
  return out
}

/**
 * Serialize a workflow back to markdown. `rawFrontmatter` (from parseWorkflow)
 * contributes any keys the schema doesn't own, so a hand-added key survives an
 * editor round-trip. Key order: name, description, main?, steps, extras.
 */
export function serializeWorkflow(
  def: WorkflowDef,
  rawFrontmatter: Record<string, unknown> = {},
): string {
  const frontmatter: Record<string, unknown> = {
    name: def.name,
    description: def.description,
  }
  if (def.main) frontmatter['main'] = def.main
  frontmatter['steps'] = def.steps.map(stepForYaml)
  for (const [key, value] of Object.entries(rawFrontmatter)) {
    if (!OWNED_KEYS.has(key)) frontmatter[key] = value
  }

  const yaml = stringifyYaml(frontmatter).trimEnd()
  const body = def.instructions.trim()
  return `---\n${yaml}\n---\n${body ? `${body}\n` : ''}`
}

/**
 * Rename a phase, updating every `handbackTo` that referenced the old name.
 * Returns a new steps array (input untouched).
 */
export function renameStep(
  steps: WorkflowStep[],
  index: number,
  newName: string,
): WorkflowStep[] {
  const oldName = steps[index]?.name
  return steps.map((s, i) => ({
    ...s,
    name: i === index ? newName : s.name,
    handbackTo: s.handbackTo?.map(t => (t === oldName ? newName : t)),
  }))
}
