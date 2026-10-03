/**
 * What the secret scanner flags, judged only by outcome: a piece of text is
 * either flagged (with which credential family, and the label the user and the
 * model will read) or let through.
 *
 * Every credential-shaped fixture is glued together at run time from a vendor
 * prefix and a generated body, so this file never holds a token-shaped literal
 * for the repository's own scanners (push protection, verify:privacy) to trip
 * on. The bodies cycle through a fixed alphabet, which keeps them deterministic.
 */
import { describe, expect, test } from 'bun:test'
import { scanForSecrets, type SecretMatch } from 'src/memory/memdir/secretScanner.js'

/** `n` characters drawn in turn from `alphabet`, starting at `offset`. */
function body(alphabet: string, n: number, offset = 0): string {
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet[(i + offset) % alphabet.length]
  return out
}

/** Glues the parts; the only way a fixture in this file is ever spelled. */
const glue = (...parts: string[]): string => parts.join('')

const HEX = '0f1e2d3c4b5a6978'
const HEX_MIXED = '0F1e2D3c4B5a6978'
const BASE32 = 'QWERTYUPASDFGHJKLZXCVBNM234567'
const ALNUM = 'q7Wr2Ty9Up4As6Df8Gh3Jk5Lz1Xc0Vb'
const LETTERS = 'qwertyuiopASDFGHJKLzxcvbnm'
const WORDISH = 'q7W_r2T-y9U_p4A-s6D_f8G'
const B64 = 'Qw7+Er2/Ty9Up4As6Df8Gh3Jk5Lz1Xc0'
const DIGITS = '8172635409'

const dash5 = '-'.repeat(5)
const pemBody = (n: number): string => body(B64, n)
const pem = (kind: string, inner: string): string =>
  glue(dash5, 'BEGIN ', kind, dash5, '\n', inner, '\n', dash5, 'END ', kind, dash5)

type Family = {
  ruleId: string
  label: string
  /** A realistic sample, standing alone on its line. */
  sample: string
}

/**
 * One realistic sample per family, in the order the scanner reports
 * families (the spec lists the same order).
 */
