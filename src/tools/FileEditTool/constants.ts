// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claudio/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claudio/**'

// Permission pattern for granting session-level access to the global ~/.claudio/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claudio/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
