/**
 * Parse a CLI flag value early, before Commander.js processes arguments.
 * Supports both space-separated (--flag value) and equals-separated (--flag=value) syntax.
 *
 * This function is intended for flags that must be parsed before init() runs,
 * such as --settings which affects configuration loading. For normal flag parsing,
 * rely on Commander.js which handles this automatically.
 *
 * @param flagName The flag name including dashes (e.g., '--settings')
 * @param argv Optional argv array to parse (defaults to process.argv)
 * @returns The value if found, undefined otherwise
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // Handle --flag=value syntax
    if (arg?.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
    // Handle --flag value syntax
    if (arg === flagName && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return undefined
}


