/**
 * Splits what the user typed after an MCP prompt's slash command into its
 * positional arguments. Words are separated by whitespace, and a word that
 * starts with " or ' runs to the matching quote, spaces included. Nothing
 * else is syntax: #, globs, operators, $ and backslashes reach the server as
 * typed, and a quote inside a word (`don't`) is part of it. The shell parser
 * a skill's $ARGUMENTS goes through dropped or rewrote all of those.
 *
 * An empty line still sends one empty argument, as the space split before it
 * did, so a server that checks a required argument sees it present.
 */
const ARGUMENT_RE = /"([^"]*)"|'([^']*)'|(\S+)/g

export function splitPromptArguments(line: string): string[] {
  const args = [...line.matchAll(ARGUMENT_RE)].map(match => match[1] ?? match[2] ?? match[3]!)
  return args.length > 0 ? args : ['']
}
