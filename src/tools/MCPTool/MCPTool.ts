import { Ajv } from 'ajv'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from 'src/Tool.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import type { PermissionResult } from 'src/types/permissions.js'
import { isOutputLineTruncated } from 'src/terminal/terminal.js'
import { logError } from 'src/shared/log.js'
import { DESCRIPTION, PROMPT } from 'src/tools/MCPTool/prompt.js'
import { buildMcpValidationError } from 'src/tools/MCPTool/validationMessage.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from 'src/tools/MCPTool/UI.js'

// Allow any input object since MCP tools define their own schemas
export const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

// MCP tools can return either a plain string or an array of content blocks
// (text, images, etc.). The outputSchema must reflect both shapes so the model
// knows rich content is possible.
export const outputSchema = lazySchema(() =>
  z.union([
    z.string().describe('MCP tool execution result as text'),
    z
      .array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }),
      )
      .describe('MCP tool execution result as content blocks'),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export MCPProgress from centralized types to break import cycles
export type { MCPProgress } from 'src/types/tools.js'

// allErrors: report every violation at once (not just the first) so the model
// can fix all bad/missing args in a single retry instead of one per round-trip.
const ajv = new Ajv({ strict: false, allErrors: true })

export const MCPTool = buildTool({
  isMcp: true,
  // Overridden in mcpClient.ts with the real MCP tool name + args
  isOpenWorld() {
    return false
  },
  // Overridden in mcpClient.ts
  name: 'mcp',
  maxResultSizeChars: 100_000,
  // Overridden in mcpClient.ts
  async description() {
    return DESCRIPTION
  },
  // Overridden in mcpClient.ts
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Overridden in mcpClient.ts
  async call(_args, _context) {
    return {
      data: '',
    }
  },
  async checkPermissions(_input, _context): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
  async validateInput(input, context): Promise<ValidationResult> {
    if (this.inputJSONSchema) {
      try {
        const validate = ajv.compile(this.inputJSONSchema)
        if (!validate(input)) {
          const errorsText = ajv.errorsText(validate.errors)
          let message = errorsText
          try {
            // Append a one-line summary of the accepted arguments so the model
            // stops re-guessing field names/shape across retries.
            message = buildMcpValidationError(this.inputJSONSchema, errorsText)
          } catch (e) {
            // Fallback pattern: never block the call on a formatting failure,
            // but leave a signal if the hint builder ever starts throwing.
            logError(
              new Error('MCP validation-hint formatting failed', { cause: e }),
            )
            message = errorsText
          }
          return {
            result: false,
            message,
            errorCode: 400,
          }
        }
      } catch (error) {
        return {
          result: false,
          message: `Failed to compile JSON schema for validation: ${error}`,
          errorCode: 500,
        }
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  // Overridden in mcpClient.ts
  userFacingName: () => 'mcp',
  renderToolUseProgressMessage,
  renderToolResultMessage: renderToolResultMessage as unknown as ToolDef<
    InputSchema,
    Output
  >['renderToolResultMessage'],
  isResultTruncated(output: Output): boolean {
    if (typeof output === 'string') {
      return isOutputLineTruncated(output)
    }
    // Array of content blocks — check if any text block exceeds the display limit
    if (Array.isArray(output)) {
      return output.some(
        block =>
          block?.type === 'text' &&
          typeof block.text === 'string' &&
          isOutputLineTruncated(block.text),
      )
    }
    return false
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    } as unknown as ToolResultBlockParam
  },
} satisfies ToolDef<InputSchema, Output>)
