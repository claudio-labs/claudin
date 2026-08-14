/**
 * YAML parsing wrapper.
 *
 * Uses Bun.YAML (built-in, zero-cost) when running under Bun, otherwise falls
 * back to the `yaml` npm package. The package is lazy-required inside the
 * non-Bun branch so native Bun builds never load the ~270KB yaml parser.
 */

export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}

/**
 * YAML serialization. Always uses the `yaml` npm package (not Bun.YAML, whose
 * stringify availability/formatting varies by Bun version) so output is
 * deterministic across runtimes — this is a cold path (config/frontmatter
 * writes), so the lazy require cost doesn't matter.
 */
export function stringifyYaml(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).stringify(value)
}
