/**
 * Quotes a piped command for `eval` with the stdin redirect on eval itself:
 * `eval '<cmd>' < /dev/null`.
 *
 * eval's stdin is /dev/null, so every command it runs inherits it except the
 * ones reading from a pipe: the first command of each pipeline, and anything
 * in front of it in a chain (`read x && cmd | head`), reads /dev/null instead
 * of the spawn's open stdin, where `rg foo | wc -l` waited for ever. Passing
 * the redirect as an eval ARGUMENT (`quote([cmd, '<', '/dev/null'])`, which
 * escapes the `<`) is what does not work: eval appends it to the string and it
 * lands on the last command of the pipe.
 *
 * The command is sent byte for byte. Until 2026-11-09 it was re-parsed with
 * shell-quote and rebuilt word by word to put `< /dev/null` after the first
 * command, unless it held `$`, a backtick, a loop or a newline. The rebuild
 * quoted every word with shell-quote's quote(), which since 1.12 escapes `~`,
 * `{`, `,` and `}`: `ls ~/.cache | wc -l` and `echo {a,b} | cat` stopped
 * expanding (54 visible failures since 07-14, census-2026-11-09).
 */
export function rearrangePipeCommand(command: string): string {
  return singleQuoteForEval(command) + ' < /dev/null'
}

/**
 * Single-quote a string for use as an eval argument. Escapes embedded single
 * quotes via '"'"' (close-sq, literal-sq-in-dq, reopen-sq). Used instead of
 * shell-quote's quote() which switches to double-quote mode when the input
 * contains single quotes and then escapes ! -> \!, corrupting jq/awk filters
 * like `select(.x != .y)` into `select(.x \!= .y)`.
 */
function singleQuoteForEval(s: string): string {
  return "'" + s.replace(/'/g, `'"'"'`) + "'"
}
