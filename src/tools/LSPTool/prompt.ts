export const LSP_TOOL_NAME = 'LSP' as const

export const DESCRIPTION = `Code intelligence via LSP. Operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. Positions are 1-based (line, character) as shown in editors. Returns an error if no LSP server is configured for the file's language.`
