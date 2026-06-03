// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claudin/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claudin/**'

// Permission pattern for granting session-level access to the global ~/.claudin/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claudin/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
