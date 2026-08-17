import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { lintRuleFiles, relativeFindingPath } from 'src/memory/instructions/rulesLint.js'
import { getProjectDir } from 'src/sessions/pure/paths.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'

/**
 * `/refresh-rules` — reconcile this project's navigation rule with what the
 * agent actually reads, and report the rule defects that are invisible at
 * runtime.
 *
 * Two halves, deliberately weighted differently:
 *  - the mechanical findings are computed here (src/memory/instructions/rulesLint.ts) and
 *    embedded in the prompt, so the model starts from facts rather than
 *    re-deriving them;
 *  - the semantic half — a rule that names the wrong thing, which no
 *    mechanical check can see — is what the model is actually asked to do.
 *
 * Measured caveat that shapes the instructions below: across 257 real sessions
 * in this repo, a static top-50 file list covered only 33.4% of orientation
 * reads and 59.5% of read paths appeared in exactly one session. The generated
 * list is a starting point to prune, which is why this proposes rather than
 * rewrites.
 */
/**
 * The create branch is gone: `src/memory/instructions/ruleMapAutoSync.ts`
 * writes `search-strategy.md` at session start in every project, so by the time
 * anyone runs this skill the file exists. What is left for the model is the
 * half a generator cannot do — whether each entry describes what the directory
 * actually holds — and that is also the half that carries the risk, since a map
 * which misdirects is worse than no map.
 */

async function buildPrompt(): Promise<string> {
  const root = getOriginalCwd()
  const transcriptDir = getProjectDir(root)

  let lintSection: string
  try {
    const { findings, unconditional, unconditionalChars, filesChecked } =
      await lintRuleFiles({ root })
    const lines = findings.map(
      f =>
        `- [${f.severity}] ${relativeFindingPath(root, f.file)}${f.line === undefined ? '' : `:${f.line}`} — ${f.message}\n  fix: ${f.fix}`,
    )
    lintSection = [
      `Checked ${filesChecked} rule file(s).`,
      lines.length > 0
        ? `\nMechanical findings (already computed — do not re-derive these):\n${lines.join('\n')}`
        : '\nNo mechanical findings: every `paths:` matches at least one tracked file, no unsupported frontmatter keys, no stale path references in prose or inside a fenced block, no symbol attributed to a file that does not define it, and no size or `(N)` count off by enough to matter.',
      `\nAlways-loaded context: ${unconditional.length} file(s) totalling ${unconditionalChars.toLocaleString()} chars, paid on every turn — the root AGENTS.md/CLAUDE.md plus every rule with no \`paths:\`.`,
    ].join('\n')
  } catch {
    lintSection =
      'The mechanical check could not run here. Inspect the rule frontmatter by hand.'
  }

  return `# Refresh this project's rules

Reconcile \`.claudin/rules/\` with what this project actually looks like and
with what the agent actually reads. **Propose; do not rewrite.**

## Rule health (computed for you)

${lintSection}

## What you are looking for

The mechanical findings above cover the defects a checker can see. Your job is
the one it cannot: a rule that is *wrong* rather than broken. Concretely —

- a rule that names a directory for one thing when a same-named file holds
  another (a \`context/\` of UI providers documented while \`context.ts\` holds
  the system prompt is the case that motivated this skill);
- module-map entries whose described purpose no longer matches the code;
- files the agent opens constantly that no rule mentions.

## Steps

1. **Read every file under \`.claudin/rules/\`.** Note what each one claims:
   which paths it names, and what it says they contain.

2. **Mine this project's transcripts** at \`${transcriptDir}/*.jsonl\`. Each line
   is a JSON object; tool calls are \`assistant\` messages with
   \`message.content[]\` entries of \`type: "tool_use"\`, where \`name\` is the tool
   and \`input\` its arguments. Aggregate with a shell one-liner (jq or python3) —
   **never read these files into context, they are large.**

   Only the **orientation prefix** matters: the tool calls in a session before
   its first \`Edit\`/\`Write\`/\`apply_patch\`. That is the stretch a navigation
   rule could shorten. Rank files by the number of **distinct sessions** that
   read them, not by raw call count — five reads in one investigation is not a
   pattern.

   Ignore sidechain files (sub-agent transcripts) and any path under a
   scratch/tmp/fixture directory.

3. **Diff the two.** Produce three lists:
   - **Missing** — files in the top ~30 by distinct sessions that no rule names,
     directly or via a directory it names.
   - **Wrong** — anything a rule describes inaccurately. This is the valuable
     list; verify each one by actually reading the file before claiming it.
     Paths, symbol attributions and size/count claims are already covered
     mechanically above, including inside fenced blocks — so spend your effort
     on the half that is not: whether the *described purpose* of a module still
     matches what it does.
   - **Dead** — paths a rule names that no longer exist. Cross-check against the
     mechanical findings above rather than re-deriving.

4. **Propose; do not write anything.** \`.claudin/rules/\` is git-tracked and the
   user decides what lands in it. Print the proposed diff and stop.

5. **Know which half of the map is yours.**
   \`.claudin/rules/search-strategy.md\` is written and refreshed automatically
   from the tracked file list, so its tree, its \`(N)\` counts and its \`paths:\`
   frontmatter are regenerated — proposing an edit to them wastes the user's
   review on a change the next session start discards. What survives, and what
   your diff should be made of, is the \`←\` annotation on each entry: it is
   keyed by directory and carried across every refresh. An entry nobody has
   explained yet reads \`← TODO\`.

6. **Frontmatter, for any rule you propose.**
   \`paths\` is the ONLY supported key — \`globs:\`/\`alwaysApply:\` are silently
   ignored and would leave the rule unconditional, costing context on every
   turn of every session.

## Reporting

Lead with the counts (missing / wrong / dead), then the proposed diff as a
fenced block the user can apply. Be explicit about what you did **not** verify.

A caveat worth passing on: measured over 257 sessions in a mature repo, a
static top-50 file list covered only 33.4% of orientation reads, and 59.5% of
read paths appeared in exactly one session. Prefer a short, accurate map over a
long one — the value here is in what the rule gets *wrong*, not in its length.`
}

export function registerRefreshRulesSkill(): void {
  registerBundledSkill({
    name: 'refresh-rules',
    description:
      "Reconcile .claudin/rules/ with the codebase and with what the agent actually reads, then propose corrections. Creates a navigation rule when the project has none and there is enough session history.",
    whenToUse:
      'When the user wants to check whether the project rules are still accurate, or wants a navigation rule for a project that has none.',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash(ls:*)', 'Bash(jq:*)'],
    async getPromptForCommand() {
      return [{ type: 'text', text: await buildPrompt() }]
    },
  })
}
