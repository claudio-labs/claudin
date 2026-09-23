import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
} from 'src/shared/fs/fileStateCache.js'

type Credit = typeof import('src/tools/BashTool/creditShownFiles.js')

const CREDIT_FLAG = 'CLAUDIN_BASH_READ_CREDIT'

/**
 * The flag is read once at module load, so each arm gets its own instance of
 * the module, loaded with the variable set the way that arm needs it.
 */
async function loadCredit(enabled: boolean): Promise<Credit> {
  const prior = process.env[CREDIT_FLAG]
  if (enabled) process.env[CREDIT_FLAG] = '1'
  else delete process.env[CREDIT_FLAG]
  try {
    return await import(
      `src/tools/BashTool/creditShownFiles.js?credit=${enabled}-${Date.now()}`
    )
  } finally {
    if (prior === undefined) delete process.env[CREDIT_FLAG]
    else process.env[CREDIT_FLAG] = prior
  }
}

// ---------------------------------------------------------------------------
// The workspace of session-cache-ab run 20260923-062408. The four files the
// recorded bodies below show any of are copied verbatim (cart.ts only up to
// what the model was shown); the rest only have to exist and not be shown.
// ---------------------------------------------------------------------------

const CART_TS =
  [
    "import { readFileSync } from 'node:fs'",
    "import { SKU_RE } from './catalog'",
    "import { CouponError, ValidationError } from './errors'",
    "import { getRegion } from './regions'",
    "import type { Cart, CartLine, Coupon } from './types'",
    '',
    'export const MAX_QTY = 999',
    'const COUPON_CODE_RE = /^[A-Z0-9]{3,16}$/',
    '',
    'export function parseCart(raw: unknown): Cart {',
    "  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {",
    "    throw new ValidationError('cart must be a JSON object')",
    '  }',
    '  const r = raw as Record<string, unknown>',
    '  return { region: getRegion(String(r.region)).code, lines: [], coupons: [] }',
    '}',
  ].join('\n') + '\n'

const TYPES_TS =
  [
    "import type { Cents } from './money'",
    '',
    "export type Currency = 'USD' | 'EUR' | 'GBP'",
    "export type RegionCode = 'US' | 'EU' | 'UK'",
    "export type TaxClass = 'standard' | 'reduced' | 'exempt'",
    '',
    'export interface Product {',
    '  sku: string',
    '  name: string',
    '  unitCents: Cents',
    '  category: string',
    '  taxClass: TaxClass',
    '  weightGrams: number',
    '}',
    '',
    'export interface CartLine {',
    '  sku: string',
    '  qty: number',
    '}',
    '',
    'export type Coupon =',
    "  | { code: string; kind: 'percent'; value: number }",
    "  | { code: string; kind: 'category'; category: string; value: number }",
    '',
    'export interface Cart {',
    '  region: RegionCode',
    '  lines: CartLine[]',
    '  coupons: Coupon[]',
    '}',
    '',
    '/** A cart line after the catalog lookup, before coupons. */',
    'export interface PricedLine {',
    '  product: Product',
    '  qty: number',
    '  unitCents: Cents',
    '  /** unitCents × qty */',
    '  lineCents: Cents',
    '}',
    '',
    'export interface QuoteLine {',
    '  sku: string',
    '  name: string',
    '  qty: number',
    '  unitCents: Cents',
    '  lineCents: Cents',
    '  /** What the coupons took off this line. */',
    '  discountCents: Cents',
    '  taxCents: Cents',
    '}',
    '',
    'export interface AppliedCoupon {',
    '  code: string',
    '  label: string',
    '  discountCents: Cents',
    '}',
    '',
    'export interface Quote {',
    '  region: RegionCode',
    '  currency: Currency',
    '  lines: QuoteLine[]',
    '  coupons: AppliedCoupon[]',
    '  subtotalCents: Cents',
    '  discountCents: Cents',
    '  taxCents: Cents',
    '  shippingCents: Cents',
    '  totalCents: Cents',
    '}',
  ].join('\n') + '\n'

const COUPONS_EU_JSON =
  [
    '{',
    '  "region": "EU",',
    '  "lines": [',
    '    { "sku": "COF-001", "qty": 2 },',
    '    { "sku": "TEA-003", "qty": 1 },',
    '    { "sku": "MUG-002", "qty": 2 }',
    '  ],',
    '  "coupons": [',
    '    { "code": "COFFEE15", "kind": "category", "category": "coffee", "value": 15 },',
    '    { "code": "WELCOME10", "kind": "percent", "value": 10 }',
    '  ]',
    '}',
  ].join('\n') + '\n'

