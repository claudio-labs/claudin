/**
 * Credential detection for text bound for team memory.
 *
 * The families, their IDs and their token shapes follow the public gitleaks
 * rule set (https://github.com/gitleaks/gitleaks, MIT; see
 * THIRD_PARTY_NOTICES.md). Only the rules with a distinctive vendor prefix or
 * marker are kept: generic "long string near the word password" rules would
 * refuse ordinary notes. Where a token may end departs from gitleaks on
 * purpose (see `tokenEnd` in ./secretScanner/boundaries.ts).
 *
 * A match names its family and nothing else, because the guard's refusal is
 * read back by the model and can reach transcripts and logs.
 */

import { type TokenBoundary, withBoundary } from 'src/memory/memdir/secretScanner/boundaries.js'
import { containsPrivateKey } from 'src/memory/memdir/secretScanner/privateKey.js'

type SecretRule = {
  id: string
  label: string
  detect:
    | { token: string; boundary: TokenBoundary; anyCase?: true }
    | { scan: (text: string) => boolean }
}

export type SecretMatch = {
  ruleId: string
  label: string
}

const ANYWHERE: TokenBoundary = { kind: 'anywhere' }
const TOKEN_END: TokenBoundary = { kind: 'tokenEnd' }
const BASE64_TOKEN_END: TokenBoundary = { kind: 'tokenEnd', continuedBy: '+/=' }

/** Kept in pieces so neither this file nor the bundle spells the key prefix. */
const ANTHROPIC_PREFIX = ['sk', 'ant'].join('-')

const OPENAI_HALF = String.raw`(?:[\w-]{74}|[\w-]{58})`

function family(
  id: string,
  label: string,
  token: string,
  boundary: TokenBoundary,
  anyCase?: true,
): SecretRule {
  return { id, label, detect: { token, boundary, anyCase } }
}

