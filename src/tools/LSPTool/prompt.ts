export const LSP_TOOL_NAME = 'LSP' as const

export const DESCRIPTION = `Code intelligence via LSP.

Read-only operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls.

Write operations (apply server-computed refactors):
- rename: rename the symbol at (line, character) across all references; requires newName. Prefer this over Edit when renaming exports, imported symbols, or anything used in multiple files.
- codeActions: list quickfixes and refactors applicable to a range (read-only). Optional endLine/endCharacter and CodeActionKind filter via "only".
- applyCodeAction: apply one of the actions returned by codeActions, identified by its actionId. Actions tagged "unsupported" (command-only) cannot be applied.
- renameFile: move a file to newPath and ask the server to update imports/references. Requires the server to support workspace/willRenameFiles; otherwise returns an error (do NOT fall back to shell mv — imports won't be updated).

Positions are 1-based (line, character) as shown in editors. Write operations check write permission for every affected path before touching disk and abort entirely if any path is denied. Returns an error if no LSP server is configured for the file's language.`
