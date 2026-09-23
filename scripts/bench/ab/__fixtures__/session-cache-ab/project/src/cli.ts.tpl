#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import { loadCart } from './cart'
import { loadCatalog } from './catalog'
import { PricingError, ValidationError } from './errors'
import { buildQuote } from './quote'
import { renderReceipt } from './receipt'
import { isRegionCode } from './regions'
import type { RegionCode } from './types'

export const USAGE = 'usage: bun run src/cli.ts quote <cart.json> [--region US|EU|UK] [--catalog <catalog.json>]'

export const DEFAULT_CATALOG = fileURLToPath(new URL('../data/catalog.json', import.meta.url))

export interface CliArgs {
  cartPath: string
  catalogPath: string
  region?: RegionCode
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv
  if (command !== 'quote') throw new ValidationError(USAGE)
  const args: Partial<CliArgs> = { catalogPath: DEFAULT_CATALOG }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--region' || arg === '--catalog') {
      const value = rest[++i]
      if (value === undefined) throw new ValidationError(arg + ' needs a value')
      if (arg === '--catalog') {
        args.catalogPath = value
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
    const quote = buildQuote(cart, catalog, { region: args.region })
    io.out(renderReceipt(quote))
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
