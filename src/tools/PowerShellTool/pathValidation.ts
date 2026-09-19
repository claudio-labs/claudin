/**
 * PowerShell-specific path validation for command arguments.
 *
 * Extracts file paths from PowerShell commands using the AST parser
 * and validates they stay within allowed project directories.
 * Follows the same patterns as BashTool/pathValidation.ts.
 *
 * This file is a BARREL — the implementation lives in pathValidation/:
 * cmdletPathConfig (the per-cmdlet parameter tables), paramMatching,
 * pathAllowlist (resolve + allow/deny), dangerousRemoval (the hard deny),
 * extractPaths (arguments → paths) and statementConstraints (the entry
 * point). Edit the sibling, not this file.
 */

export {
  dangerousRemovalDeny,
  isDangerousRemovalRawPath,
} from 'src/tools/PowerShellTool/pathValidation/dangerousRemoval.js'
export { checkPathConstraints } from 'src/tools/PowerShellTool/pathValidation/statementConstraints.js'
