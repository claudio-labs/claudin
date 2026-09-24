import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
} from 'src/shared/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'

type Credit = typeof import('src/tools/BashTool/creditShownFiles.js')
type Shown = Parameters<Credit['creditShownFiles']>[0]
type ReadCredit = Awaited<ReturnType<Credit['creditShownFiles']>>

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

/**
 * Twenty modules of ~2.9k chars each: a loop over them prints ~59k, the size
 * of the dump session-cache-ab 20260924-170553 r1 received as a saved file
 * and read back whole. Every line names its file, so no file's lines can be
 * found inside another's.
 */
const DUMP_FILES = 20
const DUMP_LINES = 80
const dumpName = (i: number) => `dump/f${String(i).padStart(2, '0')}.ts`
function dumpModule(i: number): string {
  return (
    Array.from(
      { length: DUMP_LINES },
      (_, n) => `export const f${i}_${n} = '${'abcdefghij'[n % 10]!.repeat(12)}'`,
    ).join('\n') + '\n'
  )
}
const DUMP_LOOP = 'for f in dump/*.ts; do echo "=== $f"; cat $f; done'

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
/** A sibling of the fixture tree, outside every working directory. */
let outside: string
let priorOriginalCwd: string
let on: Credit
let off: Credit
let cache: FileStateCache

/**
 * Every fixture file is dated a minute back, as a checked-out tree predates
 * the commands run in it. The credit refuses a file written at or after the
 * command started, and a file written in the same millisecond a test starts
 * its command would be refused by chance.
 */
const BEFORE_ANY_COMMAND = new Date(Date.now() - 60_000)

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  utimesSync(path, BEFORE_ANY_COMMAND, BEFORE_ANY_COMMAND)
}

beforeAll(async () => {
  on = await loadCredit(true)
  off = await loadCredit(false)
  // The working-directory check stats through the fs implementation; defend
  // against a mock of it leaked from another file.
  setOriginalFsImplementation()
  dir = mkdtempSync(join(tmpdir(), 'bash-read-credit-'))
  outside = mkdtempSync(join(tmpdir(), 'bash-read-credit-outside-'))
  for (const [path, content] of Object.entries(FIXTURE)) {
    writeFixture(join(dir, path), content)
  }
  for (let i = 0; i < DUMP_FILES; i++) {
    writeFixture(join(dir, dumpName(i)), dumpModule(i))
  }
  // `git ls-files` needs a repository; an empty one lists nothing.
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFixture(
    join(outside, 'secret.ts'),
    "export const token = 'outside'\nexport const scope = 'machine'\n",
  )
  // The fixture tree is the session's project. The original cwd is always a
  // working directory, so it is pinned here rather than left to whatever an
  // earlier file set it to.
  priorOriginalCwd = getOriginalCwd()
  setOriginalCwd(dir)
})

