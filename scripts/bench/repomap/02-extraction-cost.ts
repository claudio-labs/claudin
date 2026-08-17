import { ROOT, gitFiles, extractPass, type FileTags, type PassTiming } from './lib.ts'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'

const scope = process.argv[2] ?? 'all'
const all = gitFiles(ROOT)
const paths = (scope === 'src' ? all.filter(p => p.startsWith('src/')) : all).filter(
  p => detectOutlineLangFromPath(p) !== null,
)

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

// warm-up pass (populates page cache; result discarded)
extractPass(ROOT, paths)

const timings: PassTiming[] = []
let lastTags: FileTags[] = []
for (let i = 0; i < 3; i++) {
  if (global.gc) global.gc()
  const { tags, timing } = extractPass(ROOT, paths)
  timings.push(timing)
  lastTags = tags
}

let defs = 0
let occ = 0
const distinct = new Set<string>()
let filesOver500 = 0
let nullMaskFiles = 0
for (const t of lastTags) {
  defs += t.defs.length
  if (t.idents.size === 0) nullMaskFiles++
  if (t.idents.size > 500) filesOver500++
  for (const [name, c] of t.idents) {
    distinct.add(name)
    occ += c
  }
}

console.log(`=== Q3 EXTRACTION COST — scope=${scope} (${paths.length} eligible files) ===`)
console.log('metric            run1      run2      run3    median')
const rows: Array<[string, (t: PassTiming) => number]> = [
  ['total ms', t => t.totalMs],
  ['read ms', t => t.readMs],
  ['mask+scan ms', t => t.scanMs],
  ['ident ms', t => t.identMs],
]
for (const [label, get] of rows) {
  const vs = timings.map(get)
  console.log(
    `${label.padEnd(14)} ${vs.map(v => v.toFixed(0).padStart(9)).join('')} ${med(vs).toFixed(0).padStart(9)}`,
  )
}
const t = timings[timings.length - 1]!
console.log('')
console.log(`rss start:            ${(t.rssStart / 1024 / 1024).toFixed(1)} MiB`)
console.log(`rss peak:             ${(t.rssPeak / 1024 / 1024).toFixed(1)} MiB`)
console.log(`rss delta:            ${((t.rssPeak - t.rssStart) / 1024 / 1024).toFixed(1)} MiB`)
console.log(`accounted ms (median): ${(med(timings.map(x => x.readMs)) + med(timings.map(x => x.scanMs)) + med(timings.map(x => x.identMs))).toFixed(0)}`)
console.log('')
console.log(`def symbols total:      ${defs}`)
console.log(`distinct identifiers:   ${distinct.size}`)
console.log(`ident occurrences:      ${occ}`)
console.log(`files with null mask:   ${nullMaskFiles}`)
console.log(`files >500 distinct id: ${filesOver500}`)
