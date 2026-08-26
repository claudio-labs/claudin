// The CLikeSpec table — binds each C-like language's mask, detector and
// member-container filter into one record the engine (./scan.ts) consumes.

import {
  maskCLike,
  MASK_OPTS_CSHARP,
  MASK_OPTS_DART,
  MASK_OPTS_GROOVY,
  MASK_OPTS_JVM,
  MASK_OPTS_LEGACY,
  MASK_OPTS_PLAIN,
  MASK_OPTS_TSJS,
} from 'src/tools/shared/codeOutline/mask/core.js'
import {
  maskBash,
  maskPhp,
  maskRust,
} from 'src/tools/shared/codeOutline/mask/languages.js'
import {
  detectBash,
  detectC,
  detectCSharp,
  detectGo,
  detectJava,
  detectKotlin,
  detectPhp,
  detectRust,
  detectScala,
  detectSwift,
  detectTsJs,
} from 'src/tools/shared/codeOutline/clike/detectors.js'
import {
  detectGraphql,
  maskGraphql,
} from 'src/tools/shared/codeOutline/langs/graphql.js'
import {
  detectTerraform,
  maskTerraform,
} from 'src/tools/shared/codeOutline/langs/terraform.js'
import type { CLikeSpec } from 'src/tools/shared/codeOutline/clike/types.js'
import type {
  OutlineLang,
  SymbolKind,
} from 'src/tools/shared/codeOutline/types.js'

const NO_KINDS: ReadonlySet<SymbolKind> = new Set()
// `const` is a container because the dominant declaration shape in this repo —
// and in most TS written against a builder API — is an object literal bound to
// a top-level const (`export const XTool = buildTool({ call() {…} })`). Gating
// methods on `class` alone discarded every member of those, which is the whole
// public surface of a tool: 51 files here exposed only their binding.
const TS_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set(['class', 'const'])
const JAVA_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'enum',
  'record',
])
const KT_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'object',
])
const CS_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'struct',
  'record',
])
const RUST_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'impl',
  'trait',
])
const MODULE_KINDS: ReadonlySet<SymbolKind> = new Set(['module'])
const C_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'struct',
])
const PHP_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'trait',
  'enum',
])
const SWIFT_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'struct',
  'enum',
  'interface',
  'impl',
])
const SCALA_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'trait',
  'object',
])
const GRAPHQL_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'record',
])
const TERRAFORM_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'record',
  'module',
  'interface',
])

const maskLegacy: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_LEGACY, interp)
const maskTsJs: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_TSJS, interp)

/**
 * Landmark thresholds for TS/JS, chosen from the A/B corpus rather than
 * guessed — see scripts/bench/ab/outline-symbols-ab.ts.
 */
const TS_NESTED_LANDMARKS = { minBodyLines: 20, minParentLines: 100 }
const maskJvm: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_JVM, interp)
const maskCSharp: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_CSHARP, interp)
const maskPlain: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_PLAIN, interp)
const maskDart: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_DART, interp)
const maskGroovy: CLikeSpec['mask'] = (s, interp) =>
  maskCLike(s, MASK_OPTS_GROOVY, interp)

const TS_SPEC: CLikeSpec = {
  mask: maskTsJs,
  detectSource: 'raw',
  detect: detectTsJs,
  methodContainers: TS_METHOD_CONTAINERS,
  namespaceKinds: NO_KINDS,
  docPrefixes: [],
  strictMethodDepth: false,
  rejectInsideParens: true,
  nestedLandmarks: TS_NESTED_LANDMARKS,
}

export const CLIKE_SPECS: Record<
  Exclude<
    OutlineLang,
    'python' | 'markdown' | 'ruby' | 'lua' | 'sql' | 'css' | 'html' |
    'yaml' | 'xml' | 'properties' | 'env' | 'toml' | 'dockerfile' | 'makefile' |
    // Mask-only: these have no symbol scanner, so no c-like spec either.
    'elixir' | 'powershell'
  >,
  CLikeSpec
> = {
  typescript: TS_SPEC,
  javascript: TS_SPEC,
  go: {
    mask: maskLegacy,
    detectSource: 'raw',
    detect: detectGo,
    methodContainers: NO_KINDS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: false,
  },
  java: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectJava,
    methodContainers: JAVA_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
    rejectInsideParens: true,
  },
  kotlin: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectKotlin,
    methodContainers: KT_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  // Dart and Groovy reuse Java's detection: both declare `class Foo {` and a
  // `Type name(args) {` member the same way. An arrow-bodied Dart member
  // (`=> expr;`) opens no brace body, so it contributes no enclosing symbol.
  dart: {
    mask: maskDart,
    detectSource: 'masked',
    detect: detectJava,
    methodContainers: JAVA_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@', '///'],
    strictMethodDepth: true,
  },
  groovy: {
    mask: maskGroovy,
    detectSource: 'masked',
    detect: detectJava,
    methodContainers: JAVA_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  csharp: {
    mask: maskCSharp,
    detectSource: 'masked',
    detect: detectCSharp,
    methodContainers: CS_METHOD_CONTAINERS,
    namespaceKinds: MODULE_KINDS,
    docPrefixes: ['['],
    strictMethodDepth: true,
    rejectInsideParens: true,
  },
  rust: {
    mask: maskRust,
    detectSource: 'masked',
    detect: detectRust,
    methodContainers: RUST_METHOD_CONTAINERS,
    namespaceKinds: MODULE_KINDS,
    docPrefixes: ['#'],
    strictMethodDepth: true,
  },
  c: {
    mask: maskPlain,
    detectSource: 'masked',
    detect: detectC,
    methodContainers: C_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: true,
    rejectInsideParens: true,
  },
  php: {
    mask: maskPhp,
    detectSource: 'masked',
    detect: detectPhp,
    methodContainers: PHP_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['#['],
    strictMethodDepth: true,
  },
  swift: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectSwift,
    methodContainers: SWIFT_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  scala: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectScala,
    methodContainers: SCALA_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  bash: {
    mask: maskBash,
    detectSource: 'masked',
    detect: trimmed => detectBash(trimmed),
    methodContainers: NO_KINDS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['#'],
    strictMethodDepth: false,
  },
  graphql: {
    mask: maskGraphql,
    detectSource: 'masked',
    detect: detectGraphql,
    methodContainers: GRAPHQL_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: true,
  },
  terraform: {
    mask: maskTerraform,
    detectSource: 'masked',
    detect: detectTerraform,
    methodContainers: TERRAFORM_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: true,
  },
}
