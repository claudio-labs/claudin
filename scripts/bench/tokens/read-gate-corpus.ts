/**
 * Corpus scan: read-gate refusals across every recorded session, and a replay
 * of the coverage lane against an ACCUMULATING fileState (union of every line
 * range read for that path) instead of the current last-read-wins entry.
 *
 * Two replays run side by side:
 *   - a MODEL of the accumulating entry (sparse line maps built here), which is
 *     what sized the change before it existed;
 *   - the PRODUCTION path: every Read in the transcript is fed to a real
 *     `FileStateCache` via `set`, so `carrySeenRanges` decides what is carried,
 *     and the refusal is re-asked of the real `seenRegionCovers`.
 * The second is the one to cite once the change has landed; the first is kept
 * because a divergence between them is a bug in one of the two.
 *
 * As measured on 2026-08-15 (683 sessions): 40 `coverage:unseen-region`
 * refusals, of which the model says 31 would be covered and PRODUCTION says 30.
 * The single divergence is understood and is a deliberate conservatism, not a
 * defect: a slice whose content ends in `\n` is read as N-1 lines plus a
 * terminator (see `sliceLines`), which shortened one segment by a line and
 * turned an adjacency into a gap. The opposite reading would claim coverage of
 * a line nobody read. `DEBUG_DIVERGENCE=1` prints the cases.
 *
 * Run: bun run scripts/bench/tokens/read-gate-corpus.ts
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { parsePatch } from 'src/tools/ApplyPatchTool/patchFormat.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import {
  coveredSegments,
  seenRegionCovers,
} from 'src/tools/shared/readBeforeEditMessages.js'

/** Commands that rewrite a file in place, i.e. that move its mtime. */
const REWRITE_RE =
  /\bperl\b|\bsed -i|\bgit checkout|\bgit stash|\bgit restore|\bbun run build|\bmv \b|>\s*[^|&]*\.(ts|tsx|js|md|py)/

const ROOT = `${process.env.HOME}/.claudin/projects`

type ToolUse = { id: string; name: string; input: any }

const LINE_RE = /^\s*(\d+)→(.*)$/
const WRITE_TOOLS = new Set(['Edit', 'Write', 'apply_patch', 'NotebookEdit'])
const PATCH_PATH_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm

function writtenPaths(use: ToolUse): string[] {
  if (typeof use.input?.file_path === 'string') return [use.input.file_path]
  if (typeof use.input?.patchText === 'string') {
    const out: string[] = []
    for (const m of use.input.patchText.matchAll(PATCH_PATH_RE)) out.push(m[1].trim())
    return out
  }
  return []
}

function writtenKeys(use: ToolUse): string[] {
  if (typeof use.input?.file_path === 'string') return [basename(use.input.file_path)]
  if (typeof use.input?.patchText === 'string') {
    const out: string[] = []
    for (const m of use.input.patchText.matchAll(PATCH_PATH_RE)) out.push(basename(m[1].trim()))
    return out
  }
  return []
}

const KINDS = [
  ['never-read', /has not been read yet/],
  ['partial-view', /only been seen as an outline or a partial view/],
  ['clipped', /that Read was clipped out of the transcript/],
  ['stale', /has been modified since it was read/],
  ['coverage:unseen-region', /was only read in part \([^)]*\), and the lines you are changing/],
  ['coverage:whole-file', /replaces the whole file, so read all of it/],
] as const

function classify(text: string): string[] {
  const out: string[] = []
  for (const [kind, re] of KINDS) if (re.test(text)) out.push(kind)
  return out
}

function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
      .join('\n')
  return ''
}

function lineBlock(text: string): string {
  return `\n${text.split('\n').map(l => l.trim()).join('\n')}\n`
}

/** Sparse line map -> maximal runs of consecutive known lines. */
function segments(map: Map<number, string>): string[] {
  const nums = [...map.keys()].sort((a, b) => a - b)
  const segs: string[] = []
  let cur: string[] = []
  let prev = -99
  for (const n of nums) {
    if (n !== prev + 1 && cur.length) {
      segs.push(cur.join('\n'))
      cur = []
    }
    cur.push(map.get(n)!)
    prev = n
  }
  if (cur.length) segs.push(cur.join('\n'))
  return segs
}

