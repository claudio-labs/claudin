import {
  formatMigrationReport,
  migrateLegacyClaudeDir,
  type MigrationOptions,
} from '../../utils/claudioMigration.js'

export type MigrateArgs = {
  force: boolean
}

export function parseMigrateArgs(rest: string): MigrateArgs {
  const tokens = rest
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
  return {
    force: tokens.includes('--force') || tokens.includes('-f'),
  }
}

export async function runProviderMigrate(
  rest: string,
  overrides?: Pick<MigrationOptions, 'homeDir' | 'newDir'>,
): Promise<string> {
  const { force } = parseMigrateArgs(rest)
  const report = await migrateLegacyClaudeDir({ force, ...overrides })
  return formatMigrationReport(report)
}
