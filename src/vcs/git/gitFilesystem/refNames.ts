/**
 * The names and ids allowed out of a .git directory. They end up in paths,
 * prompts and shell commands (a skill interpolates the branch into shell), so
 * both rules are allowlists, and the name rule is narrower than git's.
 */

const NAME_CHARACTERS = /^[A-Za-z0-9/._+@-]+$/
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * A ref name, or the part of one after `refs/heads/`, that is safe to use.
 * No component may begin with a dot: git refuses those as well, and it keeps
 * out the `.invalid` placeholder that a reftable repository leaves in HEAD.
 */
export function isAcceptedRefName(name: string): boolean {
  if (!NAME_CHARACTERS.test(name)) return false
  if (name.startsWith('-') || name.includes('..')) return false
  return name.split('/').every(component => component !== '' && !component.startsWith('.'))
}

/** A full SHA-1 or SHA-256 id, in the lowercase hex git writes. */
export function isObjectId(text: string): boolean {
  return FULL_OBJECT_ID.test(text)
}
