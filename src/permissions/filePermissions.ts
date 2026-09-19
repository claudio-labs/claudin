export { checkPathSafetyForAutoEdit } from 'src/permissions/filePermissions/dangerousPaths.js'
export {
  checkEditableInternalPath,
  checkReadableInternalPath,
  isClaudeSettingsPath,
} from 'src/permissions/filePermissions/internalPaths.js'
export { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
export {
  getFileReadIgnorePatterns,
  matchingRuleForInput,
  normalizePatternsToPath,
} from 'src/permissions/filePermissions/rulePatterns.js'
export {
  allWorkingDirectories,
  pathInAllowedWorkingPath,
  pathInWorkingPath,
} from 'src/permissions/filePermissions/workingDirs.js'
export {
  checkBatchWritePermission,
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  generateSuggestions,
} from 'src/permissions/filePermissions/readWriteChecks.js'
