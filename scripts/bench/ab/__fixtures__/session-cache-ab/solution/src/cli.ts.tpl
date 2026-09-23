#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import { isIsoDate, loadCart } from './cart'
import { loadCatalog } from './catalog'
import { PricingError, ValidationError } from './errors'
import { buildQuote } from './quote'
import { renderReceipt } from './receipt'
import { isRegionCode } from './regions'
import type { Quote, RegionCode } from './types'

export const USAGE =
  'usage: bun run src/cli.ts quote <cart.json> [--region US|EU|UK] [--catalog <catalog.json>] [--date YYYY-MM-DD] [--json]'

export const DEFAULT_CATALOG = fileURLToPath(new URL('../data/catalog.json', import.meta.url))

export interface CliArgs {
  cartPath: string
  catalogPath: string
  region?: RegionCode
  date?: string
  json: boolean
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv
  if (command !== 'quote') throw new ValidationError(USAGE)
  const args: Partial<CliArgs> = { catalogPath: DEFAULT_CATALOG, json: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--json') {
      args.json = true
    } else if (arg === '--region' || arg === '--catalog' || arg === '--date') {
      const value = rest[++i]
      if (value === undefined) throw new ValidationError(arg + ' needs a value')
      if (arg === '--catalog') {
        args.catalogPath = value
      } else if (arg === '--date') {
        if (!isIsoDate(value)) throw new ValidationError('--date must be a date like 2026-03-31')
        args.date = value
      } else if (isRegionCode(value)) {
        args.region = value
      } else {
        throw new ValidationError('unknown region ' + JSON.stringify(value))
      }
    } else if (arg.startsWith('--')) {
      throw new ValidationError('unknown option ' + arg + '\n' + USAGE)
    } else if (args.cartPath === undefined) {
      args.cartPath = arg
    } else {
      throw new ValidationError('unexpected argument ' + arg + '\n' + USAGE)
    }
  }
  if (args.cartPath === undefined) throw new ValidationError('missing cart file\n' + USAGE)
  return args as CliArgs
}

/** The `--json` shape: the totals, the lines without their per-line breakdown, and the ignored coupons. */
export function quoteToJson(quote: Quote) {
  return {
    currency: quote.currency,
    lines: quote.lines.map(line => ({ sku: line.sku, qty: line.qty, unitCents: line.unitCents, lineCents: line.lineCents })),
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    taxCents: quote.taxCents,
    shippingCents: quote.shippingCents,
    totalCents: quote.totalCents,
    ignoredCoupons: quote.ignoredCoupons ?? [],
  }
}

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

const processIo: Io = {
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(text),
}

/** Runs the CLI and returns its exit code: 0 ok, 2 bad input, 1 a bug. */
export function run(argv: readonly string[], io: Io = processIo): number {
  try {
    const args = parseArgs(argv)
    const catalog = loadCatalog(args.catalogPath)
    const cart = loadCart(args.cartPath)
    const quote = buildQuote(cart, catalog, { region: args.region, date: args.date })
    io.out(args.json ? JSON.stringify(quoteToJson(quote), null, 2) + '\n' : renderReceipt(quote))
    return 0
  } catch (e) {
    if (e instanceof PricingError) {
      io.err('error: ' + e.message + '\n')
      return 2
    }
    io.err('internal error: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)) + '\n')
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2))
}
