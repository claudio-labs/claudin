// Client-type + isInteractive resolution extracted from src/main.tsx
// (ROADMAP 11g Fase 7a).
//
// `resolveClientType()` is pure (reads process.env / process.argv / TTY).
// `applyClientType()` invokes the bootstrap state setters as a side-effect.
// Keeping them split lets tests assert the resolved value without mutating
// global state.

import { isEnvTruthy } from 'src/utils/envUtils.js';
import { setClientType, setIsInteractive, setQuestionPreviewFormat, setSessionSource } from 'src/bootstrap/state.js';

export type ClientType =
  | 'github-action'
  | 'sdk-typescript'
  | 'sdk-python'
  | 'sdk-cli'
  | 'claude-vscode'
  | 'local-agent'
  | 'claude-desktop'
  | 'remote'
  | 'cli';

export type PreviewFormat = 'markdown' | 'html';

export interface ResolvedClientType {
  clientType: ClientType;
  /** Resolved preview format, or `undefined` to leave the default in place. */
  previewFormat: PreviewFormat | undefined;
  /** Set to `'remote-control'` when invoked via `claude remote-control`. */
  sessionSource: 'remote-control' | undefined;
  /** `true` unless -p/--print, --init-only, --sdk-url, or non-TTY stdout. */
  isInteractive: boolean;
}

function resolveTypeFromEnv(): ClientType {
  if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') return 'claude-vscode';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return 'local-agent';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude-desktop';

  // Check if session-ingress token is provided (indicates remote session)
  const hasSessionIngressToken =
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN ||
    process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
    return 'remote';
  }
  return 'cli';
}

function resolvePreviewFormat(clientType: ClientType): PreviewFormat | undefined {
  const previewFormat = process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    return previewFormat;
  }
  // Desktop and CCR pass previewFormat via toolConfig; when the feature is
  // gated off they pass undefined — don't override that with markdown.
  if (
    !clientType.startsWith('sdk-') &&
    clientType !== 'claude-desktop' &&
    clientType !== 'local-agent' &&
    clientType !== 'remote'
  ) {
    return 'markdown';
  }
  return undefined;
}

function resolveIsInteractive(): boolean {
  const cliArgs = process.argv.slice(2);
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
  const hasInitOnlyFlag = cliArgs.includes('--init-only');
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;
  return !isNonInteractive;
}

/**
 * Resolve client type, preview format, session source, and isInteractive
 * from current environment and argv. Pure — no setter side-effects.
 */
export function resolveClientType(): ResolvedClientType {
  const clientType = resolveTypeFromEnv();
  const previewFormat = resolvePreviewFormat(clientType);
  const sessionSource = process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge'
    ? 'remote-control' as const
    : undefined;
  const isInteractive = resolveIsInteractive();
  return { clientType, previewFormat, sessionSource, isInteractive };
}

/**
 * Apply a `ResolvedClientType` to the bootstrap-state setters. Caller
 * decides when to invoke (preserves the original side-effect ordering
 * around profileCheckpoint calls).
 */
export function applyClientType(resolved: ResolvedClientType): void {
  setClientType(resolved.clientType);
  if (resolved.previewFormat !== undefined) {
    setQuestionPreviewFormat(resolved.previewFormat);
  }
  if (resolved.sessionSource !== undefined) {
    setSessionSource(resolved.sessionSource);
  }
  setIsInteractive(resolved.isInteractive);
}
