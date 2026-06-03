export function getEnterWorktreeToolPrompt(): string {
  return `Use this tool ONLY when the user explicitly asks to work in a worktree. This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless they specifically mention worktrees
- Never use this tool unless the user explicitly mentions "worktree"

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside \`.claudin/worktrees/\` on a new branch. The base ref is governed by the \`worktree.baseRef\` setting: \`fresh\` (default) branches from origin/<default-branch>; \`head\` branches from your current local HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

## Entering an existing worktree

Pass \`path\` instead of \`name\` to switch the session into a worktree that already exists (e.g., one you just created with \`git worktree add\`). The path must appear in \`git worktree list\` for the current repository — paths that are not registered worktrees of this repo, and the main worktree itself, are rejected. ExitWorktree will NOT remove a worktree entered this way; an \`action: "remove"\` is coerced to \`keep\`, returning the session to the original directory without deleting anything.

## Parameters

- \`name\` (optional): A name for a new worktree. If neither \`name\` nor \`path\` is provided, a random name is generated. Mutually exclusive with \`path\`.
- \`path\` (optional): Path to an existing worktree of the current repository to enter instead of creating one. Mutually exclusive with \`name\`.
`
}
