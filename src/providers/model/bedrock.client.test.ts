/**
 * What `createBedrockRuntimeClient()` hands the AWS SDK: region, endpoint,
 * auth scheme and credentials. Every assertion reads the constructed client's
 * resolved config, so no request is sent. AWS credentials come from a spy on
 * `refreshAndGetAwsCredentials`, as in `transport/client.test.ts`.
 *
 * The two `@aws-sdk/client-bedrock` paths (profile listing, backing-model
 * lookup) are pinned only where that package is absent, which is the state of
 * this checkout: the package is not installed, and mocking a bare package that
 * does not exist would leak a fake into every later file of the run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import * as auth from 'src/providers/auth/auth.js'
import {
  createBedrockRuntimeClient,
  getBedrockInferenceProfiles,
  getInferenceProfileBackingModel,
} from 'src/providers/model/bedrock.js'

const ENV_KEYS = [
  'CLAUDIN_SKIP_BEDROCK_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken: string }
let awsCredentials: Creds | null = null
let awsRefreshes = 0
let refreshSpy: { mockRestore: () => void } | undefined

/** The slice of the SDK's resolved config these tests read. */
type ResolvedRuntimeConfig = {
  region: () => Promise<string>
  endpoint?: () => Promise<{ hostname: string; port?: number; protocol: string; path: string }>
  isCustomEndpoint: boolean
  credentials: () => Promise<Creds>
  requestHandler: unknown
  httpAuthSchemes: Array<{ schemeId: string; identityProvider: () => () => Promise<unknown> }>
  httpAuthSchemeProvider: () => Array<{ schemeId: string }>
}

async function runtimeConfig(): Promise<ResolvedRuntimeConfig> {
  const client = (await createBedrockRuntimeClient()) as unknown as { config: ResolvedRuntimeConfig }
  return client.config
}

beforeAll(() => {
  refreshSpy = spyOn(auth, 'refreshAndGetAwsCredentials').mockImplementation((async () => {
    awsRefreshes++
    return awsCredentials
  }) as unknown as typeof auth.refreshAndGetAwsCredentials)
})

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  awsCredentials = null
  awsRefreshes = 0
})

afterEach(() => {
  getBedrockInferenceProfiles.cache.clear?.()
  getInferenceProfileBackingModel.cache.clear?.()
})

afterAll(() => {
  refreshSpy?.mockRestore()
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('createBedrockRuntimeClient', () => {
  test('signs with the refreshed AWS credentials in AWS_REGION', async () => {
    process.env.AWS_REGION = 'eu-west-3'
    awsCredentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', sessionToken: 'session' }

    const config = await runtimeConfig()

    expect(awsRefreshes).toBe(1)
    expect(await config.region()).toBe('eu-west-3')
    const creds = await config.credentials()
    expect(creds).toMatchObject({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      sessionToken: 'session',
    })
    // No ANTHROPIC_BEDROCK_BASE_URL: the SDK keeps its own regional endpoint.
    expect(config.isCustomEndpoint).toBe(false)
  })

  test('falls back to AWS_DEFAULT_REGION, then us-east-1, like the Anthropic Bedrock SDK', async () => {
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-2'
    expect(await (await runtimeConfig()).region()).toBe('ap-southeast-2')

    delete process.env.AWS_DEFAULT_REGION
    expect(await (await runtimeConfig()).region()).toBe('us-east-1')
  })

  test('an API key (AWS_BEARER_TOKEN_BEDROCK) skips the credential refresh', async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-api-key'
    awsCredentials = { accessKeyId: 'AKIAUNUSED', secretAccessKey: 's', sessionToken: 't' }

    await runtimeConfig()

    expect(awsRefreshes).toBe(0)
  })

  test('CLAUDIN_SKIP_BEDROCK_AUTH sends unsigned over HTTP/1.1 to ANTHROPIC_BEDROCK_BASE_URL', async () => {
    process.env.CLAUDIN_SKIP_BEDROCK_AUTH = '1'
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'http://127.0.0.1:4010/bedrock'
    awsCredentials = { accessKeyId: 'AKIAUNUSED', secretAccessKey: 's', sessionToken: 't' }

    const config = await runtimeConfig()

    expect(awsRefreshes).toBe(0)
    expect(config.isCustomEndpoint).toBe(true)
    expect(await config.endpoint!()).toMatchObject({
      hostname: '127.0.0.1',
      port: 4010,
      protocol: 'http:',
      path: '/bedrock',
    })
    expect(config.requestHandler).toBeInstanceOf(NodeHttpHandler)
    expect(config.httpAuthSchemeProvider()).toEqual([{ schemeId: 'smithy.api#noAuth' }])
    expect(config.httpAuthSchemes.map(s => s.schemeId)).toEqual(['smithy.api#noAuth'])
    expect(await config.httpAuthSchemes[0]!.identityProvider()()).toEqual({})
  })

  test('a custom endpoint is honored with signing still on', async () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://bedrock-proxy.internal.example'
    awsCredentials = { accessKeyId: 'AKIAPROXY', secretAccessKey: 's', sessionToken: 't' }

    const config = await runtimeConfig()

    expect(awsRefreshes).toBe(1)
    expect((await config.endpoint!()).hostname).toBe('bedrock-proxy.internal.example')
    expect((await config.credentials()).accessKeyId).toBe('AKIAPROXY')
  })
})

describe('without @aws-sdk/client-bedrock installed', () => {
  test('the backing-model lookup fails open to null', async () => {
    expect(
      await getInferenceProfileBackingModel('arn:aws:bedrock:us-east-1:123:application-inference-profile/abc'),
    ).toBeNull()
  })

  test('listing inference profiles rejects, so the caller keeps its own ids', async () => {
    await expect(getBedrockInferenceProfiles()).rejects.toThrow('@aws-sdk/client-bedrock')
  })
})
