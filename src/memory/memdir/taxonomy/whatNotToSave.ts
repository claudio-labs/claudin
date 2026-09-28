export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What not to save',
  '',
  '- Code patterns and conventions, the architecture, file paths and the project structure: the current tree already shows them.',
  '- The history of the repository, its recent changes and who made them: `git log` and `git blame` answer that.',
  '- Debugging results and the recipe of a fix: the code holds the fix and the commit explains it.',
  '- Anything the CLAUDE.md files already document.',
  '- Ephemeral or in-progress state of the task at hand: temporary state and the conversation itself.',
  '- Routine work whose outcome surprised no one: a command that simply succeeded, a search that came back empty, moving around the tree. A session that leaves nothing worth keeping is a perfectly good outcome.',
  '',
  'These exclusions hold even when the user explicitly asks you to save something. Asked to keep a list of pull requests or a summary of activity, ask which part of it was surprising or non-obvious, and keep only that.',
]
