import type { LocalJSXCommandCall } from 'src/shared/types/command.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from 'src/shared/constants/xml.js'
import {
  ProviderManager,
  type ProviderManagerResult,
} from 'src/providers/ui/ProviderManager.js'
import { runProviderDoctor } from 'src/commands/provider/doctor.js'
import { runProviderMigrate } from 'src/commands/provider/migrate.js'

export function buildProviderManagerCompletion(result?: ProviderManagerResult): {
  message: string
  metaMessages?: string[]
} {
  const message =
    result?.message ??
    (result?.action === 'saved'
      ? 'Provider profile updated'
      : 'Provider manager closed')
  const metaMessages =
    result?.action === 'activated' && result.activeProviderName
      ? [
          `<system-reminder>Provider switched mid-session to ${result.activeProviderName}${
            result.activeProviderModel
              ? ` using model ${result.activeProviderModel}`
              : ''
          }. Use this provider/model for subsequent requests unless the user switches again.</system-reminder>`,
        ]
      : undefined

  return { message, metaMessages }
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const raw = args?.trim() ?? ''
  const trimmedArgs = raw.toLowerCase()

  if (
    COMMON_HELP_ARGS.includes(trimmedArgs) ||
    COMMON_INFO_ARGS.includes(trimmedArgs) ||
    trimmedArgs === 'help' ||
    trimmedArgs === '--help' ||
    trimmedArgs === '-h'
  ) {
    onDone(
      'Run /provider to add, edit, delete, or activate provider profiles. The active provider controls base URL, model, and API key. Subcommands: `migrate [--force]` to copy ~/.claude/ -> ~/.claudin/, `doctor` to probe the active profile.',
      { display: 'system' },
    )
    return
  }

  // First token decides whether we run a subcommand or open the manager UI.
  const [head, ...rest] = raw.split(/\s+/)
  if (head?.toLowerCase() === 'migrate') {
    const message = await runProviderMigrate(rest.join(' '))
    onDone(message, { display: 'system' })
    return
  }
  if (head?.toLowerCase() === 'doctor') {
    const message = await runProviderDoctor()
    onDone(message, { display: 'system' })
    return
  }

  return (
    <ProviderManager
      mode="manage"
      onDone={result => {
        const { message, metaMessages } = buildProviderManagerCompletion(result)
        onDone(message, { display: 'system', metaMessages })
      }}
    />
  )
}
