/**
 * Phase-2 grader for session-cache-ab — coupon expiry. Same black-box contract
 * as phase1.acceptance.test.ts: the workspace's CLI, driven with the files
 * beside this one.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const WS = process.env.SCA_WORKSPACE ?? ''
const HERE = import.meta.dir
const CATALOG = ['--catalog', join(HERE, 'catalog.json')]

function cli(...args: string[]) {
  const proc = Bun.spawnSync(['bun', 'run', join(WS, 'src', 'cli.ts'), ...args], { cwd: WS })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

function quoteJson(cart: string, ...extra: string[]) {
  const r = cli('quote', join(HERE, cart), '--json', ...extra)
  expect(r.code).toBe(0)
  return JSON.parse(r.stdout)
}

describe('coupon expiry', () => {
  test('a coupon is still valid on its expiry date', () => {
    const q = quoteJson('cart-expiry-us.json', ...CATALOG, '--date', '2026-03-31')
    expect([q.subtotalCents, q.discountCents, q.taxCents, q.shippingCents, q.totalCents]).toEqual([
      3048, 629, 145, 599, 3163,
    ])
    expect(q.ignoredCoupons).toEqual([])
  })

  test('an expired coupon is ignored instead of failing the quote', () => {
    const q = quoteJson('cart-expiry-us.json', ...CATALOG, '--date', '2026-04-01')
    expect([q.discountCents, q.taxCents, q.totalCents]).toEqual([360, 161, 3448])
    expect(q.ignoredCoupons).toMatchObject([{ code: 'SPRING10', reason: 'expired' }])
  })

  test('the receipt lists the ignored coupon and does not apply it', () => {
    const r = cli('quote', join(HERE, 'cart-expiry-us.json'), ...CATALOG, '--date', '2026-04-01')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Ignored coupon SPRING10 (expired)')
    expect(r.stdout).not.toContain('Coupon SPRING10')
  })

  test('--date defaults to today', () => {
    const q = quoteJson('cart-expiry-default.json', ...CATALOG)
    expect(q.ignoredCoupons).toMatchObject([{ code: 'OLD5', reason: 'expired' }])
    expect([q.discountCents, q.totalCents]).toEqual([125, 1817])
  })

  test('ignoredCoupons is present even when nothing was ignored', () => {
    expect(quoteJson('cart-basic-us.json', ...CATALOG).ignoredCoupons).toEqual([])
  })

  test('a malformed expires is a validation error', () => {
    expect(cli('quote', join(HERE, 'cart-expiry-bad.json'), ...CATALOG).code).toBe(2)
  })

  test('a malformed --date is a validation error', () => {
    const r = cli('quote', join(HERE, 'cart-basic-us.json'), ...CATALOG, '--date', 'tomorrow')
    expect(r.code).toBe(2)
    // The pristine CLI exits 2 here too, for not knowing --date at all.
    expect(r.stderr).not.toContain('unknown option')
  })
})
