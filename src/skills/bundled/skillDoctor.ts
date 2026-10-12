import { isLeanRemindersEnabled } from 'src/agent/prompts/toolPromptTier.js'
import { relativeFindingPath } from 'src/memory/instructions/rulesLint.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getProjectDir } from 'src/sessions/pure/paths.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getBundledSkills, registerBundledSkill } from 'src/skills/bundledSkills.js'
import { type SkillUsageCensus, countSkillInvocations } from 'src/skills/skillUsageCensus.js'
import { type SkillLintResult, lintSkillFiles } from 'src/skills/skillsLint.js'
import {
  LEAN_LISTING_DESC_CHARS,
  MAX_LISTING_DESC_CHARS,
} from 'src/tools/SkillTool/prompt.js'

/**
 * `/skill-doctor` — the `/refresh-rules` of skills: report the skill defects
 * the loader hides, and the descriptions that never make the model invoke
 * their skill.
 *
 * Same split as `/refresh-rules`: the mechanical half (src/skills/skillsLint.ts
 * and the invocation counts of src/skills/skillUsageCensus.ts) is computed
 * here and embedded as facts; the semantic half — whether a description would
 * match the requests its skill is for — is what the model is asked to do.
 * Unlike `/refresh-rules` it may edit, but only what the user confirms: the
 * mechanical fixes are unambiguous, the rewrites are not.
 */

const USAGE_WINDOW_DAYS = 30
/** Below this many sessions a zero count is not evidence of anything. */
const MIN_SESSIONS_TO_JUDGE = 10
/** A skill changed this recently has not had the window to trigger. */
const NEW_SKILL_DAYS = 7
const DAY_MS = 86_400_000

export type SkillDoctorInputs = {
  root: string
  transcriptDir: string
  /** Defaults to ~/.claudin. */
  configHome?: string
  builtinNames: ReadonlySet<string>
  bundledNames: ReadonlySet<string>
  /** The per-entry cap of the model's skill listing for the active model. */
  listingCap: number
  now: number
}

/**
 * Names a skill on disk cannot take. commands.ts is imported here, not at
 * module load: it imports the skill loaders, so a static import from a
 * bundled skill risks an initialization cycle.
 */
export async function collectTakenNames(): Promise<{
  builtinNames: ReadonlySet<string>
  bundledNames: ReadonlySet<string>
}> {
  const { builtInCommandNames } = await import('src/commands/commands.js')
  const bundledNames = new Set(
    getBundledSkills().flatMap(skill => [skill.name, ...(skill.aliases ?? [])]),
  )
  return { builtinNames: builtInCommandNames(), bundledNames }
}

function isoDate(ms: number | undefined): string {
  return ms === undefined ? '—' : new Date(ms).toISOString().slice(0, 10)
}

function lintSection(root: string, lint: SkillLintResult): string {
  const { skills, findings } = lint
  if (skills.length === 0 && findings.length === 0) {
    return 'No skills found: nothing under `.claudin/skills/` or `.claudin/commands/` from here up to the repository root, nor under the user config dir. Tell the user and stop.'
  }
  const project = skills.filter(s => s.scope === 'project').length
  const legacy = skills.filter(s => s.legacy).length
  const lines = findings.map(
    f =>
      `- [${f.severity}] ${relativeFindingPath(root, f.file)}${f.line === undefined ? '' : `:${f.line}`} — ${f.message}\n  fix: ${f.fix}`,
  )
  return [
    `Checked ${skills.length} skill file(s): ${project} project, ${skills.length - project} user${legacy > 0 ? `, ${legacy} of them legacy commands` : ''}.`,
    lines.length > 0
      ? `\nMechanical findings (already computed — do not re-derive these):\n${lines.join('\n')}`
      : '\nNo mechanical findings: every frontmatter parses, every key and value is one the loader reads, no description is cut by a ` #` or by the listing cap, every skill is reachable, and no name is shadowed or shadows a built-in.',
  ].join('\n')
}

function usageSection(
  inputs: SkillDoctorInputs,
  lint: SkillLintResult,
  census: SkillUsageCensus,
): string {
  if (lint.skills.length === 0) return ''
  const header = `From ${census.sessionsScanned} session(s) in the last ${USAGE_WINDOW_DAYS} days (${census.filesScanned} transcript file(s), sub-agents included). **model** = the model chose it through the Skill tool, which is what the description is for; **typed** = someone ran \`/name\`.`
  const rows = lint.skills.map(skill => {
    const counts = census.bySkill.get(skill.name)
    const notes: string[] = []
    if (!skill.modelInvocable) notes.push('model invocation off')
    if (skill.conditional) notes.push('conditional (`paths:`)')
    if (inputs.now - skill.mtimeMs < NEW_SKILL_DAYS * DAY_MS) {
      notes.push(`changed < ${NEW_SKILL_DAYS} days ago`)
    }
    return `| ${skill.name} | ${skill.scope}${skill.legacy ? ' (legacy)' : ''} | ${counts?.model ?? 0} | ${counts?.user ?? 0} | ${isoDate(counts?.lastAt)} | ${isoDate(skill.mtimeMs)} | ${notes.join('; ')} |`
  })
  const thin =
    census.sessionsScanned < MIN_SESSIONS_TO_JUDGE
      ? `\n\n**Only ${census.sessionsScanned} session(s) to go on** — fewer than ${MIN_SESSIONS_TO_JUDGE}, so a zero means nothing yet. Say so instead of judging any description by its count.`
      : ''
  return `## Invocations (computed for you)

${header}

| Skill | Scope | Model | Typed | Last used | File changed | Notes |
|---|---|---|---|---|---|---|
${rows.join('\n')}${thin}

User-scope skills may be used in other projects too; this table only sees this one.`
}

