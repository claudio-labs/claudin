/**
 * Generate src/platform/entrypoints/sdk/coreTypes.generated.ts from coreSchemas.ts.
 *
 * The zod schemas in coreSchemas.ts are the single source of truth for the
 * serializable half of the Agent SDK's public API. This script turns each
 * exported `<Name>Schema` into an exported `<Name>` type and commits the
 * result, so SDK consumers (and the IDE) get the types without importing zod
 * or paying for schema construction.
 *
 * Three emission rules, applied in order:
 *
 *   1. UNION   — a schema whose whole body is `z.union([A(), B()])` or
 *                `z.discriminatedUnion('tag', [A(), B()])` over other exported
 *                schemas becomes `type X = A | B`. Referencing the generated
 *                type names rather than re-inferring the union is what lets the
 *                override in rule 3 reach the arms of `SDKMessage`.
 *   2. ALIAS   — a schema whose whole body is a single `A()` call becomes
 *                `type X = A`.
 *   3. INFER   — everything else becomes `z.infer<ReturnType<typeof X>>`. The
 *                `ReturnType` indirection is required because `lazySchema()`
 *                wraps each schema in a memoized factory, so the exported const
 *                is `() => ZodType`, not the schema.
 *
 * On top of that, TYPE_OVERRIDES replaces the fields whose schema is one of the
 * `*Placeholder` stand-ins in coreSchemas.ts. Those are `z.unknown()` because
 * the real type comes from @anthropic-ai/sdk and cannot be expressed in zod;
 * without the override, `SDKAssistantMessage['message']` would infer as
 * `unknown` and take the whole transcript down with it.
 *
 * Usage: bun run scripts/generate-sdk-types.ts
 *        bun run scripts/generate-sdk-types.ts --check   # CI: fail if stale
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_FILE = join(ROOT, 'src/platform/entrypoints/sdk/coreSchemas.ts')
const OUTPUT_FILE = join(ROOT, 'src/platform/entrypoints/sdk/coreTypes.generated.ts')
const SCRIPT_NAME = 'scripts/generate-sdk-types.ts'

// Fields whose schema is a `*Placeholder` in coreSchemas.ts, mapped to the real
// external type. Keep in sync with the "External Type Placeholders" section
// there — a placeholder with no entry here silently infers as `unknown`.
const TYPE_OVERRIDES: Record<string, Record<string, string>> = {
  SDKUserMessage: { message: 'MessageParam' },
  SDKUserMessageReplay: { message: 'MessageParam' },
  SDKAssistantMessage: { message: 'APIAssistantMessage' },
  SDKPartialAssistantMessage: { event: 'RawMessageStreamEvent' },
  SDKResultSuccess: { usage: 'NonNullableUsage' },
  SDKResultError: { usage: 'NonNullableUsage' },
}

// Imports the overrides above need. Only emitted when actually referenced.
const OVERRIDE_IMPORTS: Record<string, { name: string; from: string }> = {
  MessageParam: {
    name: 'MessageParam',
    from: '@anthropic-ai/sdk/resources/messages.mjs',
  },
  APIAssistantMessage: {
    name: 'Message as APIAssistantMessage',
    from: '@anthropic-ai/sdk/resources/messages.mjs',
  },
  RawMessageStreamEvent: {
    name: 'RawMessageStreamEvent',
    from: '@anthropic-ai/sdk/resources/messages.mjs',
  },
  NonNullableUsage: {
    name: 'NonNullableUsage',
    // Aliased, not relative: 4858f7e6 converted every specifier under `src/` to
    // the `src/…` alias, but it rewrote this generator's OUTPUT and not the
    // generator, so the checked-in file and a fresh run disagreed on these two
    // lines and `verify:sdk-types` failed permanently.
    from: 'src/platform/entrypoints/sdk/sdkUtilityTypes.js',
  },
}

const DECL_RE = /^export const (\w+Schema) = lazySchema\(\(\) =>?\s*(.*)$/
const BANNER_RE = /^\/\/ ={20,}$/
const UNION_RE = /^z\.union\(\[(.*)\]\)$/s
const DISCRIMINATED_RE = /^z\.discriminatedUnion\(\s*'[^']*'\s*,\s*\[(.*)\]\)$/s
const ALIAS_RE = /^(\w+Schema)\(\)$/

type Emission =
  | { kind: 'banner'; lines: string[] }
  | { kind: 'type'; name: string; doc: string[]; body: string; rule: string }

/** Everything between `lazySchema(() =>` and the `)` that closes the call. */
function readSchemaBody(lines: string[], start: number, firstChunk: string) {
  // Single-line form: `lazySchema(() => z.literal('x'))`
  if (firstChunk.endsWith('))')) {
    return { body: firstChunk.slice(0, -1).trim(), end: start }
  }
  const collected: string[] = firstChunk ? [firstChunk] : []
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === ')') {
      return { body: collected.join('\n').trim(), end: i }
    }
    collected.push(lines[i]!)
  }
  throw new Error(`Unterminated lazySchema() starting at line ${start + 1}`)
}

