import { z } from 'zod/v4'
import { PDF_MAX_PAGES_PER_READ } from 'src/shared/constants/apiLimits.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { semanticNumber } from 'src/shared/data/semanticNumber.js'
import {
  MAX_BATCH_FILES,
  MAX_BATCH_SYMBOLS,
  MIN_BATCH_FILES,
  readMultiEnabledAtLoad,
} from 'src/tools/FileReadTool/readMulti.js'

const READ_MULTI = readMultiEnabledAtLoad()

/** The fields both shapes share, built fresh per schema. */
function sharedFields() {
  return {
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
    pages: z
      .string()
      .optional()
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
    view: z
      .enum(['outline', 'full'])
      .optional()
      .describe(
        "Set to 'outline' to read only the structural skeleton of a code file — every function, class and object-literal member signature with its line range — instead of the full contents. Set to 'full' to force a full-body read even on large files that would otherwise auto-pivot to an outline. Cheap way to navigate a large file before expanding one part.",
      ),
    encoding: z
      .string()
      .optional()
      .describe(
        'Decode the file with this Encoding Standard label (e.g. "utf-16le", "shift_jis", "windows-1252") instead of UTF-8. Only needed for a file that is not UTF-8 and carries no BOM — those read as mojibake or as binary otherwise. Same label space as Grep\'s `encoding`, so a match Grep found with one is readable here with the same one.',
      ),
  }
}

/**
 * Codex strict mode lists every property as required, so a model that means
 * "not this one" sends `null` or `""` instead of leaving the key out
 * (codexShim.ts, enforceStrictSchema). stripPlaceholderOptionalFields drops
 * those on that transport; this is the same rule on the tool's side for the
 * three fields that decide WHAT a Read reads, so a stray placeholder can never
 * turn a single Read into a half-specified batch. An empty list names nothing
 * and counts too.
 */
function absentIfPlaceholder(value: unknown): unknown {
  if (value === null || value === '') return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  return value
}

function singleFileInputSchema() {
  const { offset, limit, pages, view, encoding } = sharedFields()
  return z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset,
    limit,
    pages,
    view,
    symbol: z
      .string()
      .optional()
      .describe(
        "Expand exactly one symbol by name: returns just that function/class/type body with its real line numbers. Use after an outline to read one part of a large file. Takes precedence over offset/limit and view.",
      ),
    encoding,
  })
}

/**
 * The default since the batch Read was promoted (readMulti.ts;
 * CLAUDIN_READ_MULTI=0 restores the single-file one). "Exactly one of
 * file_path and file_paths" needs a combinator at the root, which strict
 * transports reject, so this schema leaves both optional and validateInput
 * says it.
 */
function batchCapableInputSchema() {
  const { offset, limit, pages, view, encoding } = sharedFields()
  return z.strictObject({
    file_path: z
      .preprocess(absentIfPlaceholder, z.string().optional())
      .describe(
        'The absolute path to the file to read. Give this or file_paths, not both.',
      ),
    file_paths: z
      .preprocess(
        absentIfPlaceholder,
        z.array(z.string()).min(MIN_BATCH_FILES).max(MAX_BATCH_FILES).optional(),
      )
      .describe(
        `${MIN_BATCH_FILES}-${MAX_BATCH_FILES} absolute paths to read in one call, instead of file_path. view and symbol apply to every file; offset, limit, pages and encoding are single-file only.`,
      ),
    offset,
    limit,
    pages,
    view,
    // The null branch is for Codex strict mode: its widening cannot reach
    // inside a union (allowNull in codexShim.ts), so without it the model
    // would have no legal way to decline this field there.
    symbol: z
      .preprocess(
        absentIfPlaceholder,
        z
          .union([
            z.string(),
            z.array(z.string()).min(1).max(MAX_BATCH_SYMBOLS),
            z.null(),
          ])
          .optional(),
      )
      .describe(
        `Expand a symbol by name — or a list of up to ${MAX_BATCH_SYMBOLS}, each looked up in every file: returns just that function/class/type body with its real line numbers. Use after an outline to read one part of a large file. Takes precedence over offset/limit and view.`,
      ),
    encoding,
  })
}

/**
 * A Read's input, whichever schema the flag picked. It is the batch-capable
 * shape because that one accepts a superset of the single-file one — every
 * field optional or wider — so an input the flag-off schema parses is always
 * one of these, and code written against this type handles both.
 */
export type Input = z.infer<ReturnType<typeof batchCapableInputSchema>>

