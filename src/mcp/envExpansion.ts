// A placeholder body runs to the first closing brace, so `${A:-${B}}` reads
// the body `A:-${B` and leaves the trailing `}` as literal text.
const PLACEHOLDER = /\$\{([^}]+)\}/g
const FALLBACK_MARK = ':-'

type Placeholder = { name: string; fallback?: string }

function readPlaceholder(body: string): Placeholder {
  const mark = body.indexOf(FALLBACK_MARK)
  if (mark < 0) return { name: body }
  return { name: body.slice(0, mark), fallback: body.slice(mark + FALLBACK_MARK.length) }
}

/**
 * Substitutes `${NAME}` and `${NAME:-fallback}` from `process.env` in one
 * pass. An unset name without a fallback stays verbatim and is listed in
 * `missingVars` once per occurrence.
 */
export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []
  const expanded = value.replace(PLACEHOLDER, (placeholder: string, body: string) => {
    const { name, fallback } = readPlaceholder(body)
    const fromEnv = process.env[name]
    if (fromEnv !== undefined) return fromEnv
    if (fallback !== undefined) return fallback
    missingVars.push(name)
    return placeholder
  })
  return { expanded, missingVars }
}