/** `[A(), B(), C()]` → ['A', 'B', 'C'], or null if any member is not a bare call. */
function parseSchemaList(inner: string): string[] | null {
  const members = inner
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  if (members.length === 0) return null
  const names: string[] = []
  for (const member of members) {
    const match = ALIAS_RE.exec(member)
    if (!match) return null
    names.push(match[1]!.replace(/Schema$/, ''))
  }
  return names
}

function classify(name: string, body: string) {
  // Collapse formatting and drop the trailing commas prettier leaves behind,
  // both inside the member list and after the schema body itself.
  const normalized = body
    .replace(/\s+/g, ' ')
    .replace(/,\s*\]/g, ']')
    .replace(/,\s*$/, '')
    .trim()

  for (const re of [UNION_RE, DISCRIMINATED_RE]) {
    const match = re.exec(normalized)
    if (!match) continue
    const members = parseSchemaList(match[1]!)
    if (members) {
      return { rule: 'union', text: members.join(' | ') }
    }
  }

  const alias = ALIAS_RE.exec(normalized)
  if (alias) {
    return { rule: 'alias', text: alias[1]!.replace(/Schema$/, '') }
  }

  return {
    rule: 'infer',
    text: `z.infer<ReturnType<typeof coreSchemas.${name}Schema>>`,
  }
}

function applyOverrides(typeName: string, text: string, rule: string) {
  const overrides = TYPE_OVERRIDES[typeName]
  if (!overrides) return { text, used: [] as string[] }
  // A union/alias already points at types that carry their own overrides.
  if (rule !== 'infer') return { text, used: [] as string[] }

  const keys = Object.keys(overrides).sort()
  const omitted = keys.map(key => `'${key}'`).join(' | ')
  const added = keys.map(key => `  ${key}: ${overrides[key]}`).join('\n')
  return {
    text: `Omit<\n  ${text},\n  ${omitted}\n> & {\n${added}\n}`,
    used: keys.map(key => overrides[key]!),
  }
}

function parse(source: string): Emission[] {
  const lines = source.split('\n')
  const out: Emission[] = []
  let pendingDoc: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Section banner: `// ===`, `// Title`, `// ===`
    if (BANNER_RE.test(line) && lines[i + 2] && BANNER_RE.test(lines[i + 2]!)) {
      out.push({ kind: 'banner', lines: lines.slice(i, i + 3) })
      i += 2
      pendingDoc = []
      continue
    }

    if (line.startsWith('/**')) {
      const doc: string[] = []
      let j = i
      while (j < lines.length) {
        doc.push(lines[j]!)
        if (lines[j]!.trimEnd().endsWith('*/')) break
        j++
      }
      pendingDoc = doc
      i = j
      continue
    }

    if (line === '') {
      pendingDoc = []
      continue
    }

    const decl = DECL_RE.exec(line)
    if (!decl) {
      if (!line.startsWith('//')) pendingDoc = []
      continue
    }

    const schemaConst = decl[1]!
    const typeName = schemaConst.replace(/Schema$/, '')
    const { body, end } = readSchemaBody(lines, i, decl[2] ?? '')
    const { rule, text } = classify(typeName, body)
    out.push({ kind: 'type', name: typeName, doc: pendingDoc, body: text, rule })
    pendingDoc = []
    i = end
  }

  return out
}

const MAX_WIDTH = 80

