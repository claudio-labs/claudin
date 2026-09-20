/**
 * Matching a typed parameter name against a cmdlet's known parameter lists,
 * and spotting a colon-bound value whose real runtime path is masked by an
 * expression.
 */

/**
 * Checks if a lowercase parameter name (with leading dash) matches any entry
 * in the given param list, accounting for PowerShell's prefix-matching behavior
 * (e.g., -Lit matches -LiteralPath).
 */
export function matchesParam(paramLower: string, paramList: string[]): boolean {
  for (const p of paramList) {
    if (
      p === paramLower ||
      (paramLower.length > 1 && p.startsWith(paramLower))
    ) {
      return true
    }
  }
  return false
}

/**
 * Returns true if a colon-syntax value contains expression constructs that
 * mask the real runtime path (arrays, subexpressions, variables, backtick
 * escapes). The outer CommandParameterAst 'Parameter' element type hides
 * these from our AST walk, so we must detect them textually.
 *
 * Used in three branches of extractPathsFromCommand: pathParams,
 * leafOnlyPathParams, and the unknown-param defense-in-depth branch.
 */
export function hasComplexColonValue(rawValue: string): boolean {
  return (
    rawValue.includes(',') ||
    rawValue.startsWith('(') ||
    rawValue.startsWith('[') ||
    rawValue.includes('`') ||
    rawValue.includes('@(') ||
    rawValue.startsWith('@{') ||
    rawValue.includes('$')
  )
}
