import type { McpbManifest } from '@anthropic-ai/mcpb'
import { errorMessage } from 'src/shared/errors.js'
import { jsonParse } from 'src/platform/slowOperations.js'

/**
 * Parses and validates a DXT manifest from a JSON object.
 *
 * Lazy-imports @anthropic-ai/mcpb: that package uses zod v3 which eagerly
 * creates 24 .bind(this) closures per schema instance (~300 instances between
 * schemas.js and schemas-loose.js). Deferring the import keeps ~700KB of bound
 * closures out of the startup heap for sessions that never touch .dxt/.mcpb.
 */
// @anthropic-ai/mcpb is one of scripts/build/build.ts's build-time-stubbed missing
// modules (src/stubbed-modules.d.ts only declares its TYPES, not
// McpbManifestSchema) — this codepath only runs where the real package is
// actually installed, which this fork's stub never is. Shape the dynamic
// import through `unknown` to match the runtime zod-like schema contract
// without pretending the stub declares it.
type ManifestSchemaModule = {
  McpbManifestSchema: {
    safeParse: (input: unknown) =>
      | { success: true; data: McpbManifest }
      | {
          success: false
          error: {
            flatten: () => {
              fieldErrors: Record<string, string[] | undefined>
              formErrors: string[]
            }
          }
        }
  }
}

export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifest> {
  const { McpbManifestSchema } = (await import(
    '@anthropic-ai/mcpb'
  )) as unknown as ManifestSchemaModule
  const parseResult = McpbManifestSchema.safeParse(manifestJson)

  if (!parseResult.success) {
    const errors = parseResult.error.flatten()
    const errorMessages = [
      ...Object.entries(errors.fieldErrors).map(
        ([field, errs]) => `${field}: ${errs?.join(', ')}`,
      ),
      ...(errors.formErrors || []),
    ]
      .filter(Boolean)
      .join('; ')

    throw new Error(`Invalid manifest: ${errorMessages}`)
  }

  return parseResult.data
}

/**
 * Parses and validates a DXT manifest from raw text data.
 */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifest> {
  let manifestJson: unknown

  try {
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`Invalid JSON in manifest.json: ${errorMessage(error)}`)
  }

  return validateManifest(manifestJson)
}

/**
 * Parses and validates a DXT manifest from raw binary data.
 */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifest> {
  const manifestText = new TextDecoder().decode(manifestData)
  return parseAndValidateManifestFromText(manifestText)
}


