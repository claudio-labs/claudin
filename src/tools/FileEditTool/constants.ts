// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claudin/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claudin/**'

// Permission pattern for granting session-level access to the global ~/.claudin/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claudin/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'

// Read-before-edit refusals now live in the shared module, because
// `.claudin/rules/cache.md` binds four tools to the same gate and they were
// disagreeing about the same file state. Re-exported here so UI.tsx and the
// existing importers keep their import path.
export {
  FILE_CLIPPED_VIEW_ERROR,
  FILE_NOT_READ_ERROR,
  FILE_PARTIAL_VIEW_ERROR,
} from '../shared/readBeforeEditMessages.js'
