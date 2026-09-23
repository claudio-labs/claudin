import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseArgs, run } from '../src/cli'

const root = fileURLToPath(new URL('..', import.meta.url))

function cli(...args: string[]) {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], { cwd: root })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

describe('cli', () => {
  test('prints a receipt', () => {
    const r = cli('quote', 'data/carts/basic-us.json')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^Total +\$38\.22$/m)
    expect(r.stderr).toBe('')
  })

  test('--region overrides the cart region', () => {
    const r = cli('quote', 'data/carts/basic-us.json', '--region', 'EU')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Quote for region EU (EUR)')
  })

  test('bad input exits with code 2 and a message on stderr', () => {
    const r = cli('quote', 'data/carts/missing.json')
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toStartWith('error: cannot read cart')
  })

  test('an unknown region is rejected', () => {
    expect(cli('quote', 'data/carts/basic-us.json', '--region', 'BR').code).toBe(2)
  })
})

describe('parseArgs', () => {
  test('defaults to the shipped catalog', () => {
    expect(parseArgs(['quote', 'cart.json']).catalogPath).toEndWith('data/catalog.json')
  })

  test('rejects unknown options', () => {
    expect(() => parseArgs(['quote', 'cart.json', '--verbose'])).toThrow('unknown option --verbose')
  })

  test('requires a cart file', () => {
    expect(() => parseArgs(['quote'])).toThrow('missing cart file')
  })
})

test('run() reports bad input without throwing', () => {
  const out: string[] = []
  const err: string[] = []
  const code = run(['price'], { out: t => out.push(t), err: t => err.push(t) })
  expect(code).toBe(2)
  expect(out).toEqual([])
  expect(err.join('')).toContain('usage:')
})
