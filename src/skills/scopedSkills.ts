// Directory-scoped skills: a skill under apps/web/.claudin/skills, found when
// a file under apps/web is touched (loadSkillsDir.ts), is offered beside the
// project's own skills as Claude Code 2.1.321 offers it. It keeps its bare
// name while nothing else has it, with its directory said in the
// description; on a collision it is offered as `<scope>:<name>`
// (`apps/web:deploy`) and the bare name stays the other skill's.
//
// Unlike Claude Code, a bare name, once offered, stays with the skill that got
// it for the rest of the session: the skill listing announces only names it
// has not sent (skill-bash-gates.ts), so renaming `deploy` to
// `apps/web:deploy` when a second variant turns up would leave the model
// calling a name that no longer resolves.

import { relative, sep } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import type { Command, PromptCommand } from 'src/shared/types/command.js'

export type SkillCommand = Command & PromptCommand

/**
 * A dynamically discovered skill. `dir` is the absolute directory holding its
 * `.claudin/skills` (`/repo/apps/web`), so the same directory found from two
 * working directories is one entry; an activated conditional skill comes from
 * a root directory and has none.
 */
export type ScopedSkill = { skill: SkillCommand; dir?: string }

/** The key a skill is stored under: one per directory and name. */
export function scopedSkillKey({ skill, dir }: ScopedSkill): string {
  return `${dir ?? ''}\0${skill.name}`
}

/** `apps/web` for `/repo/apps/web` under `/repo`, written with `/`. */
export function skillScope(dir: string, root: string): string {
  return relative(root, dir).split(sep).join('/')
}

/**
 * The names `entries` are offered under next to `taken` (the root, user,
 * plugin and built-in commands), with scopes relative to `root`.
 *
 * A bare name not in `taken` goes to an unscoped skill (an activated
 * conditional one) if there is one, else to a scoped skill alone with that
 * name. `grants` remembers who got it (scopedSkillKey) and keeps it there on
 * later calls — pass the same map for the whole session — so a newcomer is
 * qualified instead, and an unscoped newcomer is not offered at all. `taken`
 * still wins over a grant. A qualified name that is itself taken is not
 * offered. The scope goes at the front of the description because the
 * listing cuts descriptions from the end.
 */
export function nameScopedSkills(
  entries: readonly ScopedSkill[],
  taken: ReadonlySet<string>,
  root: string,
  grants: Map<string, string> = new Map(),
): SkillCommand[] {
  const byName = new Map<string, ScopedSkill[]>()
  for (const entry of entries) {
    const group = byName.get(entry.skill.name)
    if (group) group.push(entry)
    else byName.set(entry.skill.name, [entry])
  }
  const used = new Set(taken)
  const named: SkillCommand[] = []
  for (const [name, group] of byName) {
    const holder = bareHolder(name, group, taken, grants)
    if (holder) grants.set(name, scopedSkillKey(holder))
    for (const entry of group) {
      const { skill, dir } = entry
      if (!dir) {
        if (entry === holder) named.push(skill)
        else logForDebugging(`[skills] ${name} is not offered: another skill already has that name`)
        continue
      }
      const scope = skillScope(dir, root)
      if (entry === holder) {
        named.push(rescope(skill, name, scope, `(from ${scope}/, for files under it)`))
        continue
      }
      const qualified = `${scope}:${name}`
      if (used.has(qualified)) {
        logForDebugging(`[skills] ${qualified} is not offered: another skill already has that name`)
        continue
      }
      used.add(qualified)
      const note =
        holder || taken.has(name)
          ? `(${scope}/ variant of "${name}": use it for files under ${scope}/)`
          : `(${scope}/ variant: for files under ${scope}/)`
      named.push(rescope(skill, qualified, scope, note))
    }
  }
  return named
}

/** Which entry gets the bare `name`, or none (see nameScopedSkills). */
function bareHolder(
  name: string,
  group: readonly ScopedSkill[],
  taken: ReadonlySet<string>,
  grants: ReadonlyMap<string, string>,
): ScopedSkill | undefined {
  if (taken.has(name)) return undefined
  const granted = grants.get(name)
  const kept = granted === undefined ? undefined : group.find(e => scopedSkillKey(e) === granted)
  if (kept) return kept
  return group.find(e => !e.dir) ?? (group.length === 1 ? group[0] : undefined)
}

function rescope(skill: SkillCommand, name: string, scope: string, note: string): SkillCommand {
  return {
    ...skill,
    name,
    scope,
    description: `${note} ${skill.description}`,
    ...(name !== skill.name && { userFacingName: () => name }),
  }
}

/**
 * What the model is told when it calls a skill that has directory-scoped
 * variants among the `offered` commands — `apps/web:deploy` beside `deploy` —
 * or null when there are none. Only a scoped skill offered under
 * `<scope>:<name>` counts, so a plugin command that happens to be named
 * `web:deploy` is never named here. `invoked` is the skill being run, which
 * is never its own variant.
 */
export function scopedVariantNote(
  name: string,
  invoked: Command | undefined,
  offered: readonly Command[],
): string | null {
  const invokedSkill = invoked?.type === 'prompt' ? invoked : undefined
  const variants = offered.filter(
    (c): c is SkillCommand =>
      c.type === 'prompt' &&
      c.scope !== undefined &&
      c.name === `${c.scope}:${name}` &&
      c.skillRoot !== invokedSkill?.skillRoot,
  )
  if (variants.length === 0) return null
  const lines = variants.map(c => `- \`${c.name}\` — for files under ${c.scope}/`)
  const self = invokedSkill?.scope ? `the ${invokedSkill.scope}/ one` : 'the unscoped one'
  return `Directory-scoped variants of the "${name}" skill exist in this repository:\n${lines.join('\n')}\n"${name}" is ${self}; call a variant by its exact name to use it instead.`
}
