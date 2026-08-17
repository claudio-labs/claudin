import { ALL_LANGS, ROOT, gitFiles, fileBytes } from './lib.ts'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'
import { maskSourceForLang } from '../../../src/tools/shared/codeOutline/scanSymbols.js'
import type { OutlineLang } from '../../../src/tools/shared/codeOutline/types.js'

const paths = gitFiles(ROOT)
const byLang = new Map<OutlineLang, { n: number; bytes: number }>()
let eligible = 0
let eligibleBytes = 0
for (const p of paths) {
  const lang = detectOutlineLangFromPath(p)
  if (lang === null) continue
  eligible++
  const b = fileBytes(ROOT, p)
  eligibleBytes += b
  const e = byLang.get(lang) ?? { n: 0, bytes: 0 }
  e.n++
  e.bytes += b
  byLang.set(lang, e)
}

console.log('=== Q1 CORPUS ===')
console.log(`total git paths:      ${paths.length}`)
console.log(`eligible (lang!=null): ${eligible}  (${((eligible / paths.length) * 100).toFixed(1)}%)`)
console.log(`eligible bytes:        ${eligibleBytes} (${(eligibleBytes / 1024 / 1024).toFixed(1)} MiB)`)
console.log('')
console.log('lang           files      bytes')
const sorted = [...byLang.entries()].sort((a, b) => b[1].n - a[1].n)
for (const [lang, e] of sorted) {
  console.log(`${lang.padEnd(14)} ${String(e.n).padStart(5)}  ${String(e.bytes).padStart(10)}`)
}

// src/ only
let srcN = 0
let srcBytes = 0
for (const p of paths) {
  if (!p.startsWith('src/')) continue
  if (detectOutlineLangFromPath(p) === null) continue
  srcN++
  srcBytes += fileBytes(ROOT, p)
}
console.log('')
console.log(`src/ eligible: ${srcN} files, ${srcBytes} bytes (${(srcBytes / 1024 / 1024).toFixed(1)} MiB)`)

console.log('')
console.log('=== Q2 MASK AVAILABILITY ===')
const SNIPPETS: Partial<Record<OutlineLang, string>> = {
  python: 'def f(a):\n    # c\n    return "s"\n',
  ruby: 'def f(a)\n  # c\n  "s"\nend\n',
  lua: 'function f(a)\n  -- c\n  return "s"\nend\n',
  bash: 'f() {\n  # c\n  echo "s"\n}\n',
  sql: 'CREATE TABLE t (a int); -- c\n',
  css: '.a { color: red; } /* c */\n',
  html: '<h1 id="x">t</h1><!-- c -->\n',
  xml: '<a id="x">t</a><!-- c -->\n',
  markdown: '# H\n\ntext `code`\n',
  yaml: 'a: 1 # c\n',
  toml: '[s]\na = 1 # c\n',
  properties: 'a=1\n# c\n',
  env: 'A=1\n# c\n',
  dockerfile: 'FROM x\n# c\n',
  makefile: 'all:\n\techo hi\n',
  graphql: 'type T { a: Int } # c\n',
  terraform: 'resource "a" "b" { c = 1 } # c\n',
  elixir: 'def f(a) do\n  # c\n  "s"\nend\n',
  powershell: 'function f($a) {\n  # c\n  "s"\n}\n',
}
const DEFAULT_SNIPPET = 'function foo(a) {\n  // c\n  return "s";\n}\n'

console.log('lang           mask("x = 1")  mask(realistic)')
for (const lang of ALL_LANGS) {
  const a = maskSourceForLang('x = 1', lang)
  const snip = SNIPPETS[lang] ?? DEFAULT_SNIPPET
  const b = maskSourceForLang(snip, lang)
  const bDesc = b === null ? 'null' : b === snip ? 'string(unchanged)' : 'string(masked)'
  console.log(`${lang.padEnd(14)} ${(a === null ? 'null' : 'string').padEnd(14)} ${bDesc}`)
}
