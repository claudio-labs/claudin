/**
 * flushSessionStorage — public flush surface for the Project singleton.
 *
 * Extracted in Wave 3 of the 11c sessionStorage split. Other "current
 * session" getters (getCurrentSessionTag/Title/AgentColor) live in
 * metadata.ts since they share the same cache-lookup pattern as the
 * `save*`/`restore*` family.
 */
import { getProject } from 'src/sessions/persistence/project.js'

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}
