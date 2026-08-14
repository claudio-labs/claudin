// Config / markup / build scanners — YAML, .properties/.env, TOML,
// Dockerfile and Makefile.
//
// Grouped because none of them masks: each is a line-oriented key/target
// extractor, so `maskSourceForLang` returns null for all five.

import {
  leadingIndent,
  trimSignature,
} from 'src/tools/shared/codeOutline/internal.js'
import type {
  SymbolEntry,
  SymbolKind,
} from 'src/tools/shared/codeOutline/types.js'

// ---------------------------------------------------------------------------
// YAML — indentation-based key extractor (modeled on scanPython)
// ---------------------------------------------------------------------------

const RE_YAML_KEY = /^(\s*)([A-Za-z_][\w.-]*):(?:\s|$)/
const RE_YAML_LIST_KEY = /^(\s*)-(\s+)([A-Za-z_][\w.-]*):(?:\s|$)/
const RE_YAML_DOC_SEP = /^---+\s*$/
const RE_YAML_BLOCK_INDICATOR = /^[|>][+-]?\d?$/

export function scanYaml(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type YamlKey = { line: number; indent: number; name: string }
  const keys: YamlKey[] = []
  let blockScalarIndent = -1

  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (RE_YAML_DOC_SEP.test(line.trim())) {
      blockScalarIndent = -1
      continue
    }
    if (blockScalarIndent >= 0) {
      const indent = leadingIndent(line)
      if (indent > blockScalarIndent || line.trim() === '') continue
      blockScalarIndent = -1
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let m = RE_YAML_KEY.exec(line)
    let isList = false
    if (!m) {
      m = RE_YAML_LIST_KEY.exec(line)
      isList = true
    }
    if (!m) continue

    const indent = isList ? m[1]!.length + 1 + m[2]!.length : m[1]!.length
    const name = isList ? m[3]! : m[2]!
    keys.push({ line: L, indent, name })

    const colonIdx = trimmed.indexOf(':')
    const valuePart = trimmed.slice(colonIdx + 1).trim()
    if (valuePart && !valuePart.startsWith('#') && RE_YAML_BLOCK_INDICATOR.test(valuePart)) {
      blockScalarIndent = indent
    }
  }

  if (keys.length === 0) return []

  const indents = [...new Set(keys.map(k => k.indent))].sort((a, b) => a - b)
  const indentToDepth = new Map<number, number>()
  indents.forEach((ind, i) => indentToDepth.set(ind, i))

  const results: SymbolEntry[] = []
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!
    const depth = indentToDepth.get(k.indent)!
    let end = lineCount - 1
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[j]!.indent <= k.indent) {
        end = keys[j]!.line - 1
        break
      }
    }
    results.push({
      name: k.name,
      kind: 'key',
      signature: trimSignature(lines[k.line]!),
      startLine: k.line + 1,
      endLine: end + 1,
      depth,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Config — .properties / .env
// ---------------------------------------------------------------------------

const RE_CONFIG_KEY = /^(?:export\s+)?([A-Za-z_][\w.]*)\s*[=:]/

export function scanConfig(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  // .properties line continuation: trailing `\` (odd count) extends to next
  // line. `\\` is an escaped literal backslash — even count, no continuation.
  const endsWithContinuation = (s: string): boolean => {
    let count = 0
    for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) count++
    return count % 2 === 1
  }

  type ConfigEntry = { line: number; name: string }
  const entries: ConfigEntry[] = []
  let continuation = false

  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (continuation) {
      if (endsWithContinuation(line.trimEnd())) continue
      continuation = false
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const m = RE_CONFIG_KEY.exec(trimmed)
    if (!m) continue
    entries.push({ line: L, name: m[1]! })
    if (endsWithContinuation(line.trimEnd())) continuation = true
  }

  if (entries.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const end = i < entries.length - 1 ? entries[i + 1]!.line - 1 : lineCount - 1
    results.push({
      name: e.name,
      kind: 'key',
      signature: trimSignature(lines[e.line]!),
      startLine: e.line + 1,
      endLine: end + 1,
      depth: 0,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// TOML — table/section extractor
// ---------------------------------------------------------------------------

const RE_TOML_TABLE = /^\[\[?([^\]]+)\]\]?/

export function scanToml(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type TomlTable = { line: number; name: string; depth: number }
  const tables: TomlTable[] = []

  for (let L = 0; L < lineCount; L++) {
    const trimmed = lines[L]!.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = RE_TOML_TABLE.exec(trimmed)
    if (!m) continue
    const name = m[1]!.trim()
    const depth = name.split('.').length - 1
    tables.push({ line: L, name, depth })
  }

  if (tables.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]!
    const end = i < tables.length - 1 ? tables[i + 1]!.line - 1 : lineCount - 1
    results.push({
      name: t.name,
      kind: 'key',
      signature: trimSignature(lines[t.line]!),
      startLine: t.line + 1,
      endLine: end + 1,
      depth: t.depth,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Dockerfile — instruction list
// ---------------------------------------------------------------------------

const RE_DOCKER_INSTR = /^(FROM|RUN|COPY|ADD|WORKDIR|ENV|ARG|EXPOSE|LABEL|USER|VOLUME|CMD|ENTRYPOINT|HEALTHCHECK|ONBUILD|STOPSIGNAL|SHELL)\b/i
const RE_DOCKER_AS = /\bAS\s+(\S+)/i

export function scanDockerfile(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type DockerEntry = { line: number; name: string; depth: number }
  const entries: DockerEntry[] = []
  let stageDepth = 0
  let hasFrom = false
  let fromCount = 0
  let continuation = false

  for (let L = 0; L < lineCount; L++) {
    const trimmed = lines[L]!.trim()
    if (continuation) {
      // Docker skips blank/comment lines inside a continuation and keeps it
      // open — `RUN a \` / `# note` / `b` is a single RUN instruction.
      if (!trimmed || trimmed.startsWith('#')) continue
      continuation = trimmed.endsWith('\\')
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = RE_DOCKER_INSTR.exec(trimmed)
    if (!m) continue
    const instr = m[1]!.toUpperCase()
    if (instr === 'FROM') {
      hasFrom = true
      const asMatch = RE_DOCKER_AS.exec(trimmed)
      const name = asMatch ? asMatch[1]! : `FROM_${fromCount + 1}`
      fromCount++
      entries.push({ line: L, name, depth: 0 })
      stageDepth = 1
    } else {
      if (!hasFrom) {
        entries.push({ line: L, name: instr, depth: 0 })
      } else {
        entries.push({ line: L, name: instr, depth: stageDepth })
      }
    }
    continuation = trimmed.endsWith('\\')
  }

  if (entries.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const end = i < entries.length - 1 ? entries[i + 1]!.line - 1 : e.line
    results.push({
      name: e.name,
      kind: 'key',
      signature: trimSignature(lines[e.line]!),
      startLine: e.line + 1,
      endLine: end + 1,
      depth: e.depth,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Makefile — target + variable extractor
// ---------------------------------------------------------------------------

const RE_MAKE_TARGET = /^([A-Za-z_.%][\w.%-]*):/
const RE_MAKE_VAR = /^([A-Za-z_][\w]*)\s*[?:!+]?=/

export function scanMakefile(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type MakeEntry = { line: number; name: string; kind: SymbolKind }
  const entries: MakeEntry[] = []

  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('\t')) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(include|-include|sinclude)\b/.test(trimmed)) continue

    const vm = RE_MAKE_VAR.exec(trimmed)
    if (vm) {
      entries.push({ line: L, name: vm[1]!, kind: 'const' })
      continue
    }
    const tm = RE_MAKE_TARGET.exec(trimmed)
    if (tm) {
      entries.push({ line: L, name: tm[1]!, kind: 'function' })
    }
  }

  if (entries.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    let end = e.line
    if (e.kind === 'function') {
      for (let j = e.line + 1; j < lineCount; j++) {
        const next = lines[j]!
        if (next.startsWith('\t') || next.trim() === '' || next.trim().startsWith('#')) {
          end = j
        } else {
          break
        }
      }
    }
    results.push({
      name: e.name,
      kind: e.kind,
      signature: trimSignature(lines[e.line]!),
      startLine: e.line + 1,
      endLine: end + 1,
      depth: 0,
    })
  }
  return results
}
