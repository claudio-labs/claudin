/**
 * The selection tree behind `/import`, as pure functions.
 *
 * `SelectMulti` takes a FLAT option list with no notion of grouping
 * (`src/terminal/custom-select/SelectMulti.tsx:11`), so the two-level tree is
 * flattened into one: an agent row followed by its indented artifact rows.
 * Toggling an agent row cascades to its children here, in `cascadeSelection`,
 * because the component only ever sees the resulting value array.
 *
 * The one thing a flat list cannot express is a half-checked parent, so a
 * partially selected agent says so in its label — `Claude Code (2/5)`.
 *
 * This lives in a `.ts` rather than beside the component because anything
 * reaching `src/terminal/ink.js` cannot be imported by a colocated test.
 */
import { groupArtifacts, shortenHome, type ArtifactGroup } from 'src/platform/import/format.js'
import type {
  DetectedAgent,
  ForeignAgentId,
  ImportArtifact,
  ImportPlan,
} from 'src/platform/import/types.js'

/** Kinds that start unchecked: neither writes a file the user asked for. */
const OFF_BY_DEFAULT = new Set(['providerHint', 'settingsKey'])

export type AgentEntry = {
  id: ForeignAgentId
  label: string
  /** Where its config was found, already shortened for display. */
  roots: string
  groups: ArtifactGroup[]
}

export type TreeRow = {
  key: string
  agent: ForeignAgentId
  /** null on the agent's own row. */
  groupKey: string | null
  label: string
  description: string
}

export function agentRowKey(id: ForeignAgentId): string {
  return `agent:${id}`
}

export function groupRowKey(id: ForeignAgentId, groupKey: string): string {
  return `${id}:${groupKey}`
}

export function buildAgentEntries(
  detected: readonly DetectedAgent[],
  plan: ImportPlan,
  homeDir?: string,
): AgentEntry[] {
  const entries: AgentEntry[] = []
  for (const agent of detected) {
    const groups = groupArtifacts(
      plan.artifacts.filter(artifact => artifact.agent === agent.id),
      homeDir,
    )
    // An agent that is installed but has nothing we can carry over would be a
    // row the user can only stare at, so it is dropped from the tree; whatever
    // it did have to say is in the report's "not imported" section.
    if (groups.length === 0) continue
    entries.push({
      id: agent.id,
      label: agent.label,
      roots: agent.roots
        .map(root => shortenHome(root.path, homeDir))
        .join('  '),
      groups,
    })
  }
  return entries
}

function groupIsInert(group: ArtifactGroup): boolean {
  return group.artifacts.every(artifact => artifact.status === 'identical')
}

export function defaultSelection(entries: readonly AgentEntry[]): string[] {
  const selected: string[] = []
  for (const entry of entries) {
    const groups = entry.groups.filter(
      group => !OFF_BY_DEFAULT.has(group.kind) && !groupIsInert(group),
    )
    if (groups.length === 0) continue
    selected.push(agentRowKey(entry.id))
    for (const group of groups) {
      selected.push(groupRowKey(entry.id, group.key))
    }
  }
  return selected
}

export function buildTreeRows(
  entries: readonly AgentEntry[],
  selected: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = []
  for (const entry of entries) {
    const total = entry.groups.length
    const chosen = entry.groups.filter(group =>
      selected.has(groupRowKey(entry.id, group.key)),
    ).length
    const partial = chosen > 0 && chosen < total
    rows.push({
      key: agentRowKey(entry.id),
      agent: entry.id,
      groupKey: null,
      label: `▸ ${entry.label}${partial ? ` (${chosen}/${total})` : ''}`,
      description: entry.roots,
    })
    for (const group of entry.groups) {
      rows.push({
        key: groupRowKey(entry.id, group.key),
        agent: entry.id,
        groupKey: group.key,
        label: `      ${group.label}`,
        description: group.detail,
      })
    }
  }
  return rows
}

/**
 * Resolves what the user actually meant by the toggle SelectMulti just
 * reported. An agent row toggled on selects all of its children and off clears
 * them; a child toggled on its own re-derives its parent's state, so the parent
 * checkbox is never left claiming something its children contradict.
 */
export function cascadeSelection(
  entries: readonly AgentEntry[],
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const before = new Set(previous)
  const after = new Set(next)

  for (const entry of entries) {
    const parent = agentRowKey(entry.id)
    const children = entry.groups.map(group => groupRowKey(entry.id, group.key))
    const turnedOn = after.has(parent) && !before.has(parent)
    const turnedOff = !after.has(parent) && before.has(parent)

    if (turnedOn) {
      for (const child of children) after.add(child)
    } else if (turnedOff) {
      for (const child of children) after.delete(child)
    }

    // Re-derive the parent from its children in every case, including the two
    // above: a cascade-on with no children must not leave a checked parent.
    if (children.some(child => after.has(child))) after.add(parent)
    else after.delete(parent)
  }

  return [...after]
}

export function selectedArtifacts(
  entries: readonly AgentEntry[],
  selected: ReadonlySet<string>,
): ImportArtifact[] {
  const artifacts: ImportArtifact[] = []
  for (const entry of entries) {
    for (const group of entry.groups) {
      if (!selected.has(groupRowKey(entry.id, group.key))) continue
      artifacts.push(...group.artifacts)
    }
  }
  return artifacts
}

export function countConflicts(artifacts: readonly ImportArtifact[]): number {
  return artifacts.filter(artifact => artifact.status === 'conflict').length
}