afterAll(() => {
  setOriginalCwd(priorOriginalCwd)
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

beforeEach(() => {
  cache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
})

const at = (path: string) => join(dir, path)

/** What BashTool hands the model for `command` run in the fixture tree, unfiltered. */
function run(command: string): string {
  return execFileSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' }).trimEnd()
}

/** `command` run as BashTool runs it: the clock read just before, then its output. */
function ran(command: string): Shown & { stdout: string } {
  const startedAt = Date.now()
  return { command, startedAt, stdout: run(command) }
}

/** The credit as BashTool calls it, in a session whose project is the fixture tree. */
function creditWithNote(shown: Shown, instance: Credit = on): Promise<ReadCredit> {
  return instance.creditShownFiles(shown, cache, dir, getEmptyToolPermissionContext())
}

/** The files it credited. */
async function credit(shown: Shown, instance: Credit = on): Promise<readonly string[]> {
  return (await creditWithNote(shown, instance)).credited
}

/** The wrapper the pass-through puts on a read it left whole. */
function wrappedWhole(body: string): string {
  const lines = body.split('\n').length
  return `<bash-output-filtered original="" lines="${lines}/${lines}" reduction="0%">${body}</bash-output-filtered>`
}

/** The wrapper the pass-through puts on a read it left whole, since it has one of its own. */
function readWrapped(body: string): string {
  return `<bash-output-read>${body}</bash-output-read>`
}

const COUNT_AS_READ =
  'files printed whole — they count as read: Edit, Patch and Write accept them without a Read.)'

describe('a cut body credits only what it shows whole', () => {
  test('the 30 lines bench rep 1 received for its loop credit nothing', async () => {
    expect(
      await credit({ command: REP1_COMMAND, startedAt: Date.now(), stdout: REP1_RECEIVED }),
    ).toEqual([])
    expect(cache.size).toBe(0)
  })

  // The cap's tail held the last file of rep 3's loop from its first line to
  // its last: the model did see that one, and only that one.
  test('the 30 lines bench rep 3 received credit the one file its tail holds whole', async () => {
    expect(
      await credit({ command: REP3_COMMAND, startedAt: Date.now(), stdout: REP3_RECEIVED }),
    ).toEqual([at('data/carts/uk-books.json')])
    expect(cache.has(at('data/carts/coupons-eu.json'))).toBe(false)
    expect(cache.has(at('src/cart.ts'))).toBe(false)
  })
})

describe('a complete read credits every file it printed', () => {
  test('`cat README.md package.json` credits both, as a whole-file Read would', async () => {
    const command = 'cat README.md package.json'
    expect(await credit(ran(command))).toEqual([at('README.md'), at('package.json')])

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
    expect(await credit(ran(command))).toEqual([
      at('src/types.ts'),
      at('data/carts/uk-books.json'),
    ])
  })

  test('a whole read inside the pass-through wrapper credits', async () => {
    const shown = ran('for f in src/*.ts; do echo "=== $f"; cat $f; done')
    expect(
      await credit({ ...shown, stdout: wrappedWhole(shown.stdout) }),
    ).toHaveLength(12)
  })

  // BashTool trims the result's trailing whitespace, so a last file that ends
  // in a blank line arrives without it — the model still saw every line.
  test('a last file ending in a blank line credits despite the trim', async () => {
    writeFixture(at('trailing-blank.md'), '# notes\n\n- one\n- two\n\n')
    try {
      expect(await credit(ran('cat README.md trailing-blank.md'))).toEqual([
        at('README.md'),
        at('trailing-blank.md'),
      ])
    } finally {
      rmSync(at('trailing-blank.md'))
    }
  })

  test('an absolute path inside the project credits', async () => {
    expect(await credit(ran(`cat ${at('README.md')}`))).toEqual([at('README.md')])
  })

  test('nothing is credited with the flag off', async () => {
    expect(await credit(ran('cat README.md package.json'), off)).toEqual([])
    expect(cache.size).toBe(0)
  })

  test('a whole read inside the read wrapper credits, from 8k up as below it', async () => {
    const shown = ran(DUMP_LOOP.replace('dump/*.ts', [0, 1, 2, 3].map(dumpName).join(' ')))
    expect(shown.stdout.length).toBeGreaterThan(8_000)
    expect(await credit({ ...shown, stdout: readWrapped(`${shown.stdout}\n`) })).toEqual(
      [0, 1, 2, 3].map(i => at(dumpName(i))),
    )
  })
})

// `catReadsOf` (fileReadShape.ts): the cat segments of any command, not only
// of a command that does nothing but print files.
describe('a cat in any command credits what it printed whole', () => {
  // The first call of every session-cache-ab run of 2026-09-24.
  test('`git ls-files && cat README.md package.json` credits both', async () => {
    expect(await credit(ran('git ls-files && cat README.md package.json'))).toEqual([
      at('README.md'),
      at('package.json'),
    ])
  })

  test('another program before the cat', async () => {
    expect(await credit(ran('git status --short && cat README.md'))).toEqual([at('README.md')])
  })

  // A short file passes `head` whole, so only the pipe itself keeps it out.
  test('`cat f | head` credits nothing', async () => {
    const shown = ran('cat README.md | head -20')
    expect(shown.stdout).toBe(FIXTURE['README.md']!.trimEnd())
    expect(await creditWithNote(shown)).toEqual({ credited: [], note: null })
  })

  // package.json's bytes reach the output through the copy; the redirect is
  // what keeps them from crediting it.
  test('`cat f > g` credits nothing, even when g is printed next', async () => {
    try {
      const shown = ran('cat package.json > copy.json && cat copy.json')
      expect(shown.stdout).toBe(FIXTURE['package.json']!.trimEnd())
      expect(await creditWithNote(shown)).toEqual({ credited: [], note: null })
    } finally {
      rmSync(at('copy.json'), { force: true })
    }
  })

  // What the floor cap made of `git status && cat README.md src/types.ts`:
  // the README whole in the head, types.ts cut through the middle.
  test('a file the cap cut through is not credited, and the line says so', async () => {
    const types = TYPES_TS.trimEnd().split('\n')
    const readme = FIXTURE['README.md']!.trimEnd().split('\n')
    const body = [
      'On branch main',
      ...readme,
      ...types.slice(0, 26 - readme.length),
      '…33 lines omitted…',
      ...types.slice(-15),
    ].join('\n')
    const result = await creditWithNote({
      command: 'git status && cat README.md src/types.ts',
      startedAt: Date.now(),
      stdout: `<bash-output-filtered original="" lines="42/75" reduction="44%">${body}</bash-output-filtered>`,
    })
    expect(result).toEqual({
      credited: [at('README.md')],
      note:
        '(1 file printed whole — it counts as read: Edit, Patch and Write accept it without a Read.) ' +
        'Not counted: src/types.ts (cut).',
    })
    expect(cache.has(at('src/types.ts'))).toBe(false)
  })

  test('a file written after the chain started is not credited, and the line says so', async () => {
    const shown = ran('git ls-files && cat README.md package.json')
    const afterStart = new Date(shown.startedAt + 1_000)
    utimesSync(at('package.json'), afterStart, afterStart)
    try {
      const result = await creditWithNote(shown)
      expect(result.credited).toEqual([at('README.md')])
      expect(result.note).toEndWith(' Not counted: package.json (changed since).')
      expect(cache.has(at('package.json'))).toBe(false)
    } finally {
      utimesSync(at('package.json'), BEFORE_ANY_COMMAND, BEFORE_ANY_COMMAND)
    }
  })

  test('with the flag off, a chain credits nothing either', async () => {
    expect(await creditWithNote(ran('git ls-files && cat README.md package.json'), off)).toEqual({
      credited: [],
      note: null,
    })
    expect(cache.size).toBe(0)
  })
})

// Untold, the credit changed nothing the model did (2026-09-23): it Read every
// file before editing it, as the tool contract says to.
describe('the line the result ends with', () => {
  test('two files', async () => {
    expect((await creditWithNote(ran('cat README.md package.json'))).note).toBe(
      `(2 ${COUNT_AS_READ}`,
    )
  })

  test('one file', async () => {
    expect((await creditWithNote(ran('cat README.md'))).note).toBe(
      '(1 file printed whole — it counts as read: Edit, Patch and Write accept it without a Read.)',
    )
  })

  test('the files that do not count, each with its reason', async () => {
    writeFixture(at('one-line.txt'), 'export {}\n')
    try {
      const result = await creditWithNote(
        ran(`cat README.md one-line.txt ${join(outside, 'secret.ts')} package.json`),
      )
      expect(result.credited).toEqual([at('README.md'), at('package.json')])
      expect(result.note).toBe(
        `(2 ${COUNT_AS_READ} Not counted: one-line.txt (one line), ${join(outside, 'secret.ts')} (outside the project).`,
      )
    } finally {
      rmSync(at('one-line.txt'))
    }
  })

  // Already read whole at this mtime: the entry stays the Read's, and the
  // file counts all the same.
  test('a file an earlier Read covers counts, without being credited again', async () => {
    cache.set(at('README.md'), {
      content: FIXTURE['README.md']!.replace(/\n$/, ''),
      timestamp: getFileModificationTime(at('README.md')),
      offset: 1,
      limit: undefined,
    })
    expect(await creditWithNote(ran('cat README.md package.json'))).toEqual({
      credited: [at('package.json')],
      note: `(2 ${COUNT_AS_READ}`,
    })
  })

  test('nothing counts, nothing is said', async () => {
    writeFixture(at('one-line.txt'), 'export {}\n')
    try {
      expect(await creditWithNote(ran('cat one-line.txt'))).toEqual({ credited: [], note: null })
    } finally {
      rmSync(at('one-line.txt'))
    }
  })

  // The line joins the result after the gates have measured it. A result it
  // would take past the summarizer's 8k must credit nothing: the model would
  // get a cut of it.
  test('an unwrapped result the line would take past 8k credits nothing', async () => {
    writeFixture(at('src/near8k.ts'), `// near 8k\n${'x'.repeat(7_950)}\n`)
    try {
      const shown = ran('cat src/near8k.ts')
      expect(shown.stdout.length).toBeLessThan(8_000)
      expect(shown.stdout.length + 120).toBeGreaterThanOrEqual(8_000)
      expect(await creditWithNote(shown)).toEqual({ credited: [], note: null })
      expect(cache.size).toBe(0)
      // Wrapped, the summarizer stands aside and the same read credits.
      expect(await credit({ ...shown, stdout: readWrapped(shown.stdout) })).toEqual([
        at('src/near8k.ts'),
      ])
    } finally {
      rmSync(at('src/near8k.ts'))
    }
  })

  test('a file the result already names as not shown is not named again', async () => {
    const shown = ran('cat README.md')
    const result = await creditWithNote({
      ...shown,
      command: 'cat README.md src/types.ts',
      notShown: ['src/types.ts'],
    })
    expect(result.note).toBe(
      '(1 file printed whole — it counts as read: Edit, Patch and Write accept it without a Read.)',
    )
  })
})

describe('what the model did not receive is never credited', () => {
  test('output persisted to disk: the model got a preview', async () => {
    expect(
      await credit({
        ...ran('cat README.md package.json'),
        persistedOutputPath: join(dir, 'tool-results', 'b1.txt'),
      }),
    ).toEqual([])
  })

  // Over the 30k BashTool's result is persisted at, the model gets a 2 KB
  // preview of a saved file, whatever wrapper the output wears — the wrapper
  // only answers the summarizer's 8k.
  test('a wrapped result over the 30k the harness persists at', async () => {
    const files = Array.from({ length: 11 }, (_, i) => dumpName(i))
    const shown = ran(DUMP_LOOP.replace('dump/*.ts', files.join(' ')))
    const stdout = readWrapped(`${shown.stdout}\n`)
    expect(stdout.length).toBeGreaterThan(30_000)
    expect(await creditWithNote({ ...shown, stdout })).toEqual({ credited: [], note: null })
    expect(cache.size).toBe(0)
  })

  // The tool-result summarizer cuts unwrapped Bash output from 8k chars up,
  // and stands aside for anything wearing the filter's wrapper.
  test('unwrapped output of 8k chars or more, and the same output wrapped', async () => {
    const big = Array.from(
      { length: 200 },
      (_, i) => `export const entry${i} = '${'x'.repeat(40)}'`,
    ).join('\n') + '\n'
    writeFixture(at('src/big.ts'), big)
    try {
      const shown = ran('cat src/big.ts')
      expect(shown.stdout.length).toBeGreaterThanOrEqual(8_000)
      expect(await credit(shown)).toEqual([])
      expect(await credit({ ...shown, stdout: wrappedWhole(shown.stdout) })).toEqual([
        at('src/big.ts'),
      ])
    } finally {
      rmSync(at('src/big.ts'))
    }
  })

  test('a file changed since the command ran is not credited', async () => {
    const shown = ran('cat README.md')
    writeFileSync(at('README.md'), `${FIXTURE['README.md']}one more line\n`)
    try {
      expect(await credit(shown)).toEqual([])
    } finally {
      writeFixture(at('README.md'), FIXTURE['README.md']!)
    }
  })

  // `cat a b` where `a` has no final newline prints b's first line glued to
  // a's last. Both files' bytes are in the output, and neither is shown as
  // the file it is.
  test('files glued together by a missing final newline are not credited', async () => {
    writeFixture(at('glued-a.txt'), 'alpha one\nbravo two')
    writeFixture(at('glued-b.txt'), 'charlie three\ndelta four\n')
    try {
      const shown = ran('cat glued-a.txt glued-b.txt')
      expect(shown.stdout).toContain('bravo twocharlie three')
      expect(await credit(shown)).toEqual([])
    } finally {
      rmSync(at('glued-a.txt'))
      rmSync(at('glued-b.txt'))
    }
  })

  test('a one-line file is not credited — one line proves nothing', async () => {
    writeFixture(at('one-line.txt'), 'export {}\n')
    try {
      expect(await credit(ran('cat one-line.txt README.md'))).toEqual([at('README.md')])
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
    expect(await credit(ran('cat README.md package.json'))).toEqual([at('package.json')])
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
    expect(await credit(ran('cat README.md package.json'))).toEqual([at('README.md')])
    expect(cache.get(at('package.json'))).toBe(marker)
  })
})

// The credit reads each file after the command has run. A file written in
// between may no longer hold what `cat` printed, and one cut down to its
// first lines still sits in the output line for line: credited at its new
// mtime, it would pass a Write built from the version the model saw.
describe('a file written once the command started is not credited', () => {
  test('a file truncated after `cat` printed it', async () => {
    const shown = ran('cat src/types.ts')
    const firstLines = TYPES_TS.split('\n').slice(0, 20).join('\n') + '\n'
    writeFileSync(at('src/types.ts'), firstLines)
    // Dated explicitly: the kernel stamps writes from a clock that can trail
    // Date.now() by a tick, longer than this test's `cat` takes.
    const afterStart = new Date(shown.startedAt + 1_000)
    utimesSync(at('src/types.ts'), afterStart, afterStart)
    try {
      expect(shown.stdout.startsWith(firstLines)).toBe(true)
      expect(await credit(shown)).toEqual([])
      expect(cache.has(at('src/types.ts'))).toBe(false)
    } finally {
      writeFixture(at('src/types.ts'), TYPES_TS)
    }
  })

  test('a file dated the very millisecond the command started', async () => {
    const shown = ran('cat README.md')
    const sameMs = new Date(shown.startedAt)
    utimesSync(at('README.md'), sameMs, sameMs)
    try {
      expect(await credit(shown)).toEqual([])
    } finally {
      utimesSync(at('README.md'), BEFORE_ANY_COMMAND, BEFORE_ANY_COMMAND)
    }
  })
})

// The summarizer and result persistence measure the tool result the model
// receives, which carries the stderr part (the cwd-reset note, an abort
// marker) and the background note after stdout.
describe('the run is judged by the tool result the model receives', () => {
  test('an interrupted run credits nothing', async () => {
    expect(await credit({ ...ran('cat README.md package.json'), interrupted: true })).toEqual([])
    expect(cache.size).toBe(0)
  })

  test('a run carrying the cwd-reset note credits nothing', async () => {
    expect(
      await credit({
        ...ran('cat README.md package.json'),
        stderr: `\nShell cwd was reset to ${dir}`,
      }),
    ).toEqual([])
    expect(cache.size).toBe(0)
  })

  // A run a new message backgrounded keeps its partial output, and the note
  // naming the task joins it in the same tool result.
  test('stdout under 8k that the background note takes past 8k credits nothing', async () => {
    // 7,900 chars: room for the credit's own line (~90 chars), which joins the
    // same result; the background note is what takes it past 8k.
    writeFixture(at('src/near8k.ts'), `// near 8k\n${'x'.repeat(7_888)}\n`)
    try {
      const shown = ran('cat src/near8k.ts')
      expect(shown.stdout.length).toBeLessThan(8_000)
      expect(await credit({ ...shown, backgroundTaskId: 'bnear8k' })).toEqual([])
      // Without the note the same stdout credits: the note is what counted.
      expect(await credit(shown)).toEqual([at('src/near8k.ts')])
    } finally {
      rmSync(at('src/near8k.ts'))
    }
  })
})

// A Read outside the working directories asks first, and a `cat` must not
// grant what that Read would have asked for.
describe('only files inside the working directories are credited', () => {
  test('a file outside, named by `../`, by an absolute path, or by an absolute glob', async () => {
    for (const command of [
      `cat ../${basename(outside)}/secret.ts`,
      `cat ${join(outside, 'secret.ts')}`,
      `cat ${outside}/*.ts`,
    ]) {
      const shown = ran(command)
      expect(shown.stdout).toContain("export const token = 'outside'")
      expect(await credit(shown)).toEqual([])
    }
    expect(cache.size).toBe(0)
  })
})

// CLAUDIN_BASH_FILE_READ_PASSTHROUGH past the 28k it shows whole: the whole
// files that fit, and the rest by name. The flag is the filter's
// (`overBudgetFileRead`, floor.test.ts); this is the half that reads files.
describe('fitWholeFiles — a read too long to show whole', () => {
  const DUMP_READS = [{ text: 'dump/*.ts', glob: true }]
  const BUDGET = 28_000

  test('the 57k dump comes back as the whole files within 28k, and the rest by name', async () => {
    const stdout = run(DUMP_LOOP)
    expect(stdout.length).toBeGreaterThan(55_000)
    const fitted = (await on.fitWholeFiles(stdout, DUMP_READS, dir, BUDGET))!
    expect(fitted.shown.length).toBeLessThanOrEqual(BUDGET)
    expect(stdout.startsWith(fitted.shown)).toBe(true)

    const shownFiles = DUMP_FILES - fitted.notShown.length
    expect(shownFiles).toBeGreaterThan(5)
    for (let i = 0; i < DUMP_FILES; i++) {
      expect(fitted.shown.includes(`=== ${dumpName(i)}\n${dumpModule(i)}`)).toBe(i < shownFiles)
    }
    // The cut falls where the last whole file ends, header of the next one out…
    expect(fitted.shown).toEndWith(dumpModule(shownFiles - 1))
    // …because the next one would end past the budget.
    const next = `=== ${dumpName(shownFiles)}\n${dumpModule(shownFiles)}`
    expect(fitted.shown.length + next.length).toBeGreaterThan(BUDGET)
    expect(fitted.notShown).toEqual(
      Array.from({ length: fitted.notShown.length }, (_, k) => dumpName(shownFiles + k)),
    )
    expect(fitted.namesAll).toBe(true)
  })

  // A spill leaves stdout holding the first 30 KB, which holds what fits in 28k.
  test('the first 30 KB a spill leaves fits the same', async () => {
    const stdout = run(DUMP_LOOP)
    expect(await on.fitWholeFiles(stdout.slice(0, 30_000), DUMP_READS, dir, BUDGET)).toEqual(
      await on.fitWholeFiles(stdout, DUMP_READS, dir, BUDGET),
    )
  })

  test('the cat -n form fits the same way', async () => {
    const stdout = run(DUMP_LOOP.replace('cat $f', 'cat -n $f'))
    const fitted = (await on.fitWholeFiles(stdout, DUMP_READS, dir, BUDGET))!
    expect(fitted.shown.length).toBeLessThanOrEqual(BUDGET)
    expect(fitted.notShown.length).toBeLessThan(DUMP_FILES)
    const last = DUMP_FILES - fitted.notShown.length - 1
    expect(fitted.shown).toEndWith(`    ${DUMP_LINES}\texport const f${last}_${DUMP_LINES - 1} = 'jjjjjjjjjjjj'\n`)
  })

  // Past a file it cannot place, it cannot say where the next one starts.
  test('the walk stops at the first file it cannot find whole', async () => {
    const stdout = run(DUMP_LOOP)
    writeFileSync(at(dumpName(2)), `${dumpModule(2)}// changed since\n`)
    try {
      const fitted = (await on.fitWholeFiles(stdout, DUMP_READS, dir, BUDGET))!
      expect(fitted.shown).toEndWith(dumpModule(1))
      expect(fitted.notShown).toEqual(
        Array.from({ length: DUMP_FILES - 2 }, (_, k) => dumpName(k + 2)),
      )
    } finally {
      writeFixture(at(dumpName(2)), dumpModule(2))
    }
  })

  // shell-quote hands a bracket-only glob back as a plain word, so the path
  // named is one that does not exist; with nothing placed, the cap does better.
  test('when not even the first file can be placed, it leaves the read alone', async () => {
    const stdout = run('for f in dump/f0[0-9].ts; do echo "=== $f"; cat $f; done')
    expect(stdout.length).toBeGreaterThan(28_000)
    expect(
      await on.fitWholeFiles(stdout, [{ text: 'dump/f0[0-9].ts', glob: false }], dir, BUDGET),
    ).toBeNull()
  })

  // `cat a b a` prints `a` twice, so the files past the cut can repeat one
  // named before it, or one another.
  test('each file left out is named once, and none it showed', async () => {
    const names = [dumpName(0), dumpName(1), dumpName(0), dumpName(2), dumpName(1)]
    const fitted = (await on.fitWholeFiles(
      run(`cat ${names.join(' ')}`),
      names.map(text => ({ text, glob: false })),
      dir,
      4_000,
    ))!
    expect(fitted.shown).toBe(dumpModule(0))
    expect(fitted.notShown).toEqual([dumpName(1), dumpName(2)])
  })

  test('a single file over the budget shows nothing, and is named', async () => {
    const stdout = run('cat dump/f00.ts dump/f01.ts')
    const fitted = (await on.fitWholeFiles(
      stdout,
      [{ text: 'dump/f00.ts', glob: false }, { text: 'dump/f01.ts', glob: false }],
      dir,
      2_000,
    ))!
    expect(fitted).toEqual({ shown: '', notShown: ['dump/f00.ts', 'dump/f01.ts'], namesAll: true })
  })

  test('the files it keeps count as read, and the line does not name the rest twice', async () => {
    const shown = ran(DUMP_LOOP)
    const fitted = (await on.fitWholeFiles(shown.stdout, DUMP_READS, dir, BUDGET))!
    const result = await creditWithNote({
      ...shown,
      stdout: readWrapped(fitted.shown),
      notShown: fitted.notShown,
    })
    const shownFiles = DUMP_FILES - fitted.notShown.length
    expect(result.credited).toEqual(Array.from({ length: shownFiles }, (_, i) => at(dumpName(i))))
    expect(result.note).toBe(`(${shownFiles} ${COUNT_AS_READ}`)
  })

  describe('the line that names what was left out', () => {
    test('the names, and what to do about them', () => {
      expect(
        on.renderNotShownNote({ shown: '', notShown: ['dump/f18.ts', 'dump/f19.ts'], namesAll: true }, BUDGET),
      ).toBe(
        'Not shown — over the 28k a Bash result shows whole: dump/f18.ts, dump/f19.ts. cat them in another call, or Read them.',
      )
    })

    // It follows up to 28k chars of files, under a 30k result.
    test('a long list is cut short', () => {
      const names = Array.from({ length: 100 }, (_, i) => `src/generated/module-${i}.ts`)
      const note = on.renderNotShownNote({ shown: '', notShown: names, namesAll: true }, BUDGET)!
      expect(note.length).toBeLessThan(1_000)
      expect(note).toStartWith('Not shown — over the 28k a Bash result shows whole: src/generated/module-0.ts, ')
      expect(note).toEndWith(' and more. cat them in another call, or Read them.')
    })

    test('a glob wider than was counted says there is more', () => {
      expect(
        on.renderNotShownNote({ shown: '', notShown: ['a.ts'], namesAll: false }, BUDGET),
      ).toBe('Not shown — over the 28k a Bash result shows whole: a.ts and more. cat them in another call, or Read them.')
    })

    test('nothing left out, nothing said', () => {
      expect(on.renderNotShownNote({ shown: 'x', notShown: [], namesAll: true }, BUDGET)).toBeNull()
    })
  })
})