type Err = {
  session: string
  tool: string
  kinds: string[]
  file: string | undefined
  priorReads: number
  everSeen: boolean
  exactPathTouched?: boolean
  distinctPathsSince?: number
  restartSince?: boolean
  inputPathRelative?: boolean
  readPathsRelative?: number
  bashSince?: number
  bashTouchedFile?: boolean
  bashRewrote?: boolean
  payloadBytes?: number
  resubmittedIdentical?: boolean
  exactMatchInUnion?: boolean
  priorRanges: string[]
  unionWouldCover?: boolean
  lastWouldCover?: boolean
  perReadWouldCover?: boolean
  prodCovers?: boolean
}

const errors: Err[] = []
let totalCalls = 0
const callsByTool = new Map<string, number>()
const errsByTool = new Map<string, number>()
let sessions = 0
let minTs = '9999'
let maxTs = ''

// prevalence: per (session,path), how many distinct ranges were read
let multiRangeFiles = 0
let readFiles = 0
let clobberedWholeFile = 0

const files: string[] = []
for (const proj of readdirSync(ROOT)) {
  const dir = join(ROOT, proj)
  if (!statSync(dir).isDirectory()) continue
  for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(join(dir, f))
}

for (const path of files) {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  sessions++
  const uses = new Map<string, ToolUse>()
  // path key -> sparse line map (accumulated), and list of ranges
  const seenLines = new Map<string, Map<number, string>>()
  const lastLines = new Map<string, Map<number, string>>()
  const ranges = new Map<string, string[]>()
  // every individual read's own line map, in order — used to tell "an earlier
  // SINGLE read already covered it" from "only the union of several does".
  const readSlices = new Map<string, Map<number, string>[]>()
  const readCount = new Map<string, number>()
  const everRead = new Set<string>()
  const everWritten = new Set<string>()
  // latent clobber: a whole-file read followed later by a narrower read
  const hadWholeFile = new Set<string>()
  // absolute path -> ordinal of the last successful Read/Write, plus a running
  // count of distinct paths touched (LRU-eviction proxy) and restart markers.
  const lastTouchOrd = new Map<string, number>()
  const distinctPaths: string[] = []
  let ord = 0
  let restarts = 0
  let relativeReads = 0
  // Bash commands seen, with the ordinal at which they ran.
  const bashLog: { ord: number; cmd: string }[] = []
  const pendingCoverage: { err: Err; patchText: string }[] = []
  const restartOrds: number[] = []
  // The production path, driven for real: entries go in through `set`, so
  // `carrySeenRanges` is what decides. `version` stands in for mtime — it moves
  // on every write and on every Bash command that rewrites the file, which is
  // exactly when production would see a new timestamp.
  const prodCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )
  const version = new Map<string, number>()
  const bumpVersion = (key: string): number => {
    const next = (version.get(key) ?? 1) + 1
    version.set(key, next)
    return next
  }

  for (const line of raw.split('\n')) {
    if (!line) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'mode') {
      restarts++
      restartOrds.push(ord)
    }
    if (o.timestamp && typeof o.timestamp === 'string') {
      if (o.timestamp < minTs) minTs = o.timestamp
      if (o.timestamp > maxTs) maxTs = o.timestamp
    }
    const content = o?.message?.content
    if (!Array.isArray(content)) continue

    if (o.type === 'assistant') {
      for (const b of content) {
        if (b?.type !== 'tool_use') continue
        uses.set(b.id, { id: b.id, name: b.name, input: b.input })
        totalCalls++
        callsByTool.set(b.name, (callsByTool.get(b.name) ?? 0) + 1)
      }
      continue
    }

    if (o.type !== 'user') continue
    for (const b of content) {
      if (b?.type !== 'tool_result') continue
      const use = uses.get(b.tool_use_id)
      if (!use) continue
      const body = textOf(b.content)

      if (use.name === 'Bash' && typeof use.input?.command === 'string') {
        ord++
        bashLog.push({ ord, cmd: use.input.command })
        // Deliberately NOT bumping the version here. An out-of-band rewrite
        // does move the mtime, but "this command looks like a rewrite and
        // mentions that basename" is a guess, and the transcript contradicts
        // it exactly where it matters: a refusal recorded as
        // `coverage:unseen-region` means the tool's OWN staleness check had
        // just passed, i.e. the mtime had NOT moved. With the guess in, two of
        // the 40 refusals came back "still refused" on the strength of a
        // rewrite that demonstrably had not happened — `bun run build` naming
        // a test file it merely runs. Model and production agree without it.
      }

      // Record Read coverage
      if (use.name === 'Read' && !b.is_error) {
        const fp: string | undefined = use.input?.file_path
        if (fp && !fp.startsWith('/')) relativeReads++
        if (fp) {
          const key = basename(fp)
          const map = seenLines.get(key) ?? new Map<number, string>()
          const fresh = new Map<number, string>()
          for (const l of body.split('\n')) {
            const m = LINE_RE.exec(l)
            if (m) {
              map.set(Number(m[1]), m[2])
              fresh.set(Number(m[1]), m[2])
            }
          }
          seenLines.set(key, map)
          lastLines.set(key, fresh)
          readSlices.set(key, [...(readSlices.get(key) ?? []), fresh])
          // …and the same read, through the real cache.
          if (fresh.size > 0) {
            const nums = [...fresh.keys()].sort((a, b) => a - b)
            prodCache.set(key, {
              content: nums.map(n => fresh.get(n)!).join('\n'),
              timestamp: version.get(key) ?? (version.set(key, 1), 1),
              offset: nums[0],
              limit: use.input?.limit,
              ...(use.input?.view === 'outline' ? { isPartialView: true } : {}),
            })
          }
          const r = ranges.get(key) ?? []
          r.push(`${use.input?.view ?? use.input?.symbol ?? ''}${use.input?.offset ?? 1}+${use.input?.limit ?? '∞'}`)
          ranges.set(key, r)
          readCount.set(key, (readCount.get(key) ?? 0) + 1)
          everRead.add(key)
          ord++
          if (!lastTouchOrd.has(fp)) distinctPaths.push(fp)
          lastTouchOrd.set(fp, ord)
          const isWhole =
            use.input?.symbol === undefined &&
            use.input?.view !== 'outline' &&
            (use.input?.offset === undefined || use.input?.offset === 1) &&
            use.input?.limit === undefined
          if (isWhole) hadWholeFile.add(key)
          else if (hadWholeFile.has(key)) {
            clobberedWholeFile++
            hadWholeFile.delete(key)
          }
        }
        continue
      }

      // A successful write rewrites the file: a real accumulating fileState
      // would have to drop every range recorded before it (mtime moved).
      if (!b.is_error && use.name === 'apply_patch' && typeof use.input?.patchText === 'string') {
        for (const pc of pendingCoverage) {
          if (pc.patchText === use.input.patchText) pc.err.resubmittedIdentical = true
          else if (pc.err.resubmittedIdentical === undefined) pc.err.resubmittedIdentical = false
        }
      }
      if (!b.is_error && WRITE_TOOLS.has(use.name)) {
        for (const p2 of writtenPaths(use)) {
          ord++
          if (!lastTouchOrd.has(p2)) distinctPaths.push(p2)
          lastTouchOrd.set(p2, ord)
        }
        for (const k of writtenKeys(use)) {
          everWritten.add(k)
          // Production stores the whole new file here. Empty content is the
          // conservative stand-in: it contributes no lines, so it can only make
          // the replay refuse, never wave something through.
          prodCache.set(k, {
            content: '',
            timestamp: bumpVersion(k),
            offset: undefined,
            limit: undefined,
          })
          seenLines.delete(k)
          lastLines.delete(k)
          readSlices.delete(k)
          ranges.delete(k)
          readCount.delete(k)
        }
        continue
      }
      if (!b.is_error) continue
      errsByTool.set(use.name, (errsByTool.get(use.name) ?? 0) + 1)
      const kinds = classify(body)
      if (kinds.length === 0) continue

      // Which file(s) the refusal names (apply_patch prefixes the rel path).
      let file: string | undefined = use.input?.file_path
      if (!file && use.name === 'apply_patch') {
        const m =
          /(?:•\s*|apply_patch:\s*)([^\s]+\.[A-Za-z0-9]+)\s+(?:was only read in part|has not been read yet|has only been seen|was read, but|has been modified since)/.exec(
            body,
          )
        file = m?.[1]
      }
      const key = file ? basename(file) : undefined
      const err: Err = {
        session: basename(path),
        tool: use.name,
        kinds,
        file,
        priorReads: key ? (readCount.get(key) ?? 0) : 0,
        everSeen: key ? everRead.has(key) || everWritten.has(key) : false,
        priorRanges: key ? [...(ranges.get(key) ?? [])] : [],
      }

      // Replay the coverage lane for unseen-region failures.
      if (kinds.includes('coverage:unseen-region') && key) {
        try {
          const needed: string[][] = []
          if (use.name === 'apply_patch') {
            const parsed = parsePatch(use.input.patchText)
            for (const h of parsed.hunks) {
              if (h.type !== 'update') continue
              if (file && !h.path.endsWith(basename(file))) continue
              for (const c of h.chunks) needed.push(c.oldLines)
            }
          } else if (typeof use.input?.old_string === 'string') {
            needed.push(use.input.old_string.split('\n'))
          }
          const test = (map: Map<number, string> | undefined) => {
            if (!map) return false
            const segs = segments(map).map(lineBlock)
            return needed.every(n =>
              n.length === 0 || n.every(l => l.trim() === '')
                ? true
                : segs.some(s => s.includes(lineBlock(n.join('\n')))),
            )
          }
          err.unionWouldCover = test(seenLines.get(key))
          err.lastWouldCover = test(lastLines.get(key))
          err.perReadWouldCover = (readSlices.get(key) ?? []).some(slice =>
            test(slice),
          )
          // The production answer: the real entry, the real predicate.
          const prodState = prodCache.get(key)
          err.prodCovers = prodState
            ? needed.every(n => seenRegionCovers(prodState, n))
            : false
          // A model/production disagreement is a bug in one of the two; this
          // is the flag that shows which.
          if (process.env.DEBUG_DIVERGENCE === '1' && err.unionWouldCover && !err.prodCovers) {
            const spans = prodState
              ? coveredSegments(prodState).map(
                  s => `${s.offset}-${s.offset + s.lines.length - 1}`,
                )
              : []
            console.error(
              `[divergence] ${key} entry=${prodState ? `off=${prodState.offset} lim=${prodState.limit} carried=${prodState.seenRanges?.length ?? 0}` : 'MISSING'} segments=[${spans.join(', ')}]`,
            )
            console.error(
              `   carried=[${(prodState?.seenRanges ?? []).map(r => `${r.offset}:${r.content.length}b`).join(', ')}] reads=[${(ranges.get(key) ?? []).join(', ')}]`,
            )
            for (const n of needed) {
              if (prodState && seenRegionCovers(prodState, n)) continue
              console.error(`   uncovered chunk (${n.length} lines): ${JSON.stringify(n.slice(0, 2))}`)
            }
          }
          // Stricter: the chunk's old side must appear VERBATIM (no per-line
          // trim) in the bytes actually read — i.e. the matcher's exact pass
          // would have found it, so the patch would have applied, not just
          // passed the gate.
          const exactSegs = segments(seenLines.get(key) ?? new Map()).map(
            x => `\n${x}\n`,
          )
          err.exactMatchInUnion = needed.every(n =>
            n.length === 0 || n.every(l => l.trim() === '')
              ? true
              : exactSegs.some(seg => seg.includes(`\n${n.join('\n')}\n`)),
          )
        } catch {
          /* unparseable payload — leave undefined */
        }
      }
      if (file) {
        // exact-path attribution: which recorded path does the refusal name?
        const hit = [...lastTouchOrd.keys()].find(
          k => k === file || k.endsWith(file.startsWith('/') ? file : `/${file}`),
        )
        if (hit) {
          err.exactPathTouched = true
          const since = lastTouchOrd.get(hit)!
          err.distinctPathsSince = distinctPaths.length - distinctPaths.indexOf(hit) - 1
          err.restartSince = restartOrds.some(r => r > since)
          const after = bashLog.filter(b => b.ord > since)
          const nameFrag = basename(file)
          err.bashSince = after.length
          err.bashTouchedFile = after.some(b => b.cmd.includes(nameFrag))
          err.bashRewrote = after.some(b => REWRITE_RE.test(b.cmd))
        }
      }
      err.inputPathRelative =
        typeof use.input?.file_path === 'string' && !use.input.file_path.startsWith('/')
      err.readPathsRelative = relativeReads
      err.payloadBytes =
        typeof use.input?.patchText === 'string'
          ? Buffer.byteLength(use.input.patchText)
          : typeof use.input?.old_string === 'string'
            ? Buffer.byteLength(use.input.old_string) + Buffer.byteLength(use.input.new_string ?? '')
            : 0
      if (kinds.includes('coverage:unseen-region') && typeof use.input?.patchText === 'string') {
        pendingCoverage.push({ err, patchText: use.input.patchText })
      }
      errors.push(err)
    }
  }

  for (const [key, n] of readCount) {
    readFiles++
    const uniq = new Set(ranges.get(key) ?? [])
    if (n > 1 && uniq.size > 1) multiRangeFiles++
  }
}

