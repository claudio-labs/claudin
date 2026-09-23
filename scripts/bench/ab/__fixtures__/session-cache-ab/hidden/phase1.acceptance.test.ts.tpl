/**
 * Phase-1 grader for session-cache-ab. Never shown to a model: the bench
 * copies it next to the workspaces and points SCA_WORKSPACE at the one under
 * test. Black-box on purpose — it drives the workspace's CLI with the carts and
 * catalogs beside this file, so it grades the behaviour the prompt asked for
 * rather than one particular implementation.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const WS = process.env.SCA_WORKSPACE ?? ''
const HERE = import.meta.dir
const CATALOG = ['--catalog', join(HERE, 'catalog.json')]
const TIERS = ['--catalog', join(HERE, 'catalog-tiers.json')]

function cli(...args: string[]) {
  const proc = Bun.spawnSync(['bun', 'run', join(WS, 'src', 'cli.ts'), ...args], { cwd: WS })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

function quoteJson(cart: string, ...extra: string[]) {
  const r = cli('quote', join(HERE, cart), '--json', ...extra)
  expect(r.code).toBe(0)
  return JSON.parse(r.stdout)
}

const totals = (q: Record<string, unknown>) => [q.subtotalCents, q.discountCents, q.taxCents, q.shippingCents, q.totalCents]

describe('--json', () => {
  test('prints the quote, and only the quote, as JSON', () => {
    const q = quoteJson('cart-basic-us.json', ...CATALOG)
    expect(q.currency).toBe('USD')
    expect(q.lines).toMatchObject([
      { sku: 'TEA-001', qty: 2, unitCents: 899, lineCents: 1798 },
      { sku: 'MUG-001', qty: 1, unitCents: 1250, lineCents: 1250 },
    ])
    expect(totals(q)).toEqual([3048, 0, 175, 599, 3822])
  })

  test('errors still go to stderr with exit code 2', () => {
    const r = cli('quote', join(HERE, 'no-such-cart.json'), '--json', ...CATALOG)
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    // The pristine CLI exits 2 here too, for refusing --json itself.
    expect(r.stderr).toContain('no-such-cart.json')
    expect(r.stderr).not.toContain('unknown option')
  })
})

describe('bulk tiers', () => {
  test('a tier lowers the unit price, rounded half-up per unit', () => {
    const q = quoteJson('cart-tiers-us.json', ...TIERS)
    expect(q.lines).toMatchObject([
      { sku: 'TEA-001', qty: 10, unitCents: 854, lineCents: 8540 },
      { sku: 'FIL-001', qty: 3, unitCents: 449, lineCents: 1347 },
      { sku: 'MUG-001', qty: 1, unitCents: 1250, lineCents: 1250 },
    ])
    expect(totals(q)).toEqual([11137, 0, 556, 0, 11693])
  })

  test('only the highest tier reached applies, and coupons see the tiered price', () => {
    const q = quoteJson('cart-tiers-eu.json', ...TIERS)
    expect(q.lines).toMatchObject([{ sku: 'TEA-001', qty: 50, unitCents: 791, lineCents: 39550 }])
    expect(totals(q)).toEqual([39550, 7910, 2848, 0, 34488])
  })

  test('below the first tier the list price applies', () => {
    const q = quoteJson('cart-tiers-uk.json', ...TIERS)
    expect(q.lines).toMatchObject([{ sku: 'TEA-001', qty: 9, unitCents: 899, lineCents: 8091 }])
    expect([q.taxCents, q.totalCents]).toEqual([405, 8496])
  })

  test('the receipt names the tier on the line it priced', () => {
    const r = cli('quote', join(HERE, 'cart-tiers-us.json'), ...TIERS)
    expect(r.code).toBe(0)
    const lineOf = (sku: string) => r.stdout.split('\n').find(l => l.includes('(' + sku + ')')) ?? ''
    expect(lineOf('TEA-001')).toContain('(bulk -5%)')
    expect(lineOf('FIL-001')).toContain('(bulk -10%)')
    expect(lineOf('MUG-001')).not.toContain('bulk')
  })

  test.each(['catalog-bad-minqty.json', 'catalog-bad-percent.json', 'catalog-bad-zero.json', 'catalog-bad-order.json'])(
    'an invalid tier is rejected naming the SKU (%s)',
    file => {
      const r = cli('quote', join(HERE, 'cart-one-tea.json'), '--catalog', join(HERE, file))
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('TEA-001')
    },
  )
})

test('free shipping is decided after coupons (the support ticket)', () => {
  const q = quoteJson('cart-threshold-us.json', ...CATALOG)
  expect(totals(q)).toEqual([7598, 760, 376, 599, 7813])
})