const UK_BOOKS_JSON =
  [
    '{',
    '  "region": "UK",',
    '  "lines": [',
    '    { "sku": "BOK-001", "qty": 1 },',
    '    { "sku": "GFT-025", "qty": 1 },',
    '    { "sku": "FIL-001", "qty": 3 }',
    '  ],',
    '  "coupons": [',
    '    { "code": "BOOKS20", "kind": "category", "category": "books", "value": 20 }',
    '  ]',
    '}',
  ].join('\n') + '\n'

const OTHER_SOURCES = [
  'catalog',
  'cli',
  'discounts',
  'errors',
  'money',
  'quote',
  'receipt',
  'regions',
  'shipping',
  'tax',
]

const FIXTURE: Record<string, string> = {
  'README.md': '# checkout\n\nQuotes a cart: `bun run src/cli.ts quote <cart.json>`.\n',
  'package.json': '{\n  "name": "checkout",\n  "type": "module"\n}\n',
  'src/cart.ts': CART_TS,
  'src/types.ts': TYPES_TS,
  'data/catalog.json': '[\n  { "sku": "COF-001", "unitCents": 1299 }\n]\n',
  'data/carts/basic-us.json': '{\n  "region": "US",\n  "lines": []\n}\n',
  'data/carts/coupons-eu.json': COUPONS_EU_JSON,
  'data/carts/uk-books.json': UK_BOOKS_JSON,
  ...Object.fromEntries(
    OTHER_SOURCES.map(name => [
      `src/${name}.ts`,
      `// ${name}\nexport const ${name}Module = '${name}'\n`,
    ]),
  ),
}

// ---------------------------------------------------------------------------
// What two bench reps received for their loop, verbatim from the stream: the
// floor cap kept 15 + 15 of 616 and 665 lines.
// ---------------------------------------------------------------------------

const REP1_COMMAND = 'ls -R .claudin; for f in src/*.ts; do echo "=== $f"; cat $f; done'
const REP1_RECEIVED = [
  '<bash-output-filtered original="" lines="30/616" reduction="97%">.claudin:',
  'memory',
  'rules',
  '',
  '.claudin/memory:',
  'team',
  '',
  '.claudin/memory/team:',
  '',
  '.claudin/rules:',
  'search-strategy.md',
  '=== src/cart.ts',
  "import { readFileSync } from 'node:fs'",
  "import { SKU_RE } from './catalog'",
  "import { CouponError, ValidationError } from './errors'",
  '…587 lines omitted…',
  '  discountCents: Cents',
  '}',
  '',
  'export interface Quote {',
  '  region: RegionCode',
  '  currency: Currency',
  '  lines: QuoteLine[]',
  '  coupons: AppliedCoupon[]',
  '  subtotalCents: Cents',
  '  discountCents: Cents',
  '  taxCents: Cents',
  '  shippingCents: Cents',
  '  totalCents: Cents',
  '}',
  '</bash-output-filtered>',
].join('\n')

const REP3_COMMAND =
  'for f in src/*.ts package.json data/catalog.json data/carts/*.json; do echo "=== $f"; cat -n $f; done'
const REP3_RECEIVED = [
  '<bash-output-filtered original="" lines="30/665" reduction="96%">=== src/cart.ts',
  "     1\timport { readFileSync } from 'node:fs'",
  "     2\timport { SKU_RE } from './catalog'",
  "     3\timport { CouponError, ValidationError } from './errors'",
  "     4\timport { getRegion } from './regions'",
  "     5\timport type { Cart, CartLine, Coupon } from './types'",
  '     6\t',
  '     7\texport const MAX_QTY = 999',
  '     8\tconst COUPON_CODE_RE = /^[A-Z0-9]{3,16}$/',
  '     9\t',
  '    10\texport function parseCart(raw: unknown): Cart {',
  "    11\t  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {",
  "    12\t    throw new ValidationError('cart must be a JSON object')",
  '    13\t  }',
  '    14\t  const r = raw as Record<string, unknown>',
  '…636 lines omitted…',
  '    11\t  ]',
  '    12\t}',
  '=== data/carts/uk-books.json',
  '     1\t{',
  '     2\t  "region": "UK",',
  '     3\t  "lines": [',
  '     4\t    { "sku": "BOK-001", "qty": 1 },',
  '     5\t    { "sku": "GFT-025", "qty": 1 },',
  '     6\t    { "sku": "FIL-001", "qty": 3 }',
  '     7\t  ],',
  '     8\t  "coupons": [',
  '     9\t    { "code": "BOOKS20", "kind": "category", "category": "books", "value": 20 }',
  '    10\t  ]',
  '    11\t}',
  '</bash-output-filtered>',
].join('\n')