const FAMILIES: Family[] = [
  { ruleId: 'aws-access-token', label: 'AWS Access Token', sample: glue('AK', 'IA', body(BASE32, 16)) },
  { ruleId: 'gcp-api-key', label: 'GCP API Key', sample: glue('AI', 'za', body(WORDISH, 35)) },
  {
    ruleId: 'azure-ad-client-secret',
    label: 'Azure AD Client Secret',
    sample: glue('xYz', '7', 'Q', '~', body(ALNUM, 32)),
  },
  { ruleId: 'digitalocean-pat', label: 'DigitalOcean PAT', sample: glue('dop', '_v1_', body(HEX, 64)) },
  {
    ruleId: 'digitalocean-access-token',
    label: 'DigitalOcean Access Token',
    sample: glue('doo', '_v1_', body(HEX, 64)),
  },
  {
    ruleId: 'anthropic-api-key',
    label: 'Anthropic API Key',
    sample: glue(['sk', 'ant', 'api03'].join('-'), '-', body(WORDISH, 93), 'AA'),
  },
  {
    ruleId: 'anthropic-admin-api-key',
    label: 'Anthropic Admin API Key',
    sample: glue(['sk', 'ant', 'admin01'].join('-'), '-', body(WORDISH, 93), 'AA'),
  },
  {
    ruleId: 'openai-api-key',
    label: 'OpenAI API Key',
    sample: glue('sk-', 'proj-', body(WORDISH, 74), 'T3Blbk', 'FJ', body(WORDISH, 74, 2)),
  },
  {
    ruleId: 'huggingface-access-token',
    label: 'HuggingFace Access Token',
    sample: glue('hf', '_', body(LETTERS, 34)),
  },
  { ruleId: 'github-pat', label: 'GitHub PAT', sample: glue('gh', 'p_', body(ALNUM, 36)) },
  {
    ruleId: 'github-fine-grained-pat',
    label: 'GitHub Fine Grained PAT',
    sample: glue('github', '_pat_', body('A1b2C3d4E5_f6G7h8', 82)),
  },
  { ruleId: 'github-app-token', label: 'GitHub App Token', sample: glue('gh', 's_', body(ALNUM, 36)) },
  { ruleId: 'github-oauth', label: 'GitHub OAuth', sample: glue('gh', 'o_', body(ALNUM, 36)) },
  { ruleId: 'github-refresh-token', label: 'GitHub Refresh Token', sample: glue('gh', 'r_', body(ALNUM, 36)) },
  { ruleId: 'gitlab-pat', label: 'GitLab PAT', sample: glue('gl', 'pat-', body(WORDISH, 20)) },
  { ruleId: 'gitlab-deploy-token', label: 'GitLab Deploy Token', sample: glue('gl', 'dt-', body(WORDISH, 20)) },
  {
    ruleId: 'slack-bot-token',
    label: 'Slack Bot Token',
    sample: glue('xo', 'xb-', body(DIGITS, 12), '-', body(DIGITS, 13, 4), '-', body(ALNUM, 24)),
  },
  {
    ruleId: 'slack-user-token',
    label: 'Slack User Token',
    sample: glue(
      'xo',
      'xp-',
      body(DIGITS, 11),
      '-',
      body(DIGITS, 12, 1),
      '-',
      body(DIGITS, 10, 2),
      '-',
      body(ALNUM, 32),
    ),
  },
  {
    ruleId: 'slack-app-token',
    label: 'Slack App Token',
    sample: glue('xa', 'pp-1-', 'A0B1C2D3E4', '-', body(DIGITS, 13), '-', body(HEX, 40)),
  },
  { ruleId: 'twilio-api-key', label: 'Twilio API Key', sample: glue('S', 'K', body(HEX_MIXED, 32)) },
  {
    ruleId: 'sendgrid-api-token',
    label: 'SendGrid API Token',
    sample: glue('S', 'G.', body(ALNUM, 22), '.', body(WORDISH, 43)),
  },
  { ruleId: 'npm-access-token', label: 'NPM Access Token', sample: glue('np', 'm_', body(ALNUM, 36)) },
  {
    ruleId: 'pypi-upload-token',
    label: 'PyPI Upload Token',
    sample: glue('pypi-', 'AgEIcHlwaS5vcmc', body(WORDISH, 120)),
  },
  { ruleId: 'databricks-api-token', label: 'Databricks API Token', sample: glue('da', 'pi', body(HEX, 32)) },
  {
    ruleId: 'hashicorp-tf-api-token',
    label: 'HashiCorp TF API Token',
    sample: glue(body(ALNUM, 14), '.', 'atlas', 'v1.', body(WORDISH, 64)),
  },
  { ruleId: 'pulumi-api-token', label: 'Pulumi API Token', sample: glue('pu', 'l-', body(HEX, 40)) },
  {
    ruleId: 'postman-api-token',
    label: 'Postman API Token',
    sample: glue('PM', 'AK-', body(HEX_MIXED, 24), '-', body(HEX_MIXED, 34)),
  },
  {
    ruleId: 'grafana-api-key',
    label: 'Grafana API Key',
    sample: glue('eyJr', 'Ijoi', body(B64, 90), '=='),
  },
  {
    ruleId: 'grafana-cloud-api-token',
    label: 'Grafana Cloud API Token',
    sample: glue('gl', 'c_', body(B64, 48), '='),
  },
  {
    ruleId: 'grafana-service-account-token',
    label: 'Grafana Service Account Token',
    sample: glue('gl', 'sa_', body(ALNUM, 32), '_', body(HEX, 8)),
  },
  { ruleId: 'sentry-user-token', label: 'Sentry User Token', sample: glue('snt', 'ryu_', body(HEX, 64)) },
  {
    ruleId: 'sentry-org-token',
    label: 'Sentry Org Token',
    sample: glue('snt', 'rys_', 'eyJpYXQiO', body(B64, 24), 'LCJyZWdpb25fdXJs', body(B64, 30, 5), '=', '_', body(B64, 43, 9)),
  },
  {
    ruleId: 'stripe-access-token',
    label: 'Stripe Access Token',
    sample: glue('sk', '_live_', body(ALNUM, 24)),
  },
  {
    ruleId: 'shopify-access-token',
    label: 'Shopify Access Token',
    sample: glue('shp', 'at_', body(HEX_MIXED, 32)),
  },
  {
    ruleId: 'shopify-shared-secret',
    label: 'Shopify Shared Secret',
    sample: glue('shp', 'ss_', body(HEX_MIXED, 32)),
  },
  {
    ruleId: 'private-key',
    label: 'Private Key',
    sample: pem('RSA PRIVATE KEY', pemBody(64) + '\n' + pemBody(40)),
  },
]

