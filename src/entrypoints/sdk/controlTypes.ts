/**
 * SDK Control Types - TypeScript types for the control protocol.
 *
 * Reconstructed module: the original was not carried into this fork, but ~44
 * type-only imports across `src/bridge/`, `src/cli/`, `src/remote/` and
 * `src/server/` reference it. Every export here is derived with `z.infer` from
 * the matching schema in `controlSchemas.ts` (and `coreSchemas.ts` for the one
 * message type that lives there), so the types cannot drift from the runtime
 * validation the way a hand-written parallel shape would. The schemas are
 * wrapped in `lazySchema`, hence the `ReturnType<typeof …>` indirection.
 *
 * SDK consumers should use coreTypes.ts instead; these are for SDK builders
 * that speak the control protocol directly.
 */

import type { z } from 'zod/v4'
import type { SDKPartialAssistantMessageSchema } from './coreSchemas.js'
import type {
  SDKControlCancelRequestSchema,
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlPermissionRequestSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlRequestInnerSchema,
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  StdinMessageSchema,
  StdoutMessageSchema,
} from './controlSchemas.js'

// ============================================================================
// Control requests
// ============================================================================

/** Initializes the SDK session with hooks, MCP servers, and agent configuration. */
export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>

/** Requests permission to use a tool with the given input. */
export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof SDKControlPermissionRequestSchema>
>

/** The `subtype`-discriminated union of everything a control request can carry. */
export type SDKControlRequestInner = z.infer<
  ReturnType<typeof SDKControlRequestInnerSchema>
>

/** A control request envelope: `type: 'control_request'` plus a `request_id`. */
export type SDKControlRequest = z.infer<
  ReturnType<typeof SDKControlRequestSchema>
>

/** Cancels a currently open control request. */
export type SDKControlCancelRequest = z.infer<
  ReturnType<typeof SDKControlCancelRequestSchema>
>

// ============================================================================
// Control responses
// ============================================================================

/** Response from session initialization with available commands, models, and account info. */
export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>

export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>

export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>

/** A control response envelope, wrapping either a success or an error payload. */
export type SDKControlResponse = z.infer<
  ReturnType<typeof SDKControlResponseSchema>
>

// ============================================================================
// Aggregate stream messages
// ============================================================================

/** A single streaming `stream_event` chunk of an assistant message. */
export type SDKPartialAssistantMessage = z.infer<
  ReturnType<typeof SDKPartialAssistantMessageSchema>
>

/** Everything the CLI can write to stdout: SDK messages plus control traffic. */
export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>

/** Everything the CLI accepts on stdin: user messages plus control traffic. */
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>
