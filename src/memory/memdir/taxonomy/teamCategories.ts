import { basename, dirname } from 'path'
import type { MemoryType } from 'src/memory/memdir/taxonomy/memoryKinds.js'

export type TeamCategory = {
  readonly dir: 'decisions' | 'bugs' | 'docs'
  /** The heading its pointers go under in the team index. */
  readonly section: string
  /** The unit of the transcript's count line: "4 team bug memories". */
  readonly noun: string
  readonly type: MemoryType
  /** One line for the full system prompt. */
  readonly compact: string
  /** A shorter line for the lean system prompt. */
  readonly lean: string
  readonly description: string
  readonly whenToSave: string
  readonly whenNotToSave: string
  readonly bodyStructure: string
  readonly paths: string
}

const DECISIONS: TeamCategory = {
  dir: 'decisions',
  section: 'Decisions',
  noun: 'decision',
  type: 'project',
  compact:
    'product, business or architecture decisions that clear the bar: structural (where things live, how the system is organized), functional (what a feature does for its users) or rejected (an alternative dropped, with the reason), and only when the reason lies outside the diff. The frontmatter adds `scope:` and `impact: structural | functional | rejected`; the body opens with **Decision:**, **Why:**, **What changes for a teammate:**, **Rejected:** and **Evidence:**. If nothing would change for a teammate, it is not a team decision.',
  lean: 'impactful decisions (structural, functional or rejected) whose reason is not in the diff; the frontmatter adds `scope:` and `impact: structural | functional | rejected`, the body **Decision:**, **Why:**, **What changes for a teammate:**, **Rejected:**, **Evidence:**; with nothing for a teammate, it is not one.',
  description:
    'A product, business or architecture decision that changes what the project does or how it is organized, kept so that no teammate reverses it without knowing why it was made.',
  whenToSave:
    'Only when the decision is impactful in one of three ways: structural (where things live, how the system is put together), functional (what a feature does for its users: a capability, a default, a policy) or rejected (an alternative that was weighed and dropped, with the reason). The reason has to come from outside the diff, such as a measurement, a cost, a user preference, or a compliance or incident constraint, and a reader of the code would find the choice surprising or be tempted to undo it.',
  whenNotToSave:
    'A choice confined to one function or file, a name, test scaffolding, anything that can be reversed at no cost, anything the commit message and the diff already explain, or a decision whose scope you cannot name. Most decisions made while carrying out a plan are implementation choices and stay out.',
  bodyStructure:
    'The frontmatter adds `scope:` (the feature or slice the decision governs) and `impact: structural | functional | rejected`. The body opens with **Decision:**, **Why:**, **What changes for a teammate:**, **Rejected:** and **Evidence:**. If nothing would change for a teammate, it is not a team decision.',
  paths:
    'Give `paths:` only when the decision is bound to particular files.',
}

const BUGS: TeamCategory = {
  dir: 'bugs',
  section: 'Bugs',
  noun: 'bug',
  type: 'project',
  compact:
    'defects left in the code on purpose, or failures the code does not reveal. Record the symptom, where it lives, how to repro it and its status with an absolute date; the body uses **Symptom:**, **Where:**, **Repro:**, **Status:** and **Why not fixed:**.',
  lean: 'defects left in place or invisible in the code: symptom, where, repro, status with a date.',
  description:
    'A defect that is known or latent and deliberately left in place, or a failure mode that reading the code will not reveal.',
  whenToSave:
    'When a defect is confirmed but stays (a test pins it, it is out of scope, it waits on a decision), or when it is real but cannot be seen in the code because it depends on an environment, a timing or a provider quirk.',
  whenNotToSave:
    'A bug fixed in the same session, or a suspicion nobody has reproduced.',
  bodyStructure:
    '**Symptom:** what goes wrong. **Where:** the files or component involved. **Repro:** the steps that show it. **Status:** open or held, with an absolute date. **Why not fixed:** the reason it stays.',
  paths: 'List in `paths:` the files the defect lives in.',
}

const DOCS: TeamCategory = {
  dir: 'docs',
  section: 'Docs',
  noun: 'doc',
  type: 'reference',
  compact:
    'pointers to the document that explains a subsystem best (a design doc, a living spec, a dashboard, a wiki page) and what it covers, so work starts there; `type: reference`, body **Doc:**, **Covers:**, **Start here when:** and **Kept in sync by:**.',
  lean: "where a subsystem's document lives and what it covers; `type: reference`.",
  description:
    'Where the documentation of a subsystem lives (a design doc, a living spec, a dashboard, a wiki page) and what it holds, so that work on the subsystem starts from it.',
  whenToSave:
    'When the document explains the subsystem better than its code does.',
  whenNotToSave:
    'A pointer to something the code already names, such as a README next to the module or a code comment.',
  bodyStructure:
    '**Doc:** the link or path. **Covers:** what it explains. **Start here when:** the kind of task it serves. **Kept in sync by:** who or what keeps it current.',
  paths: "Set `paths:` to the subsystem's directory.",
}

/** In the order of the transcript's count line. */
export const TEAM_CATEGORIES: readonly TeamCategory[] = [DECISIONS, BUGS, DOCS]

/**
 * The category named by the file's parent directory, read off the path alone.
 * Callers check that the file is a team memory first.
 */
export function teamCategoryForPath(filePath: string): TeamCategory | undefined {
  const parent = basename(dirname(filePath))
  return TEAM_CATEGORIES.find(category => category.dir === parent)
}