const flagged = (text: string): string[] => scanForSecrets(text).map(m => m.ruleId)

describe('each credential family is flagged on a realistic sample', () => {
  test.each(FAMILIES.map(f => [f.ruleId, f] as const))('%s', (_id, family) => {
    // Alone, inside a note, and as a quoted assignment: always exactly one family.
    for (const text of [
      family.sample,
      `Deploy notes\n\nThe staging token is ${family.sample}\nRotate it monthly.\n`,
      `export SERVICE_TOKEN="${family.sample}"`,
    ]) {
      expect(scanForSecrets(text)).toEqual([
        { ruleId: family.ruleId, label: family.label },
      ])
    }
  })
})

describe('more shapes of the same families', () => {
  const otherShapes: Array<[string, string, string]> = [
    ['an AWS temporary key', glue('AS', 'IA', body(BASE32, 16, 7)), 'aws-access-token'],
    ['an AWS key with the A3T prefix', glue('A3', 'TX', body(BASE32, 16, 2)), 'aws-access-token'],
    [
      'an OpenAI key of the legacy shape',
      glue('sk-', body(ALNUM, 20), 'T3Blbk', 'FJ', body(ALNUM, 20, 6)),
      'openai-api-key',
    ],
    [
      'an OpenAI service-account key',
      glue('sk-', 'svcacct-', body(WORDISH, 58), 'T3Blbk', 'FJ', body(WORDISH, 58, 1)),
      'openai-api-key',
    ],
    ['a GitHub user-to-server token', glue('gh', 'u_', body(ALNUM, 36, 3)), 'github-app-token'],
    ['a Databricks token with its numeric suffix', glue('da', 'pi', body(HEX, 32), '-2'), 'databricks-api-token'],
    ['a Stripe restricted test key', glue('rk', '_test_', body(ALNUM, 30)), 'stripe-access-token'],
    ['a Stripe key in its prod mode', glue('sk', '_prod_', body(ALNUM, 12)), 'stripe-access-token'],
    ['a Slack config token', glue('xo', 'xe-', body(DIGITS, 10), '-', body(DIGITS, 10), '-', body(DIGITS, 10), '-', body(ALNUM, 28)), 'slack-user-token'],
    ['an OpenSSH private key', pem('OPENSSH PRIVATE KEY', pemBody(70)), 'private-key'],
    ['an EC private key', pem('EC PRIVATE KEY', pemBody(120)), 'private-key'],
    // 62 characters plus the two line breaks: the shortest body that counts.
    ['a PKCS#8 private key with the shortest body', pem('PRIVATE KEY', pemBody(62)), 'private-key'],
    ['a PGP private key block', pem('PGP PRIVATE KEY BLOCK', pemBody(80)), 'private-key'],
    ['an encrypted private key', pem('ENCRYPTED PRIVATE KEY', pemBody(80)), 'private-key'],
    [
      'a Sentry org token with the other region spelling',
      glue('snt', 'rys_', 'eyJpYXQiO', body(B64, 12), 'cmVnaW9uX3VybCI6', body(B64, 12, 2), '_', body(B64, 43)),
      'sentry-org-token',
    ],
  ]
  for (const [what, text, ruleId] of otherShapes) {
    test(`${what} counts as ${ruleId}`, () => expect(flagged(text)).toEqual([ruleId]))
  }
})