/** Break a declaration that would exceed the repo's 80-column formatting. */
function wrapDeclaration(name: string, text: string) {
  const oneLine = `export type ${name} = ${text}`
  if (oneLine.length <= MAX_WIDTH || text.includes('\n')) return oneLine

  if (text.includes(' | ')) {
    const arms = text.split(' | ').map(arm => `  | ${arm}`)
    return `export type ${name} =\n${arms.join('\n')}`
  }

  const infer = /^z\.infer<(.*)>$/.exec(text)
  if (infer) {
    return `export type ${name} = z.infer<\n  ${infer[1]}\n>`
  }

  return oneLine
}

function render(emissions: Emission[]) {
  const types = emissions.filter(e => e.kind === 'type')
  const usedOverrideImports = new Set<string>()
  let needsZod = false

  const rendered = emissions.map(emission => {
    if (emission.kind === 'banner') return emission.lines.join('\n')
    const { text, used } = applyOverrides(
      emission.name,
      emission.body,
      emission.rule,
    )
    for (const name of used) usedOverrideImports.add(name)
    if (text.includes('z.infer<')) needsZod = true
    const doc = emission.doc.length ? `${emission.doc.join('\n')}\n` : ''
    return `${doc}${wrapDeclaration(emission.name, text)}`
  })

  const imports: string[] = []
  if (needsZod) imports.push(`import type { z } from 'zod/v4'`)

  const byModule = new Map<string, string[]>()
  for (const key of [...usedOverrideImports].sort()) {
    const spec = OVERRIDE_IMPORTS[key]
    if (!spec) throw new Error(`No import registered for override type ${key}`)
    const names = byModule.get(spec.from) ?? []
    names.push(spec.name)
    byModule.set(spec.from, names)
  }
  // External packages before in-repo modules, matching the repo's import order.
  // Since 4858f7e6 in-repo specifiers are aliased (`src/…`) rather than
  // relative, so this test no longer separates them — it falls through to the
  // alphabetical tiebreak, which puts `@anthropic-ai/…` ahead of `src/…`
  // anyway. Kept for any specifier still written relative.
  const modules = [...byModule].sort(([a], [b]) => {
    const aRelative = a.startsWith('.')
    const bRelative = b.startsWith('.')
    if (aRelative !== bRelative) return aRelative ? 1 : -1
    return a < b ? -1 : a > b ? 1 : 0
  })
  for (const [from, names] of modules) {
    const unique = [...new Set(names)].sort()
    const oneLine = `import type { ${unique.join(', ')} } from '${from}'`
    imports.push(
      oneLine.length <= MAX_WIDTH
        ? oneLine
        : `import type {\n${unique.map(n => `  ${n},`).join('\n')}\n} from '${from}'`,
    )
  }
  imports.push(
    `import type * as coreSchemas from 'src/platform/entrypoints/sdk/coreSchemas.js'`,
  )

  const header = [
    '// Generated by ' + SCRIPT_NAME + ' — do not edit by hand.',
    '//',
    '// Source of truth: src/platform/entrypoints/sdk/coreSchemas.ts. To change a type,',
    '// edit the zod schema there and re-run:',
    '//',
    '//   bun run ' + SCRIPT_NAME,
    '//',
    `// ${types.length} types are exported from this file.`,
  ].join('\n')

  return `${header}\n\n${imports.join('\n')}\n\n${rendered.join('\n\n')}\n`
}

const source = readFileSync(SCHEMA_FILE, 'utf8')
const emissions = parse(source)
const output = render(emissions)

if (process.argv.includes('--check')) {
  const current = readFileSync(OUTPUT_FILE, 'utf8')
  if (current !== output) {
    console.error(
      `✗ coreTypes.generated.ts is stale — run \`bun run ${SCRIPT_NAME}\``,
    )
    process.exit(1)
  }
  console.log('✓ coreTypes.generated.ts is up to date')
  process.exit(0)
}

writeFileSync(OUTPUT_FILE, output)

const counts = new Map<string, number>()
for (const emission of emissions) {
  if (emission.kind !== 'type') continue
  counts.set(emission.rule, (counts.get(emission.rule) ?? 0) + 1)
}
const summary = [...counts]
  .sort()
  .map(([rule, n]) => `${n} ${rule}`)
  .join(', ')
console.log(
  `✓ wrote ${OUTPUT_FILE.replace(`${ROOT}/`, '')} — ${summary}`,
)
