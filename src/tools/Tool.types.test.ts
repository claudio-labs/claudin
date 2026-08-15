/**
 * Type-level tests for the `buildTool` boundary (src/tools/Tool.ts).
 *
 * `BuiltTool<D>` is a hand-written type-level spread whose comment claims it
 * mirrors the runtime `{ ...TOOL_DEFAULTS, userFacingName, ...def }`. Nothing
 * checked that claim — the file's own defence is "the type semantics are
 * proven by the 0-error typecheck across all 60+ tools", which proves the
 * types are *satisfiable*, not that they match what the function returns. The
 * two halves are pinned separately here: the mapping by `Equal`, the spread by
 * a real `buildTool` call.
 *
 * The defaults are fail-closed on purpose (`isReadOnly` → false, i.e. assume
 * writes; `toAutoClassifierInput` → '' so a security-relevant tool must opt
 * in), which makes a silent change to one of them a permissions problem rather
 * than a cosmetic one.
 */
import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Equal, Expect } from 'src/shared/types/typeAssertions.js'
import type { BuiltTool, DefaultableToolKeys, ToolDefaults } from 'src/tools/Tool.js'
import { buildTool } from 'src/tools/Tool.js'

// --- the mapping: omitted vs provided vs optional --------------------------

type Omitted = { name: 'X' }
// A def that says nothing about isReadOnly gets the default's type…
type _OmittedGetsDefault = Expect<
  Equal<BuiltTool<Omitted>['isReadOnly'], ToolDefaults['isReadOnly']>
>
// …and gets it as a REQUIRED member, which is the point of the `-?`.
type _OmittedIsRequired = Expect<
  Equal<undefined extends BuiltTool<Omitted>['isReadOnly'] ? true : false, false>
>

type Provided = { name: 'X'; isReadOnly: () => true }
// A def that provides one wins over the default, literal type intact.
type _ProvidedWins = Expect<
  Equal<BuiltTool<Provided>['isReadOnly'], () => true>
>

type Optional = { name: 'X'; isReadOnly?: () => true }
// An OPTIONAL member is treated as absent — `undefined extends D[K]` is the
// branch that distinguishes it, and it must fall back to the default rather
// than stay optional.
type _OptionalFallsBack = Expect<
  Equal<BuiltTool<Optional>['isReadOnly'], ToolDefaults['isReadOnly']>
>

// --- non-defaultable keys pass through verbatim ----------------------------

type WithExtras = { name: 'X'; aliases: readonly ['a']; searchHint?: string }
type _NamePassesThrough = Expect<Equal<BuiltTool<WithExtras>['name'], 'X'>>
type _AliasesPassThrough = Expect<
  Equal<BuiltTool<WithExtras>['aliases'], readonly ['a']>
>
// Optional presence is preserved for keys outside the defaultable set.
type _SearchHintStaysOptional = Expect<
  Equal<undefined extends BuiltTool<WithExtras>['searchHint'] ? true : false, true>
>

// --- the defaultable set is exactly the seven keys buildTool fills ---------

type _DefaultableKeys = Expect<
  Equal<
    DefaultableToolKeys,
    | 'isEnabled'
    | 'isConcurrencySafe'
    | 'isReadOnly'
    | 'isDestructive'
    | 'checkPermissions'
    | 'toAutoClassifierInput'
    | 'userFacingName'
  >
>
type _DefaultsCoverThem = Expect<
  Equal<keyof ToolDefaults, DefaultableToolKeys>
>

// --- the runtime spread ----------------------------------------------------

const minimalDef = {
  name: 'TypeTestTool',
  inputSchema: z.object({}),
  description: async () => 'a tool that exists only to pin buildTool',
  prompt: async () => '',
  call: async function* () {},
  renderResultForAssistant: () => '',
  maxResultSizeChars: 1000,
} as const

/**
 * A full `ToolDef` also demands the React render members, which testing.md
 * records as unimportable under `bun test`, so the fixture above is a partial
 * one and this is the single place that says so. The cast costs nothing here:
 * every claim about the TYPE is asserted above against synthetic `D`s with no
 * cast at all, and these tests exist only to check that the runtime spread
 * agrees with them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (def: object) => buildTool(def as any)

test('buildTool fills every defaultable key, fail-closed', async () => {
  const built = build(minimalDef)

  expect(built.isEnabled()).toBe(true)
  // Assume-not-safe / assume-writes: flipping either of these silently widens
  // what runs concurrently and what skips the write-permission path.
  expect(built.isConcurrencySafe({})).toBe(false)
  expect(built.isReadOnly({})).toBe(false)
  expect(built.isDestructive({})).toBe(false)
  // Empty string means "skip the classifier" — a security-relevant tool has to
  // override it, so the default must stay empty rather than become the input.
  expect(built.toAutoClassifierInput({})).toBe('')
})

test('buildTool defaults userFacingName to the tool name, not the empty default', () => {
  // TOOL_DEFAULTS.userFacingName returns ''; buildTool overrides it with
  // `() => def.name` AFTER the spread. The two disagree, and the override is
  // the one that ships — this is the assertion that keeps the doc honest.
  const built = build(minimalDef)
  expect(built.userFacingName({})).toBe('TypeTestTool')
})

test('a def-supplied defaultable key beats both the default and the override', async () => {
  const built = build({
    ...minimalDef,
    isReadOnly: () => true,
    userFacingName: () => 'Renamed',
  })

  expect(built.isReadOnly({})).toBe(true)
  expect(built.userFacingName({})).toBe('Renamed')
})

test('checkPermissions defaults to allow, echoing the real input back', async () => {
  const built = build(minimalDef)
  const input = { file_path: '/tmp/x', content: 'y' }
  const result = await built.checkPermissions(input, undefined as never)

  expect(result.behavior).toBe('allow')
  // Echoing the REAL input matters: a harness applies updatedInput verbatim, so
  // returning `{}` here would blank the tool's arguments on the allow path.
  expect(result.behavior === 'allow' && result.updatedInput).toEqual(input)
})
