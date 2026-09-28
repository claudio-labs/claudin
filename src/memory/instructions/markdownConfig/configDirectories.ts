/**
 * The `.claudin` subdirectories whose markdown files configure the CLI, and
 * where one of them sits under a base directory.
 */
import { join } from 'path'

export const CLAUDE_CONFIG_DIRECTORIES = [
  'commands',
  'agents',
  'output-styles',
  'skills',
  'workflows',
] as const

export type ClaudeConfigDirectory = (typeof CLAUDE_CONFIG_DIRECTORIES)[number]

const PROJECT_CONFIG_DIR_NAME = '.claudin'

/** `<base>/.claudin/<subdir>`, as a project or the managed directory lays it out. */
export function configSubdirOf(base: string, subdir: ClaudeConfigDirectory): string {
  return join(base, PROJECT_CONFIG_DIR_NAME, subdir)
}