/** In the order a scan reports them. */
const SECRET_RULES: readonly SecretRule[] = [
  family('aws-access-token', 'AWS Access Token', String.raw`(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z2-7]{16}`, { kind: 'word' }),
  family('gcp-api-key', 'GCP API Key', String.raw`AIza[\w-]{35}`, TOKEN_END),
  family('azure-ad-client-secret', 'Azure AD Client Secret', String.raw`[\w~.]{3}\dQ~[\w~.-]{31,34}`, { kind: 'azureDelimited' }),
  family('digitalocean-pat', 'DigitalOcean PAT', String.raw`dop_v1_[0-9a-f]{64}`, TOKEN_END),
  family('digitalocean-access-token', 'DigitalOcean Access Token', String.raw`doo_v1_[0-9a-f]{64}`, TOKEN_END),
  family('anthropic-api-key', 'Anthropic API Key', String.raw`${ANTHROPIC_PREFIX}-api03-[\w-]{93}AA`, TOKEN_END),
  family('anthropic-admin-api-key', 'Anthropic Admin API Key', String.raw`${ANTHROPIC_PREFIX}-admin01-[\w-]{93}AA`, TOKEN_END),
  family(
    'openai-api-key',
    'OpenAI API Key',
    String.raw`sk-(?:proj|svcacct|admin)-${OPENAI_HALF}T3BlbkFJ${OPENAI_HALF}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}`,
    TOKEN_END,
  ),
  family('huggingface-access-token', 'HuggingFace Access Token', String.raw`hf_[A-Za-z]{34}`, TOKEN_END),
  family('github-pat', 'GitHub PAT', String.raw`ghp_[A-Za-z0-9]{36}`, ANYWHERE),
  family('github-fine-grained-pat', 'GitHub Fine Grained PAT', String.raw`github_pat_\w{82}`, ANYWHERE),
  family('github-app-token', 'GitHub App Token', String.raw`gh[su]_[A-Za-z0-9]{36}`, ANYWHERE),
  family('github-oauth', 'GitHub OAuth', String.raw`gho_[A-Za-z0-9]{36}`, ANYWHERE),
  family('github-refresh-token', 'GitHub Refresh Token', String.raw`ghr_[A-Za-z0-9]{36}`, ANYWHERE),
  family('gitlab-pat', 'GitLab PAT', String.raw`glpat-[\w-]{20}`, ANYWHERE),
  family('gitlab-deploy-token', 'GitLab Deploy Token', String.raw`gldt-[\w-]{20}`, ANYWHERE),
  family('slack-bot-token', 'Slack Bot Token', String.raw`xoxb-\d{10,13}-\d{10,13}[A-Za-z0-9-]*`, ANYWHERE),
  family('slack-user-token', 'Slack User Token', String.raw`xox[ep](?:-\d{10,13}){3}-[A-Za-z0-9-]{28,34}`, ANYWHERE),
  family('slack-app-token', 'Slack App Token', String.raw`xapp-\d-[a-z0-9]+-\d+-[a-z0-9]+`, ANYWHERE, true),
  family('twilio-api-key', 'Twilio API Key', String.raw`SK[0-9A-Fa-f]{32}`, ANYWHERE),
  // A SendGrid key holds dots, but a dot right after it reads as the end of a
  // sentence, so only `=` joins the characters that continue it.
  family('sendgrid-api-token', 'SendGrid API Token', String.raw`SG\.[\w=.-]{66}`, { kind: 'tokenEnd', continuedBy: '=' }),
  family('npm-access-token', 'NPM Access Token', String.raw`npm_[A-Za-z0-9]{36}`, TOKEN_END),
  family('pypi-upload-token', 'PyPI Upload Token', String.raw`pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}`, ANYWHERE),
  family('databricks-api-token', 'Databricks API Token', String.raw`dapi[0-9a-f]{32}(?:-\d)?`, TOKEN_END),
  family('hashicorp-tf-api-token', 'HashiCorp TF API Token', String.raw`[A-Za-z0-9]{14}\.atlasv1\.[\w=-]{60,70}`, ANYWHERE),
  family('pulumi-api-token', 'Pulumi API Token', String.raw`pul-[0-9a-f]{40}`, TOKEN_END),
  family('postman-api-token', 'Postman API Token', String.raw`PMAK-[0-9A-Fa-f]{24}-[0-9A-Fa-f]{34}`, TOKEN_END),
  family('grafana-api-key', 'Grafana API Key', String.raw`eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3}`, BASE64_TOKEN_END),
  family('grafana-cloud-api-token', 'Grafana Cloud API Token', String.raw`glc_[A-Za-z0-9+/]{32,400}={0,3}`, BASE64_TOKEN_END),
  family('grafana-service-account-token', 'Grafana Service Account Token', String.raw`glsa_[A-Za-z0-9]{32}_[0-9A-Fa-f]{8}`, TOKEN_END),
  family('sentry-user-token', 'Sentry User Token', String.raw`sntryu_[0-9a-f]{64}`, TOKEN_END),
  family(
    'sentry-org-token',
    'Sentry Org Token',
    // The middle names the region URL in any of its three base64 alignments.
    String.raw`sntrys_eyJpYXQiO[A-Za-z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[A-Za-z0-9+/]{10,200}={0,2}_[A-Za-z0-9+/]{43}`,
    { kind: 'wordStart' },
  ),
  family('stripe-access-token', 'Stripe Access Token', String.raw`[rs]k_(?:test|live|prod)_[A-Za-z0-9]{10,99}`, TOKEN_END),
  family('shopify-access-token', 'Shopify Access Token', String.raw`shpat_[0-9A-Fa-f]{32}`, ANYWHERE),
  family('shopify-shared-secret', 'Shopify Shared Secret', String.raw`shpss_[0-9A-Fa-f]{32}`, ANYWHERE),
  { id: 'private-key', label: 'Private Key', detect: { scan: containsPrivateKey } },
]

const LABEL_BY_ID = new Map(SECRET_RULES.map(rule => [rule.id, rule.label]))

let compiledRules: Array<{ id: string; re: RegExp }> | null = null

/** The pattern families, compiled once. No `g` or `y` flag: `test` stays stateless. */
function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  compiledRules ??= SECRET_RULES.flatMap(({ id, detect }) =>
    'token' in detect
      ? [{ id, re: new RegExp(withBoundary(detect.token, detect.boundary), detect.anyCase ? 'i' : '') }]
      : [],
  )
  return compiledRules
}

function ruleIdToLabel(ruleId: string): string {
  return LABEL_BY_ID.get(ruleId) ?? ruleId
}

function detectedRuleIds(content: string): string[] {
  const patternHits = new Set(
    getCompiledRules()
      .filter(({ re }) => re.test(content))
      .map(({ id }) => id),
  )
  return SECRET_RULES.filter(({ id, detect }) =>
    'scan' in detect ? detect.scan(content) : patternHits.has(id),
  ).map(({ id }) => id)
}

export function scanForSecrets(content: string): SecretMatch[] {
  if (content === '') return []
  return detectedRuleIds(content).map(ruleId => ({ ruleId, label: ruleIdToLabel(ruleId) }))
}
