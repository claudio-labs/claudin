// Help config helper shared by subcommand register functions (Fase 5a).
// Mirrors `createSortedHelpConfig` from src/platform/main.tsx run(): sorts
// subcommands and options by long name. Commander supports compareOptions
// at runtime but @commander-js/extra-typings doesn't include it in the type
// definitions, so we use Object.assign to add it.

import type { Option } from '@commander-js/extra-typings'

const getOptionSortKey = (opt: Option): string =>
  opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? ''

export function createSortedHelpConfig(): {
  sortSubcommands: true
  sortOptions: true
} {
  return Object.assign(
    {
      sortSubcommands: true,
      sortOptions: true,
    } as const,
    {
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b)),
    },
  )
}
