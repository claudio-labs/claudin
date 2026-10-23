// On Windows (bash only) a hook naming a .sh script would open it in the
// default file handler instead of running it, so `bash` is prepended.
// PowerShell runs .ps1 files natively and never comes through here.
//
// Only the command WORD is looked at, after any `VAR=value` prefixes: a .sh
// path that is an argument (`echo ./hook.sh`) or part of a pipeline or list
// (`cd hooks && ./hook.sh`) is run by bash already, and prepending `bash` to
// the whole line would run `bash echo …`.

// One shell word: unquoted characters other than separators, an escape, or a
// quoted run, repeated; it must end at whitespace, an operator or the end.
const WORD_RE = /^\s*((?:[^\s"'\\;&|<>()`]|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*')+)(?=\s|[;&|<>]|$)/
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z_0-9]*=/
const EXPANSION_RE = /\$[({]|`/
const BLANKS_RE = /^(?:[ \t]|\\\n)+/
const LINE_BREAK_RE = /^[\r\n]/
const FUNCTION_DEF_RE = /^\s*\(\s*\)/
const SH_SUFFIX_RE = /\.sh["']?$/i

export function getWindowsBashHookCommand(command: string): string {
  let offset = 0
  while (true) {
    const rest = command.slice(offset)
    const match = rest.match(WORD_RE)
    const word = match?.[1]
    if (!match || !word || word.startsWith('#')) return command

    if (ASSIGNMENT_RE.test(word)) {
      // An expansion can hide its own words and quotes; rather than guess the
      // executable, leave the command alone.
      if (EXPANSION_RE.test(word)) return command
      const separator = rest.slice(match[0].length).match(BLANKS_RE)?.[0]
      if (!separator) return command
      offset += match[0].length + separator.length
      if (LINE_BREAK_RE.test(command.slice(offset))) return command
      continue
    }
    if (word === 'bash' || FUNCTION_DEF_RE.test(rest.trimStart().slice(word.length))) return command
    return SH_SUFFIX_RE.test(word) ? `${command.slice(0, offset)}bash ${rest}` : command
  }
}