let dir: string
let on: Credit
let off: Credit
let cache: FileStateCache

beforeAll(async () => {
  on = await loadCredit(true)
  off = await loadCredit(false)
  dir = mkdtempSync(join(tmpdir(), 'bash-read-credit-'))
  for (const [path, content] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  cache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
})

const at = (path: string) => join(dir, path)

/** What BashTool hands the model for `command` run in the fixture tree, unfiltered. */
function run(command: string): string {
  return execFileSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' }).trimEnd()
}

/** The wrapper the pass-through puts on a read it left whole. */
function wrappedWhole(body: string): string {
  const lines = body.split('\n').length
  return `<bash-output-filtered original="" lines="${lines}/${lines}" reduction="0%">${body}</bash-output-filtered>`
}

describe('a cut body credits only what it shows whole', () => {
  test('the 30 lines bench rep 1 received for its loop credit nothing', async () => {
    expect(
      await on.creditShownFiles(
        { command: REP1_COMMAND, stdout: REP1_RECEIVED },
        cache,
        dir,
      ),
    ).toEqual([])
    expect(cache.size).toBe(0)
  })

  // The cap's tail held the last file of rep 3's loop from its first line to
  // its last: the model did see that one, and only that one.
  test('the 30 lines bench rep 3 received credit the one file its tail holds whole', async () => {
    expect(
      await on.creditShownFiles(
        { command: REP3_COMMAND, stdout: REP3_RECEIVED },
        cache,
        dir,
      ),
    ).toEqual([at('data/carts/uk-books.json')])
    expect(cache.has(at('data/carts/coupons-eu.json'))).toBe(false)
    expect(cache.has(at('src/cart.ts'))).toBe(false)
  })
})

describe('a complete read credits every file it printed', () => {
  test('`cat README.md package.json` credits both, as a whole-file Read would', async () => {
    const command = 'cat README.md package.json'
    expect(
      await on.creditShownFiles({ command, stdout: run(command) }, cache, dir),
    ).toEqual([at('README.md'), at('package.json')])

    for (const path of ['README.md', 'package.json']) {
      expect(cache.get(at(path))).toEqual({
        // What a Read stores: its line reader drops the final newline.
        content: FIXTURE[path]!.replace(/\n$/, ''),
        timestamp: getFileModificationTime(at(path)),
        offset: 1,
        limit: undefined,
        // The bytes reached the model in a Bash result, not a Read one: the
        // Read dedup stub must not claim "unchanged since your last read".
        dedupExempt: true,
      })
    }
  })

  test('the `cat -n` form credits', async () => {
    const command =
      'for f in src/types.ts data/carts/uk-books.json; do echo "=== $f"; cat -n $f; done'
    expect(
      await on.creditShownFiles({ command, stdout: run(command) }, cache, dir),
    ).toEqual([at('src/types.ts'), at('data/carts/uk-books.json')])
  })

  test('a whole read inside the pass-through wrapper credits', async () => {
    const command = 'for f in src/*.ts; do echo "=== $f"; cat $f; done'
    expect(
      await on.creditShownFiles(
        { command, stdout: wrappedWhole(run(command)) },
        cache,
        dir,
      ),
    ).toHaveLength(12)
  })

  // BashTool trims the result's trailing whitespace, so a last file that ends
  // in a blank line arrives without it — the model still saw every line.
  test('a last file ending in a blank line credits despite the trim', async () => {
    writeFileSync(at('trailing-blank.md'), '# notes\n\n- one\n- two\n\n')
    try {
      const command = 'cat README.md trailing-blank.md'
      expect(
        await on.creditShownFiles({ command, stdout: run(command) }, cache, dir),
      ).toEqual([at('README.md'), at('trailing-blank.md')])
    } finally {
      rmSync(at('trailing-blank.md'))
    }
  })

  test('nothing is credited with the flag off', async () => {
    const command = 'cat README.md package.json'
    expect(
      await off.creditShownFiles({ command, stdout: run(command) }, cache, dir),
    ).toEqual([])
    expect(cache.size).toBe(0)
  })
})

describe('what the model did not receive is never credited', () => {
  test('output persisted to disk: the model got a preview', async () => {
    const command = 'cat README.md package.json'
    expect(
      await on.creditShownFiles(
        {
          command,
          stdout: run(command),
          persistedOutputPath: join(dir, 'tool-results', 'b1.txt'),
        },
        cache,
        dir,
      ),
    ).toEqual([])
  })

  // The tool-result summarizer cuts unwrapped Bash output from 8k chars up,
  // and stands aside for anything wearing the filter's wrapper.
  test('unwrapped output of 8k chars or more, and the same output wrapped', async () => {
    const big = Array.from(
      { length: 200 },
      (_, i) => `export const entry${i} = '${'x'.repeat(40)}'`,
    ).join('\n') + '\n'
    writeFileSync(at('src/big.ts'), big)
    try {
      const command = 'cat src/big.ts'
      const stdout = run(command)
      expect(stdout.length).toBeGreaterThanOrEqual(8_000)
      expect(await on.creditShownFiles({ command, stdout }, cache, dir)).toEqual([])
      expect(
        await on.creditShownFiles(
          { command, stdout: wrappedWhole(stdout) },
          cache,
          dir,
        ),
      ).toEqual([at('src/big.ts')])
    } finally {
      rmSync(at('src/big.ts'))
    }
  })

  test('a file changed since the command ran is not credited', async () => {
    const command = 'cat README.md'
    const stdout = run(command)
    writeFileSync(at('README.md'), `${FIXTURE['README.md']}one more line\n`)
    try {
      expect(await on.creditShownFiles({ command, stdout }, cache, dir)).toEqual([])
    } finally {
      writeFileSync(at('README.md'), FIXTURE['README.md']!)
    }
  })

  // `cat a b` where `a` has no final newline prints b's first line glued to
  // a's last. Both files' bytes are in the output, and neither is shown as
  // the file it is.
  test('files glued together by a missing final newline are not credited', async () => {
    writeFileSync(at('glued-a.txt'), 'alpha one\nbravo two')
    writeFileSync(at('glued-b.txt'), 'charlie three\ndelta four\n')
    try {
      const command = 'cat glued-a.txt glued-b.txt'
      const stdout = run(command)
      expect(stdout).toContain('bravo twocharlie three')
      expect(await on.creditShownFiles({ command, stdout }, cache, dir)).toEqual([])
    } finally {
      rmSync(at('glued-a.txt'))
      rmSync(at('glued-b.txt'))
    }
  })

  test('a one-line file is not credited — one line proves nothing', async () => {
    writeFileSync(at('one-line.txt'), 'export {}\n')
    try {
      const command = 'cat one-line.txt README.md'
      expect(
        await on.creditShownFiles({ command, stdout: run(command) }, cache, dir),
      ).toEqual([at('README.md')])
    } finally {
      rmSync(at('one-line.txt'))
    }
  })

  // Overwriting a real Read's entry would release its clip pin and disarm its
  // dedup stub, and buy nothing: it already authorizes every write.
  test('an entry that already stands for the whole file is kept', async () => {
    const read = {
      content: FIXTURE['README.md']!.replace(/\n$/, ''),
      timestamp: getFileModificationTime(at('README.md')),
      offset: 1,
      limit: undefined,
      toolUseId: 'toolu_earlier_read',
    }
    cache.set(at('README.md'), read)
    const command = 'cat README.md package.json'
    expect(
      await on.creditShownFiles({ command, stdout: run(command) }, cache, dir),
    ).toEqual([at('package.json')])
    expect(cache.get(at('README.md'))).toBe(read)
  })

  // A clip-pin stand-down marker has its own replay budget; overwriting it
  // would reopen a gate that marker deliberately holds shut.
  test('an entry under a stand-down marker is left alone', async () => {
    const marker = {
      content: FIXTURE['package.json']!,
      timestamp: getFileModificationTime(at('package.json')),
      offset: 1,
      limit: undefined,
      isPartialView: true,
      standDownOutline: { message: 'outline', servedOutline: true, epoch: 0, replays: 0 },
    }
    cache.set(at('package.json'), marker)
    const command = 'cat README.md package.json'
    expect(
      await on.creditShownFiles({ command, stdout: run(command) }, cache, dir),
    ).toEqual([at('README.md')])
    expect(cache.get(at('package.json'))).toBe(marker)
  })
})
