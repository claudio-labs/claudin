/**
 * `claudin -help` → `claudin --help`.
 *
 * Commander reads a single-dash long flag as a run of short ones and answers
 * `error: unknown option '-help'`, so the rewrite happens before either help
 * path (the build-time snapshot in cli.tsx, or commander itself) sees it.
 *
 * Only the FIRST dash-led token is a candidate: with nothing but positionals
 * before it (`mcp add -help`) it can only be the flag, whereas after an option
 * (`--system-prompt -help`) it may be that option's value. Returns the input
 * array itself when nothing was rewritten, so the caller can tell by identity.
 */
export function normalizeHelpAlias(args: string[]): string[] {
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  if (firstFlag === -1 || args[firstFlag] !== '-help') return args
  const rewritten = [...args]
  rewritten[firstFlag] = '--help'
  return rewritten
}