const LOOKALIKES: Record<string, string> = Object.fromEntries([
  ['plain memory prose', '**Why:** the deploy needs a token from the vault. **How:** `gh auth token`, never paste it.'],
  ['an empty note', ''],
  ['a vendor prefix on its own', 'Keys start with AKIA, tokens with ghp_ and glpat-; see the vault.'],
  ['a git commit hash', body(HEX, 40)],
  ['a UUID', 'run 3f2b8c1e-9d4a-4e7f-b6a5-0c1d2e3f4a5b failed'],
  ['an AWS-shaped key in lowercase', glue('ak', 'ia', body(BASE32, 16).toLowerCase())],
  ['an AWS-shaped key one character short', glue('AK', 'IA', body(BASE32, 15))],
  ['an AWS-shaped key one character long', glue('AK', 'IA', body(BASE32, 17))],
  ['an AWS-shaped key with digits outside 2-7', glue('AK', 'IA', '0189'.repeat(4))],
  ['an AWS-shaped key glued to a word', glue('X', 'AK', 'IA', body(BASE32, 16))],
  ['a GitHub-shaped token one character short', glue('gh', 'p_', body(ALNUM, 35))],
  ['a GitHub-shaped token in capitals', glue('GH', 'P_', body(ALNUM, 36))],
  ['a GitHub placeholder', 'GITHUB_TOKEN=ghp_<your-token-here>'],
  ['an environment reference', 'token: ${GITHUB_TOKEN} and ${NPM_TOKEN}'],
  ['an npm-shaped token glued to a word', glue('x', 'np', 'm_', body(ALNUM, 36))],
  ['an npm-shaped token one character long', glue('np', 'm_', body(ALNUM, 37))],
  ['a Stripe publishable key', glue('pk', '_live_', body(ALNUM, 24))],
  ['a Stripe-shaped key with a short tail', glue('sk', '_live_', body(ALNUM, 9))],
  ['a Slack-shaped bot token with short ids', glue('xo', 'xb-', body(DIGITS, 9), '-', body(DIGITS, 9))],
  ['a public key', pem('PUBLIC KEY', pemBody(200))],
  ['a certificate', pem('CERTIFICATE', pemBody(300))],
  ['a private-key header with a short body', pem('RSA PRIVATE KEY', pemBody(40))],
  ['a private key one character under the shortest body', pem('PRIVATE KEY', pemBody(61))],
  ['a private-key header that never ends', glue(dash5, 'BEGIN RSA PRIVATE KEY', dash5, '\n', pemBody(200))],
  ['a Databricks-shaped token in capitals', glue('da', 'pi', body(HEX, 32).toUpperCase())],
  ['a Hugging Face-shaped token with digits', glue('hf', '_', body(ALNUM, 34))],
  ['a Terraform-shaped token with a capitalized marker', glue(body(ALNUM, 14), '.', 'Atlas', 'v1.', body(WORDISH, 64))],
])

describe('text that only resembles a credential goes through', () => {
  for (const what of Object.keys(LOOKALIKES)) {
    test(what, () => expect(scanForSecrets(LOOKALIKES[what]!)).toHaveLength(0))
  }
})

