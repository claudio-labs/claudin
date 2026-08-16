#!/usr/bin/env bun
/**
 * One-off experiment: call malloc_trim(0) after simulated /clear and measure
 * whether RSS recovers to near-initial baseline.
 *
 * Hypothesis: if glibc is holding freed pages, malloc_trim(0) should return
 * them to the kernel. If RSS doesn't drop after trim, the retention is NOT
 * glibc's fault.
 */
import { dlopen, FFIType, suffix } from 'bun:ffi'

// Try to load libc and find malloc_trim
let mallocTrim: (() => number) | null = null
try {
  const libc = dlopen(`libc.${suffix}.6`, {
    malloc_trim: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  mallocTrim = () =>
    (libc.symbols.malloc_trim as unknown as (pad: number) => number)(0)
} catch (e) {
  try {
    const libc = dlopen(`libc.${suffix}`, {
      malloc_trim: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    mallocTrim = () =>
      (libc.symbols.malloc_trim as unknown as (pad: number) => number)(0)
  } catch (e2) {
    console.error('malloc_trim not available on this platform')
    process.exit(1)
  }
}

const MB = (n: number) => (n / 1048576).toFixed(1)
const rss = () => process.memoryUsage().rss

declare const gc: (() => void) | undefined

function snap(label: string) {
  const u = process.memoryUsage()
  console.log(
    `${label.padEnd(40)} rss=${MB(u.rss)}MB heap=${MB(u.heapUsed)}MB ext=${MB(u.external)}MB`,
  )
}

// Build large working set
const messages: string[] = []
snap('0. baseline')

for (let i = 0; i < 100; i++) {
  messages.push('x'.repeat(500 * 1024)) // 500KB string
}
snap('1. after 100×500KB strings')

// Simulate /clear: drop all references
messages.length = 0
snap('2. after clear (no gc)')

if (typeof gc === 'function') gc()
snap('3. after gc')

// Small delay to let any async cleanup run
await new Promise(r => setTimeout(r, 100))
snap('4. after 100ms')

// malloc_trim
const rssBeforeTrim = rss()
const result = mallocTrim()
const rssAfterTrim = rss()
snap(`5. after malloc_trim(0)=${result}`)
console.log(
  `   Δ from trim: ${MB(rssBeforeTrim - rssAfterTrim)} MB released to kernel`,
)

// Multiple cycles
console.log('\n=== Multi-cycle test ===')
for (let cycle = 0; cycle < 5; cycle++) {
  for (let i = 0; i < 50; i++) {
    messages.push('x'.repeat(500 * 1024))
  }
  const rssPeak = rss()
  messages.length = 0
  if (typeof gc === 'function') gc()
  const rssAfterGc = rss()
  mallocTrim()
  const rssAfterTrim = rss()
  console.log(
    `cycle ${cycle}: peak=${MB(rssPeak)}MB gc=${MB(rssAfterGc)}MB trim=${MB(rssAfterTrim)}MB (trim freed ${MB(rssAfterGc - rssAfterTrim)}MB)`,
  )
}
