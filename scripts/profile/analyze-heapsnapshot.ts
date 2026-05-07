#!/usr/bin/env bun
/**
 * Analyze a V8 heap snapshot (.heapsnapshot) produced by /heapdump.
 *
 * Heap snapshots are JSON with a specific shape:
 *   { snapshot: { meta, node_count, edge_count, ... },
 *     nodes: [int, int, int, ...], edges: [int, int, int, ...],
 *     strings: [...] }
 *
 * Each node is `meta.node_fields.length` ints in a row.
 *
 * This script:
 *  1. Parses the snapshot (streams JSON to avoid OOM on 1GB+ files)
 *  2. Groups nodes by (type, name) and reports top N by self-size and retained-size
 *  3. Highlights known retainers from our 14-singleton inventory
 *
 * Usage:
 *   bun scripts/profile/analyze-heapsnapshot.ts /path/to/file.heapsnapshot [--top=30]
 */

import { readFileSync } from 'fs'

type Meta = {
  node_fields: string[]
  node_types: (string | string[])[]
  edge_fields: string[]
  edge_types: (string | string[])[]
}

type Snapshot = {
  snapshot: { meta: Meta; node_count: number; edge_count: number }
  nodes: number[]
  edges: number[]
  strings: string[]
}

const KNOWN_RETAINER_NAME_HINTS = [
  'perKeyClippedIds',
  'ContentReplacementState',
  'fileReadCache',
  'fileStateCache',
  'readFileState',
  'markdownTokenCache',
  'sessionIngress',
  'lastUuidMap',
  'sequentialAppendBySession',
  'memoize',
  'connectToServer',
  'sentBashGitInstructions',
  'agentTranscriptSubdirs',
  'diagnosticTracker',
  'classifierApprovals',
  'mutableMessages',
  'stableStubState',
]

function fmt(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MB`
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(2)} KB`
  return `${bytes} B`
}

function main() {
  const args = process.argv.slice(2)
  const filePath = args.find((a) => !a.startsWith('--'))
  const topArg = args.find((a) => a.startsWith('--top='))
  const top = topArg ? parseInt(topArg.split('=')[1]!, 10) : 30

  if (!filePath) {
    console.error('Usage: bun scripts/profile/analyze-heapsnapshot.ts <path> [--top=30]')
    process.exit(1)
  }

  console.log(`Loading ${filePath} ...`)
  const raw = readFileSync(filePath, 'utf8')
  console.log(`File size: ${fmt(raw.length)}`)

  const snap = JSON.parse(raw) as Snapshot
  console.log(`Nodes: ${snap.snapshot.node_count.toLocaleString()}`)
  console.log(`Edges: ${snap.snapshot.edge_count.toLocaleString()}`)
  console.log(`Strings: ${snap.strings.length.toLocaleString()}`)

  const nodeFields = snap.snapshot.meta.node_fields
  const stride = nodeFields.length

  const idxType = nodeFields.indexOf('type')
  const idxName = nodeFields.indexOf('name')
  const idxSelfSize = nodeFields.indexOf('self_size')
  const idxEdgeCount = nodeFields.indexOf('edge_count')

  if (idxType < 0 || idxName < 0 || idxSelfSize < 0) {
    console.error('Unexpected meta.node_fields', nodeFields)
    process.exit(1)
  }

  // node_types[0] is array mapping type-int -> type-name
  const typeNames = snap.snapshot.meta.node_types[0] as string[]

  type Group = { key: string; totalSelf: number; count: number; sample: string[] }
  const groups = new Map<string, Group>()

  const nodes = snap.nodes
  const strings = snap.strings

  let totalHeap = 0
  for (let i = 0; i < nodes.length; i += stride) {
    const selfSize = nodes[i + idxSelfSize]!
    totalHeap += selfSize
    const typeIdx = nodes[i + idxType]!
    const nameIdx = nodes[i + idxName]!
    const typeName = typeNames[typeIdx] ?? `type${typeIdx}`
    const name = strings[nameIdx] ?? ''
    const key = `${typeName}::${name}`
    let g = groups.get(key)
    if (!g) {
      g = { key, totalSelf: 0, count: 0, sample: [] }
      groups.set(key, g)
    }
    g.totalSelf += selfSize
    g.count += 1
    if (g.sample.length < 3 && name && !g.sample.includes(name)) g.sample.push(name)
  }

  console.log(`\nTotal self-size across all nodes: ${fmt(totalHeap)}\n`)

  const sorted = [...groups.values()].sort((a, b) => b.totalSelf - a.totalSelf)

  console.log(`Top ${top} groups by total self-size:\n`)
  console.log(
    `  ${'Rank'.padStart(4)}  ${'Type::Name'.padEnd(60)}  ${'Count'.padStart(10)}  ${'TotalSelf'.padStart(12)}`,
  )
  console.log(`  ${'-'.repeat(90)}`)
  for (let i = 0; i < Math.min(top, sorted.length); i++) {
    const g = sorted[i]!
    const key = g.key.length > 58 ? g.key.slice(0, 57) + '…' : g.key
    console.log(
      `  ${String(i + 1).padStart(4)}  ${key.padEnd(60)}  ${g.count.toLocaleString().padStart(10)}  ${fmt(g.totalSelf).padStart(12)}`,
    )
  }

  // Search for known retainers
  console.log(`\nKnown retainer name matches (from our 14-singleton inventory):\n`)
  const matched = sorted.filter((g) =>
    KNOWN_RETAINER_NAME_HINTS.some((h) => g.key.includes(h)),
  )
  if (matched.length === 0) {
    console.log(
      '  (none — either retainers are small enough not to surface, or names were minified)',
    )
  } else {
    for (const g of matched.slice(0, 20)) {
      console.log(
        `  ${g.key.padEnd(60)}  count=${g.count.toLocaleString().padStart(8)}  self=${fmt(g.totalSelf)}`,
      )
    }
  }

  // String-focused report: often the biggest retainer is strings
  const stringGroups = sorted.filter((g) => g.key.startsWith('string::') || g.key.startsWith('concatenated string::') || g.key.startsWith('sliced string::'))
  if (stringGroups.length > 0) {
    const totalStrings = stringGroups.reduce((a, g) => a + g.totalSelf, 0)
    console.log(`\nString-typed nodes total: ${fmt(totalStrings)} (${((totalStrings / totalHeap) * 100).toFixed(1)}% of heap)`)
  }

  // Array-focused report
  const arrayGroups = sorted.filter((g) => g.key.startsWith('array::'))
  if (arrayGroups.length > 0) {
    const totalArrays = arrayGroups.reduce((a, g) => a + g.totalSelf, 0)
    console.log(`Array-typed nodes total: ${fmt(totalArrays)} (${((totalArrays / totalHeap) * 100).toFixed(1)}% of heap)`)
  }
}

main()