const count = (pred: (e: Err) => boolean) => errors.filter(pred).length

console.log(`sessions=${sessions} files=${files.length} toolCalls=${totalCalls}`)
console.log(`window ${minTs.slice(0, 10)} → ${maxTs.slice(0, 10)}`)
console.log('\n-- call/error rates (write family) --')
for (const t of ['Read', 'Edit', 'Write', 'apply_patch', 'NotebookEdit']) {
  const c = callsByTool.get(t) ?? 0
  const e = errsByTool.get(t) ?? 0
  console.log(`${t.padEnd(13)} calls=${String(c).padStart(6)} errors=${String(e).padStart(4)} ${((e / Math.max(c, 1)) * 100).toFixed(1)}%`)
}

console.log('\n-- read-gate refusals by kind (per refusal message) --')
const kindTotals = new Map<string, number>()
for (const e of errors) for (const k of e.kinds) kindTotals.set(k, (kindTotals.get(k) ?? 0) + 1)
for (const [k, v] of [...kindTotals].sort((a, b) => b[1] - a[1])) console.log(`${k.padEnd(24)} ${v}`)
console.log(`total refusal messages carrying a read gate: ${errors.length}`)

console.log('\n-- by tool --')
const byTool = new Map<string, number>()
for (const e of errors) byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + 1)
for (const [k, v] of [...byTool].sort((a, b) => b[1] - a[1])) console.log(`${k.padEnd(14)} ${v}`)