export type InputSchema = z.ZodType<Input>

export const inputSchema = lazySchema(
  (): InputSchema =>
    READ_MULTI ? batchCapableInputSchema() : singleFileInputSchema(),
)

/**
 * One file and at most one symbol: every Read that is not a batch, and each
 * file a batch reads (batchRead.ts).
 */
export type SingleInput = Omit<Input, 'file_path' | 'file_paths' | 'symbol'> & {
  file_path: string
  symbol?: string
}

export const outputSchema = lazySchema(() => {
  // Define the media types supported for images
  const imageMediaTypes = z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ])

  return z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      file: z.object({
        filePath: z.string().describe('The path to the file that was read'),
        content: z.string().describe('The content of the file'),
        numLines: z
          .number()
          .describe('Number of lines in the returned content'),
        startLine: z.number().describe('The starting line number'),
        totalLines: z.number().describe('Total number of lines in the file'),
      }),
    }),
    z.object({
      type: z.literal('image'),
      file: z.object({
        base64: z.string().describe('Base64-encoded image data'),
        type: imageMediaTypes.describe('The MIME type of the image'),
        originalSize: z.number().describe('Original file size in bytes'),
        dimensions: z
          .object({
            originalWidth: z
              .number()
              .optional()
              .describe('Original image width in pixels'),
            originalHeight: z
              .number()
              .optional()
              .describe('Original image height in pixels'),
            displayWidth: z
              .number()
              .optional()
              .describe('Displayed image width in pixels (after resizing)'),
            displayHeight: z
              .number()
              .optional()
              .describe('Displayed image height in pixels (after resizing)'),
          })
          .optional()
          .describe('Image dimension info for coordinate mapping'),
      }),
    }),
    z.object({
      type: z.literal('notebook'),
      file: z.object({
        filePath: z.string().describe('The path to the notebook file'),
        cells: z.array(z.any()).describe('Array of notebook cells'),
      }),
    }),
    z.object({
      type: z.literal('pdf'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        base64: z.string().describe('Base64-encoded PDF data'),
        originalSize: z.number().describe('Original file size in bytes'),
      }),
    }),
    z.object({
      type: z.literal('parts'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        originalSize: z.number().describe('Original file size in bytes'),
        count: z.number().describe('Number of pages extracted'),
        outputDir: z
          .string()
          .describe('Directory containing extracted page images'),
      }),
    }),
    z.object({
      type: z.literal('file_unchanged'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
      }),
    }),
    z.object({
      type: z.literal('outline'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
        content: z
          .string()
          .describe('The pre-rendered structural outline text'),
        totalLines: z.number().describe('Total number of lines in the file'),
        symbolCount: z
          .number()
          .describe('Number of symbols in the outline'),
        autoPivot: z
          .boolean()
          .optional()
          .describe(
            'True when this outline was produced by AUTO_OUTLINE_ON_ELISION because the vanilla full-body Read crossed the size threshold that induces slice-walk re-reads. Triggers an extra footer hint in the tool_result.',
          ),
        preview: z
          .boolean()
          .optional()
          .describe(
            'True when the content is the head+tail preview of a large plain-text file (no outline language), not a symbol table.',
          ),
      }),
    }),
    z.object({
      type: z.literal('clip_pin_fallback'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
        message: z
          .string()
          .describe(
            'The full tool_result content the clip-pin fallback serves — a structural outline plus redirect footer for code, or a plain redirect stub otherwise.',
          ),
        servedOutline: z
          .boolean()
          .describe(
            'True when `message` carries a structural outline (code file); false when it is the plain textual redirect stub.',
          ),
      }),
    }),
    // The batch Read (batchRead.ts). Present whichever way the flag is set: a
    // resumed transcript can carry one after the flag is turned off, and this
    // schema is what lets the renderer draw it instead of dropping the line.
    z.object({
      type: z.literal('batch'),
      files: z
        .array(
          z.object({
            filePath: z.string().describe('Absolute path of a file the batch showed'),
            lines: z
              .number()
              .describe(
                'Numbered lines shown for it — 0 for an outline, a preview or an unchanged stub',
              ),
          }),
        )
        .describe('The files shown, in order'),
      notShown: z
        .array(z.string())
        .describe('Files left out for the token budget, as the result names them'),
      content: z
        .string()
        .describe(
          'The tool_result text: one header per file, then the text a Read of that file returns',
        ),
    }),
  ])
})
export type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export type BatchOutput = Extract<Output, { type: 'batch' }>