export async function buildSkillDoctorPrompt(inputs: SkillDoctorInputs): Promise<string> {
  let lint: SkillLintResult | undefined
  try {
    lint = await lintSkillFiles({
      root: inputs.root,
      configHome: inputs.configHome,
      builtinNames: inputs.builtinNames,
      bundledNames: inputs.bundledNames,
      listingCap: inputs.listingCap,
    })
  } catch (e: unknown) {
    logForDebugging(`[skill-doctor] skills lint failed: ${String(e)}`, { level: 'warn' })
  }

  let census: SkillUsageCensus | undefined
  try {
    census = await countSkillInvocations({
      transcriptDir: inputs.transcriptDir,
      sinceMs: inputs.now - USAGE_WINDOW_DAYS * DAY_MS,
    })
  } catch (e: unknown) {
    logForDebugging(`[skill-doctor] invocation census failed: ${String(e)}`, { level: 'warn' })
  }

  const health = lint
    ? lintSection(inputs.root, lint)
    : 'The mechanical check could not run here. Read each skill file and check its frontmatter by hand against the `/create skill` contract.'
  const usage =
    lint && census
      ? usageSection(inputs, lint, census)
      : '## Invocations\n\nThe invocation counts could not be computed, so do not claim any description "never triggers" — review the descriptions on their wording alone.'

  return `# Skill doctor

Check this project's skills and the user's global skills for the defects the
loader hides, and for descriptions that never make the model invoke them.
**Report, propose a diff, and apply only what the user confirms.**

## Skill health (computed for you)

${health}

${usage}

## What you are looking for

The findings above are what a checker can see. Your half is the one it
cannot: a description that does not make the model reach for its skill. The
model picks a skill from one listing line — \`description - when_to_use\`, cut
at ${inputs.listingCap} chars for the current model — so judge the line, not
the file.

- **Never triggers** — model-invocable, zero model invocations, and none of the
  table's notes apply. Ask whether a request that needs this skill would match
  that line. The usual causes: it says what the skill *is* instead of *when* to
  use it; it uses the author's private vocabulary rather than the words a
  request would contain; the trigger sits past the cap; or another skill — a
  bundled one included, they are in your own skill listing — claims the same
  requests.
- **Typed, never chosen** — people run it, the model never does. If it should
  only run on request (a deploy, a release), propose
  \`disable-model-invocation: true\`: that is honest, and it frees its share of
  the listing.
- **Overlap** — two skills whose lines claim the same requests. Propose how to
  split the trigger between them.

Do not judge a skill the table marks as changed recently, conditional (it is
only listed after a matching file is touched), or model invocation off.

## Steps

1. Read every skill file the findings or the table name. Verify each claim
   against the file before repeating it.
2. For each mechanical finding, write the fix. A rename (any collision) changes
   how the skill is invoked — check the new name against the names below, and
   say what the user will type afterwards.
3. For each "never triggers" or overlap candidate, write the new
   \`description\` (and \`when_to_use\`, if any) within ${inputs.listingCap}
   chars, leading with the trigger.
4. Report: lead with the counts (errors / warnings / never-triggered), then one
   fenced diff per file. Be explicit about what you did **not** verify.
5. Ask the user which changes to apply, and apply only those, with Edit.
   Nothing is applied without that answer.

## Names already taken

Bundled skills (matched before any skill on disk): ${[...inputs.bundledNames].sort().join(', ') || '—'}.

Built-in commands (a skill with one of these names replaces it): ${[...inputs.builtinNames].sort().join(', ') || '—'}.`
}

export function registerSkillDoctorSkill(): void {
  registerBundledSkill({
    name: 'skill-doctor',
    description:
      'Check project and global skills for invalid frontmatter, names that collide with built-in commands or other skills, and descriptions that never trigger, then propose fixes.',
    whenToUse:
      'When the user asks why a skill never runs or is never picked, wants their skills checked or cleaned up, or suspects a skill name clashes with a command.',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit'],
    async getPromptForCommand() {
      const root = getOriginalCwd()
      // Mirrors SkillTool/prompt.ts getCommandDescription: the cap the
      // listing applies to every entry for the active model.
      const listingCap = isLeanRemindersEnabled()
        ? LEAN_LISTING_DESC_CHARS
        : MAX_LISTING_DESC_CHARS
      const text = await buildSkillDoctorPrompt({
        root,
        transcriptDir: getProjectDir(root),
        ...(await collectTakenNames()),
        listingCap,
        now: Date.now(),
      })
      return [{ type: 'text', text }]
    },
  })
}