console.log('\n-- never-read: had the path already been Read in this session? --')
const nr = errors.filter(e => e.kinds.includes('never-read'))
console.log(`never-read refusals=${nr.length} withPriorRead=${nr.filter(e => e.priorReads > 0).length} (file identified for ${nr.filter(e => e.file).length})`)
const nrById = new Map<string, number>()
for (const e of nr) if (e.priorReads > 0) nrById.set(e.tool, (nrById.get(e.tool) ?? 0) + 1)
console.log(`  by tool (with a prior read of that path): ${[...nrById].map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.log(`  path was read or written EARLIER in the session (any point) = ${nr.filter(e => e.everSeen).length}`)
const nrExact = nr.filter(e => e.exactPathTouched)
console.log(`  ... same EXACT path (not just basename)                     = ${nrExact.length}`)
console.log(`  ... of those, a session restart marker came in between      = ${nrExact.filter(e => e.restartSince).length}`)
const dp = nrExact.map(e => e.distinctPathsSince ?? 0).sort((a, b) => a - b)
console.log(`  ... distinct paths touched since: min=${dp[0] ?? '-'} median=${dp[Math.floor(dp.length / 2)] ?? '-'} max=${dp[dp.length - 1] ?? '-'}  (>100 = LRU evicted)`)
console.log(`  ... with >100 distinct paths since                          = ${nrExact.filter(e => (e.distinctPathsSince ?? 0) > 100).length}`)
console.log(`  ... the refusing tool call used a RELATIVE file_path         = ${nrExact.filter(e => e.inputPathRelative).length}`)
console.log(`  ... a Bash command NAMING that file ran in between        = ${nrExact.filter(e => e.bashTouchedFile).length}`)
console.log(`  ... a file-rewriting Bash command ran in between           = ${nrExact.filter(e => e.bashRewrote).length}`)
console.log(`  ... neither (unexplained)                                  = ${nrExact.filter(e => !e.bashTouchedFile && !e.bashRewrote && !e.restartSince).length}`)
const pv = errors.filter(e => e.kinds.includes('partial-view'))
const pvExact = pv.filter(e => e.exactPathTouched)
console.log(`\n-- partial-view refusals=${pv.length}; path read/written earlier at the exact path = ${pvExact.length}`)
console.log(`  ... a file-rewriting Bash command ran in between           = ${pvExact.filter(e => e.bashRewrote).length}`)
console.log(`  ... a Bash command NAMING that file ran in between         = ${pvExact.filter(e => e.bashTouchedFile).length}`)
console.log('  partial-view sample (session / file / bash between):')
for (const e of pvExact.slice(0, 8))
  console.log(`    ${e.session.slice(0, 8)} ${e.tool.padEnd(11)} ${String(e.file).slice(-48).padEnd(48)} rewrote=${e.bashRewrote} named=${e.bashTouchedFile}`)
console.log('  sample:')
for (const e of nrExact.slice(0, 14))
  console.log(`    ${e.tool.padEnd(11)} ${String(e.file).slice(-52).padEnd(52)} distinctSince=${e.distinctPathsSince} restart=${e.restartSince} rel=${e.inputPathRelative}`)

console.log('\n-- coverage:unseen-region replay (accumulating vs last-read-wins) --')
const cov = errors.filter(e => e.kinds.includes('coverage:unseen-region'))
console.log(`unseen-region refusals=${cov.length}`)
console.log(`  apply_patch replayed        = ${cov.filter(e => e.unionWouldCover !== undefined).length}`)
console.log(`  union of ranges WOULD cover = ${count(e => e.unionWouldCover === true)}`)
console.log(`  last read alone would cover = ${count(e => e.lastWouldCover === true)}`)
console.log(`  ≥2 prior reads of that file = ${cov.filter(e => e.priorReads > 1).length}`)
console.log(`  ONE earlier read covered it = ${count(e => e.perReadWouldCover === true)}`)
console.log(`  only the UNION covers it    = ${count(e => e.unionWouldCover === true && e.perReadWouldCover !== true)}`)
console.log(
  `  PRODUCTION path covers it   = ${count(e => e.prodCovers === true)}   <- the number to cite`,
)
for (const e of cov) {
  console.log(
    `   ${e.tool.padEnd(11)} ${String(e.file ?? '?').slice(-40).padEnd(40)} reads=${e.priorReads} union=${e.unionWouldCover ?? '-'} prod=${e.prodCovers ?? '-'} single=${e.perReadWouldCover ?? '-'} ranges=[${e.priorRanges.slice(-5).join(', ')}]`,
  )
}

const fixable = cov.filter(e => e.unionWouldCover === true)
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
console.log(`  ... and the old side matches those bytes VERBATIM = ${count(e => e.unionWouldCover === true && e.exactMatchInUnion === true)}`)
console.log(`  later re-sent BYTE-IDENTICAL and accepted = ${cov.filter(e => e.resubmittedIdentical === true).length} of ${cov.filter(e => e.resubmittedIdentical !== undefined).length} tracked`)
console.log(`  refused payload re-sent, all unseen-region = ${kb(cov.reduce((a, e) => a + (e.payloadBytes ?? 0), 0))}`)
console.log(`  ... of which the fixable ${fixable.length}            = ${kb(fixable.reduce((a, e) => a + (e.payloadBytes ?? 0), 0))}`)
console.log(`  never-read + partial-view phantom payload  = ${kb([...nrExact, ...pvExact].reduce((a, e) => a + (e.payloadBytes ?? 0), 0))}`)

console.log('\n-- prevalence --')
console.log(`(session,file) pairs read at least once = ${readFiles}`)
console.log(`  ... read in >1 distinct range         = ${multiRangeFiles} (${((multiRangeFiles / Math.max(readFiles, 1)) * 100).toFixed(1)}%)`)
console.log(`whole-file entries clobbered by a later narrower Read = ${clobberedWholeFile}`)
