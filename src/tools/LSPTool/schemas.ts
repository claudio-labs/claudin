import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Discriminated union of all LSP operations
 * Uses 'operation' as the discriminator field
 */
export const lspToolInputSchema = lazySchema(() => {
  /**
   * Go to Definition operation
   * Finds the definition location of a symbol at the given position
   */
  const goToDefinitionSchema = z.strictObject({
    operation: z.literal('goToDefinition'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Find References operation
   * Finds all references to a symbol at the given position
   */
  const findReferencesSchema = z.strictObject({
    operation: z.literal('findReferences'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Hover operation
   * Gets hover information (documentation, type info) for a symbol at the given position
   */
  const hoverSchema = z.strictObject({
    operation: z.literal('hover'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Document Symbol operation
   * Gets all symbols (functions, classes, variables) in a document
   */
  const documentSymbolSchema = z.strictObject({
    operation: z.literal('documentSymbol'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Workspace Symbol operation
   * Searches for symbols across the entire workspace
   */
  const workspaceSymbolSchema = z.strictObject({
    operation: z.literal('workspaceSymbol'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Go to Implementation operation
   * Finds the implementation locations of an interface or abstract method
   */
  const goToImplementationSchema = z.strictObject({
    operation: z.literal('goToImplementation'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Prepare Call Hierarchy operation
   * Prepares a call hierarchy item at the given position (first step for call hierarchy)
   */
  const prepareCallHierarchySchema = z.strictObject({
    operation: z.literal('prepareCallHierarchy'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Incoming Calls operation
   * Finds all functions/methods that call the function at the given position
   */
  const incomingCallsSchema = z.strictObject({
    operation: z.literal('incomingCalls'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * Outgoing Calls operation
   * Finds all functions/methods called by the function at the given position
   */
  const outgoingCallsSchema = z.strictObject({
    operation: z.literal('outgoingCalls'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  // ---- Write-ops (T5.1) ----

  /**
   * Rename operation
   * Renames the symbol at (line, character) across all references. Returns
   * the aggregated WorkspaceEdit applied. Requires `renameProvider`.
   */
  const renameSchema = z.strictObject({
    operation: z.literal('rename'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
    newName: z
      .string()
      .min(1)
      .describe('The new name for the symbol at the given position'),
  })

  /**
   * Code Actions operation (read-only)
   * Lists CodeActions applicable to the given range. Each action gets a
   * synthetic actionId that can be passed back to `applyCodeAction`.
   */
  const codeActionsSchema = z.strictObject({
    operation: z.literal('codeActions'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('Start line (1-based)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('Start character (1-based)'),
    endLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('End line (1-based, defaults to start line)'),
    endCharacter: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('End character (1-based, defaults to start character)'),
    only: z
      .array(z.string())
      .optional()
      .describe(
        'Optional CodeActionKind filter (e.g. ["quickfix", "refactor"])',
      ),
  })

  /**
   * Apply Code Action operation
   * Resolves (if needed) and applies a CodeAction previously listed by
   * `codeActions`. The actionId is the synthetic id returned in that list.
   */
  const applyCodeActionSchema = z.strictObject({
    operation: z.literal('applyCodeAction'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    actionId: z
      .string()
      .describe('Synthetic action id returned by the codeActions list'),
  })

  /**
   * Rename File operation
   * Renames a file at the file system level, asking the server to update
   * imports/references. Requires `workspace.fileOperations.willRename`.
   * filePath is the OLD path; newPath is the destination.
   */
  const renameFileSchema = z.strictObject({
    operation: z.literal('renameFile'),
    filePath: z.string().describe('The current (old) path of the file'),
    newPath: z.string().describe('The new path for the file'),
  })

  return z.discriminatedUnion('operation', [
    goToDefinitionSchema,
    findReferencesSchema,
    hoverSchema,
    documentSymbolSchema,
    workspaceSymbolSchema,
    goToImplementationSchema,
    prepareCallHierarchySchema,
    incomingCallsSchema,
    outgoingCallsSchema,
    renameSchema,
    codeActionsSchema,
    applyCodeActionSchema,
    renameFileSchema,
  ])
})

/**
 * TypeScript type for LSPTool input
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>

/**
 * Type guard to check if an operation is a valid LSP operation
 */
export function isValidLSPOperation(
  operation: string,
): operation is LSPToolInput['operation'] {
  return [
    'goToDefinition',
    'findReferences',
    'hover',
    'documentSymbol',
    'workspaceSymbol',
    'goToImplementation',
    'prepareCallHierarchy',
    'incomingCalls',
    'outgoingCalls',
    'rename',
    'codeActions',
    'applyCodeAction',
    'renameFile',
  ].includes(operation)
}

/**
 * Operations that write to disk and require the batch permission gate.
 * `codeActions` is read-only — only `applyCodeAction` writes.
 */
export const LSP_WRITE_OPERATIONS = new Set([
  'rename',
  'applyCodeAction',
  'renameFile',
])

export type LSPWriteOperation =
  | 'rename'
  | 'applyCodeAction'
  | 'renameFile'

export function isLSPWriteOperation(op: string): op is LSPWriteOperation {
  return LSP_WRITE_OPERATIONS.has(op)
}