describe('where a credential ends', () => {
  // Most families only count when the token stops at a recognized
  // terminator; npm stands in for them here.
  const npm = glue('np', 'm_', body(ALNUM, 36))
  // Each tail starts right where the token stops.
  const tails =
    '| and more|\nnext line|\tcolumn|"|\'|`|; export X=1|\\n"}|\\r'.split('|')
  test('a token is flagged when the text ends or a recognized terminator follows', () => {
    for (const tail of tails) {
      expect({ tail, flagged: flagged(`NPM_TOKEN=${npm}${tail}`) }).toEqual({
        tail,
        flagged: ['npm-access-token'],
      })
    }
  })

  test('an AWS key ends at any character that is not part of a word', () => {
    const aws = glue('AK', 'IA', body(BASE32, 16))
    for (const after of ['.', ',', ')', ']', '>', '/']) {
      expect(flagged(`key (${aws}${after}`)).toEqual(['aws-access-token'])
    }
    expect(flagged(`${aws}_suffix`)).toEqual([])
  })

  test('families without a terminator rule are flagged inside a longer run', () => {
    expect(flagged(glue('gh', 'p_', body(ALNUM, 50)))).toEqual(['github-pat'])
    expect(flagged(glue('prefix', 'gh', 'p_', body(ALNUM, 36)))).toEqual(['github-pat'])
    expect(flagged(glue('gl', 'pat-', body(WORDISH, 30)))).toEqual(['gitlab-pat'])
  })

  test('the Azure secret needs a delimiter on both sides', () => {
    const secret = glue('xYz', '7', 'Q', '~', body(ALNUM, 32))
    for (const wrapped of [`(${secret})`, `client_secret=${secret}`, `"${secret}",`, `> ${secret}<`]) {
      expect(flagged(wrapped)).toEqual(['azure-ad-client-secret'])
    }
    expect(flagged(`id${secret}`)).toEqual([])
    expect(flagged(`${secret}!`)).toEqual([])
  })

  test('letter case only matters where the vendor fixes it', () => {
    expect(flagged(glue('XA', 'PP-1-', 'A0B1C2D3E4', '-', body(DIGITS, 13), '-', body(HEX, 40)))).toEqual([
      'slack-app-token',
    ])
    expect(flagged(pem('rsa private key', pemBody(64)).replace(/BEGIN|END/g, s => s.toLowerCase()))).toEqual([
      'private-key',
    ])
  })
})

describe('what a scan returns', () => {
  test('every family present is reported once, in family order, whatever the text order', () => {
    const everything = [...FAMILIES].reverse().map(f => `- ${f.sample}`).join('\n')
    expect(flagged(everything)).toEqual(FAMILIES.map(f => f.ruleId))
  })

  test('a family seen many times is reported once', () => {
    const pat = FAMILIES.find(f => f.ruleId === 'github-pat')!.sample
    const aws = FAMILIES[0]!.sample
    expect(scanForSecrets(`${pat}\n${aws}\n${pat}\n${aws}`)).toEqual([
      { ruleId: 'aws-access-token', label: 'AWS Access Token' },
      { ruleId: 'github-pat', label: 'GitHub PAT' },
    ])
  })

  test('a match names the family and never carries the matched text', () => {
    for (const family of FAMILIES) {
      const [match] = scanForSecrets(`token ${family.sample}`) as [SecretMatch]
      expect(Object.keys(match).sort()).toEqual(['label', 'ruleId'])
      expect(JSON.stringify(match)).not.toContain(family.sample.slice(0, 24))
    }
  })

  test('scanning is repeatable: the same text gives the same answer every time', () => {
    const text = FAMILIES.map(f => f.sample).join(' ')
    const first = scanForSecrets(text)
    for (let i = 0; i < 3; i++) expect(scanForSecrets(text)).toEqual(first)
    expect(scanForSecrets('clean')).toEqual([])
    expect(scanForSecrets(text)).toEqual(first)
  })

  test('each call returns a new list', () => {
    const text = FAMILIES[0]!.sample
    const first = scanForSecrets(text)
    first.push({ ruleId: 'x', label: 'X' })
    expect(scanForSecrets(text)).toHaveLength(1)
  })
})
