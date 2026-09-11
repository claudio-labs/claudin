import type { BuiltInAgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

const SHARED_PREFIX = `You are an agent for Claudin, an open-source coding agent and CLI. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.`

const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- Default to targeted reads: Read with view='outline' returns a file's function and class signatures with their line ranges for a fraction of the tokens, symbol='name' expands one of them, and offset/limit reads a range. Read a file in full only when it is small or the outline does not answer the question.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

// Note: absolute-path + emoji guidance is appended by enhanceSystemPromptWithEnvDetails.
function getGeneralPurposeSystemPrompt(): string {
  return `${SHARED_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_GUIDELINES}`
}

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Code',
  whenToUse:
    'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  // model is intentionally omitted - uses getDefaultSubagentModel().
  getSystemPrompt: getGeneralPurposeSystemPrompt,
  // A fresh Code agent used to receive the whole CLAUDE.md family at its
  // first tool call — AGENTS.md, the always-on rules, both memory indexes
  // and the parent's git status, ~23k tokens carried by every later call
  // (43% of everything a fresh agent read in the 2026-09-10 census). The
  // conventions stay (this agent edits code); the memory indexes and the
  // stale git snapshot go — it can Read a memory file or run `git status`
  // itself. CLAUDIN_DISABLE_SLIM_CODE_AGENT=1 restores both.
  omitMemoryIndexes: true,
  omitGitStatus: true,
}
