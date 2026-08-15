import { z } from 'zod/v4'
import { PDF_MAX_PAGES_PER_READ } from 'src/shared/constants/apiLimits.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { semanticNumber } from 'src/shared/data/semanticNumber.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
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
    symbol: z
      .string()
      .optional()
      .describe(
        "Expand exactly one symbol by name: returns just that function/class/type body with its real line numbers. Use after an outline to read one part of a large file. Takes precedence over offset/limit and view.",
      ),
    encoding: z
      .string()
      .optional()
      .describe(
        'Decode the file with this Encoding Standard label (e.g. "utf-16le", "shift_jis", "windows-1252") instead of UTF-8. Only needed for a file that is not UTF-8 and carries no BOM — those read as mojibake or as binary otherwise. Same label space as Grep\'s `encoding`, so a match Grep found with one is readable here with the same one.',
      ),
  }),
)
export type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

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
  ])
})
export type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
