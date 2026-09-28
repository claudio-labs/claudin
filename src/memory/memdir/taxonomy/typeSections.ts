import type { MemoryType } from 'src/memory/memdir/taxonomy/memoryKinds.js'

type MemoryScope = 'private' | 'team'

type WorkedExample = {
  readonly user: string
  /** What the assistant saves, after "saves … memory:". */
  readonly saves: string
  readonly scope: MemoryScope
}

type TypeGuide = {
  readonly name: MemoryType
  /** Shown only in the two-directory section. */
  readonly scope: string
  readonly description: string
  readonly whenToSave: string
  readonly howToUse: string
  readonly bodyStructure?: string
  readonly examples: readonly WorkedExample[]
}

// Written once for both sections, so the one with scopes and the one without
// cannot drift apart. Nothing outside `scope` and `WorkedExample.scope` may
// assume there are two directories.
const TYPE_GUIDES: readonly TypeGuide[] = [
  {
    name: 'user',
    scope: 'always private',
    description:
      'Who the user is: their role, goals, responsibilities and what they already know. It lets you fit explanations and choices to the person you are working with.',
    whenToSave:
      "When you learn something lasting about the user's role, responsibilities, preferences or expertise. Leave out judgments about the person and anything that does not bear on the work.",
    howToUse:
      'When their background should shape the answer: pitch explanations at their level and build on what they already know.',
    examples: [
      {
        user: "I've run our Kubernetes clusters for years, but I have never written a line of Swift.",
        saves:
          'deep Kubernetes and operations experience, new to Swift and iOS; explain app code through infrastructure analogies',
        scope: 'private',
      },
    ],
  },
  {
    name: 'feedback',
    scope:
      'private by default. It goes to team only when it is a convention the whole project must follow, such as a testing policy or a build invariant, and then it sits at the team root, never in a category directory; personal style stays private. If private feedback would contradict a team memory, either drop it or save it with the override stated.',
    description:
      'How the user wants you to work: what to stop doing and what to keep doing. Corrections are the obvious source, but a quiet confirmation of a choice you made counts just as much, so record both, each with its reason.',
    whenToSave:
      'Whenever the user corrects your approach ("stop doing X") or confirms that a non-obvious choice was right ("yes, one commit was the right call"), provided the lesson will matter in later conversations.',
    howToUse:
      'Let it steer your behaviour, so the user never has to give the same guidance twice.',
    bodyStructure:
      'State the rule first, then a **Why:** line with the reason the user gave (often an incident or a strong preference) and a **How to apply:** line saying when the rule applies.',
    examples: [
      {
        user: 'Stop ending every reply with a summary; I can read the diff.',
        saves: 'no closing summaries; the user reads the diff themselves',
        scope: 'private',
      },
      {
        user: 'Yes, keeping that refactor in one commit was right; splitting it would have been noise.',
        saves:
          'a tightly coupled refactor goes in a single commit; a confirmed choice, not a correction',
        scope: 'private',
      },
      {
        user: 'Every test that touches storage must hit a real database here, never a mock.',
        saves:
          'storage tests run against a real database, never mocks; a project-wide testing policy',
        scope: 'team',
      },
    ],
  },
  {
    name: 'project',
    scope:
      'either, with a strong lean to team. In team memory, a decision that clears its bar goes in `decisions/`, a known defect in `bugs/`, and anything else at the team root.',
    description:
      'The state of ongoing work that the code and its history do not show: who owns what, why it is being done, and by when.',
    whenToSave:
      'When you learn who is doing what, why, or by when. Turn relative dates into an absolute date as you save ("by Thursday" becomes 2026-03-05), so the memory still reads correctly later.',
    howToUse:
      'To understand the motives and constraints behind a request, and to make suggestions that fit them.',
    bodyStructure:
      'Lead with the fact or decision, then a **Why:** line with the motive (a deadline, a stakeholder, a constraint) and a **How to apply:** line saying how it should shape your suggestions.',
    examples: [
      {
        user: 'No non-urgent merges after Thursday; mobile is cutting the release branch.',
        saves:
          'merge freeze after 2026-03-05 for the mobile release cut; flag non-urgent pull requests planned past that date',
        scope: 'team',
      },
    ],
  },
  {
    name: 'reference',
    scope:
      'mostly team: `docs/` for a pointer to the documentation of a subsystem, the team root otherwise.',
    description:
      'Which external systems hold which information, so you know where to look for things that live outside the repository.',
    whenToSave:
      'When you learn about a resource outside the project and what it is for.',
    howToUse:
      'When the user mentions something that lives outside the repository, or asks for information one of those systems holds.',
    examples: [
      {
        user: 'Payment incidents are tracked in the Linear project PAY-OPS.',
        saves: 'payment incidents live in the Linear project PAY-OPS',
        scope: 'team',
      },
    ],
  },
]

type SectionShape = { readonly intro: string; readonly withScopes: boolean }

function renderTypesSection(shape: SectionShape): readonly string[] {
  return [
    '## Types of memory',
    '',
    shape.intro,
    '',
    '<types>',
    ...TYPE_GUIDES.flatMap(guide => renderTypeBlock(guide, shape.withScopes)),
    '</types>',
    '',
  ]
}

function renderTypeBlock(guide: TypeGuide, withScopes: boolean): string[] {
  return [
    '<type>',
    `  <name>${guide.name}</name>`,
    ...(withScopes ? [`  <scope>${guide.scope}</scope>`] : []),
    `  <description>${guide.description}</description>`,
    `  <when_to_save>${guide.whenToSave}</when_to_save>`,
    `  <how_to_use>${guide.howToUse}</how_to_use>`,
    ...(guide.bodyStructure
      ? [`  <body_structure>${guide.bodyStructure}</body_structure>`]
      : []),
    '  <examples>',
    ...guide.examples.flatMap(example => [
      `  user: ${example.user}`,
      `  assistant: [saves ${withScopes ? `${example.scope} ` : ''}${guide.name} memory: ${example.saves}]`,
    ]),
    '  </examples>',
    '</type>',
  ]
}

/** For an extraction that writes to a private and a team directory. */
export const TYPES_SECTION_COMBINED: readonly string[] = renderTypesSection({
  intro:
    'Each memory has exactly one of the four types below, and each type declares a scope: private memories stay between you and this user, team memories are shared with everyone who works on the project.',
  withScopes: true,
})

/** For an extraction that writes to a single directory. */
export const TYPES_SECTION_INDIVIDUAL: readonly string[] = renderTypesSection({
  intro:
    'Each memory has exactly one of the four types below. Every entry says what the type holds, when to save one, how to use it later, and shows an example.',
  withScopes: false,
})
