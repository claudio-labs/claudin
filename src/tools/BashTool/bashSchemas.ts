import { z } from 'zod/v4';
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js';
import { lazySchema } from 'src/shared/data/lazySchema.js';
import { semanticBoolean } from 'src/shared/data/semanticBoolean.js';
import { semanticNumber } from 'src/shared/data/semanticNumber.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
import { getMaxTimeoutMs } from 'src/tools/BashTool/prompt.js';

// Check if background tasks are disabled at module load time
export const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: env vars are immutable after process start
isEnvTruthy(process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS);
// Captured at module load so the filter decision is consistent for the entire
// process lifetime — a child cannot silently re-enable filtering after the
// operator sets the kill switch before starting the agent.
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: env vars are immutable after process start
export const isBashOutputFilterDisabled = isEnvTruthy(process.env.CLAUDIN_DISABLE_BASH_OUTPUT_FILTER);
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
  description: z.string().optional().describe(`Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`Set to true to run this command in the background. Use Read to read the output later.`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('Set this to true to dangerously override sandbox mode and run commands without sandboxing.'),
  _dangerouslyDisableSandboxApproved: z.boolean().optional().describe('Internal: user-approved sandbox override'),
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string()
  }).optional().describe('Internal: pre-computed sed edit result from preview')
}));

// Always omit internal-only fields from the model-facing schema.
// _simulatedSedEdit is set by SedEditPermissionRequest after the user approves a
// sed edit preview; exposing it would let the model bypass permission checks and
// the sandbox by pairing an innocuous command with an arbitrary file write.
// dangerouslyDisableSandbox is also omitted because sandbox escape must be tied
// to trusted user/internal provenance, not model-controlled tool input.
// Also conditionally remove run_in_background when background tasks are disabled.
export const inputSchema = lazySchema(() => isBackgroundTasksDisabled ? fullInputSchema().omit({
  run_in_background: true,
  dangerouslyDisableSandbox: true,
  _dangerouslyDisableSandboxApproved: true,
  _simulatedSedEdit: true
}) : fullInputSchema().omit({
  dangerouslyDisableSandbox: true,
  _dangerouslyDisableSandboxApproved: true,
  _simulatedSedEdit: true
}));
export type InputSchema = ReturnType<typeof inputSchema>;

// Use fullInputSchema for the type to always include run_in_background
// (even when it's omitted from the schema, the code needs to handle it)
export type BashToolInput = z.infer<ReturnType<typeof fullInputSchema>>;

/**
 * Wrap SandboxManager.annotateStderrWithSandboxFailures so a non-string return
 * value (notably the `() => null` no-op from the open build's sandbox stub)
 * falls back to the raw output. Without this, exit≠0 commands lose all stdout/
 * stderr in the resulting ShellError: only "Exit code N" reaches the model.
 *
 * Exported for unit testing — keep the body in sync with the call site below.
 */
export function safeAnnotateStderrWithSandboxFailures(
  command: string,
  rawOutput: string,
): string {
  const annotated = SandboxManager.annotateStderrWithSandboxFailures(command, rawOutput);
  return typeof annotated === 'string' ? annotated : rawOutput;
}
export const outputSchema = lazySchema(() => z.object({
  stdout: z.string().describe('The standard output of the command'),
  stderr: z.string().describe('The standard error output of the command'),
  rawOutputPath: z.string().optional().describe('Path to raw output file for large MCP tool outputs'),
  interrupted: z.boolean().describe('Whether the command was interrupted'),
  isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
  backgroundTaskId: z.string().optional().describe('ID of the background task if command is running in background'),
  backgroundedByUser: z.boolean().optional().describe('True if the user manually backgrounded the command with Ctrl+B'),
  assistantAutoBackgrounded: z.boolean().optional().describe('True if assistant-mode auto-backgrounded a long-running blocking command'),
  dangerouslyDisableSandbox: z.boolean().optional().describe('Flag to indicate if sandbox mode was overridden'),
  returnCodeInterpretation: z.string().optional().describe('Semantic interpretation for non-error exit codes with special meaning'),
  noOutputExpected: z.boolean().optional().describe('Whether the command is expected to produce no output on success'),
  structuredContent: z.array(z.any()).optional().describe('Structured content blocks'),
  persistedOutputPath: z.string().optional().describe('Path to the persisted full output in tool-results dir (set when output is too large for inline)'),
  persistedOutputSize: z.number().optional().describe('Total size of the output in bytes (set when output is too large for inline)'),
  readNote: z.string().optional().describe('Model-facing note after stdout on a file read: the files it did not show, and the ones that count as read'),
  creditedFiles: z.array(z.string()).optional().describe('Absolute paths the read credit counted as read (CLAUDIN_BASH_READ_CREDIT); /resume rebuilds them from disk')
}));
export type OutputSchema = ReturnType<typeof outputSchema>;
export type Out = z.infer<OutputSchema>;
