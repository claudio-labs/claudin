// Extension / basename → OutlineLang mapping, plus the byte cap callers apply
// before feeding content into a scan.

import type { OutlineLang } from 'src/tools/shared/codeOutline/types.js'

const EXT_TO_LANG: Record<string, OutlineLang> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  rs: 'rust',
  md: 'markdown',
  markdown: 'markdown',
  // C / C++ — a single 'c' language covers both dialects.
  c: 'c',
  h: 'c',
  cpp: 'c',
  hpp: 'c',
  cc: 'c',
  cxx: 'c',
  hh: 'c',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  rb: 'ruby',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  // zsh and ksh are lexical supersets of the bits that matter here (`#`
  // comments, `'…'` literal, `"…"` expanding); fish differs in syntax but not
  // in those three.
  zsh: 'bash',
  ksh: 'bash',
  fish: 'bash',
  dart: 'dart',
  groovy: 'groovy',
  gradle: 'groovy',
  ex: 'elixir',
  exs: 'elixir',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
 // Config / markup / build — extensions + extensionless filenames.
 yaml: 'yaml',
 yml: 'yaml',
 xml: 'xml',
 properties: 'properties',
 env: 'env',
 ini: 'properties',
 toml: 'toml',
 graphql: 'graphql',
 gql: 'graphql',
 mk: 'makefile',
 tf: 'terraform',
 hcl: 'terraform',
 // Extensionless filenames (detected via basename prefix).
 dockerfile: 'dockerfile',
 containerfile: 'dockerfile',
 makefile: 'makefile',
}
/** Basename prefixes for extensionless files (Dockerfile, Makefile, …).
 * Kept separate from EXT_TO_LANG so the path fallback in detectOutlineLangFromPath
 * only matches true extensionless basenames, not extension keys like `env` or
 * `properties` (which would mis-route `env.log` / `properties.txt` to config
 * scanners). */
const EXTENSIONLESS_BASENAME_TO_LANG: Record<string, OutlineLang> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  // Leading-dot config families — the prefix keeps its dot (`.env`,
  // `.env.local`, `.env.production`), so `env.log` still stays unmatched.
  '.env': 'env',
}

/** Maps a file extension (with or without leading dot) to an outline language. */
export function detectOutlineLang(ext: string): OutlineLang | null {
  return EXT_TO_LANG[ext.toLowerCase().replace(/^\./, '')] ?? null
}

/**
 * Path-aware variant: tries the extension first, then the basename prefix
 * (handles extensionless files like `Dockerfile`, `Makefile`, `Dockerfile.dev`).
 */
export function detectOutlineLangFromPath(filePath: string): OutlineLang | null {
  const lower = filePath.toLowerCase()
  // Try extension first.
  const dotIdx = lower.lastIndexOf('.')
 if (dotIdx >= 0) {
   const ext = lower.slice(dotIdx + 1)
   if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]
 }
 // Try basename prefix for extensionless files.
 const slashIdx = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
 const base = lower.slice(slashIdx + 1)
 // Skip a leading dot so dotfile variants keep their family prefix
 // (`.env.local` → `.env`).
 const firstDot = base.indexOf('.', 1)
 const prefix = firstDot >= 0 ? base.slice(0, firstDot) : base
if (EXTENSIONLESS_BASENAME_TO_LANG[prefix]) return EXTENSIONLESS_BASENAME_TO_LANG[prefix]
 return null
}

/** Byte cap callers apply to content fed into a symbol scan (Read auto-pivot,
 * Grep symbols mode) — aligned with readFileInRange's fast-path ceiling. */
export const SCAN_MAX_BYTES = 10 * 1024 * 1024
