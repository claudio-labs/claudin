// Barrel for src/platform/headless/print.
//
// The headless `-p` / `--print` driver and SDK control-protocol host are split
// across src/platform/headless/print/ as follows (ROADMAP 11b, both halves):
//
//   Entry & host
//     runHeadless.ts           one-shot setup, then formats the final message
//                              per --output-format
//     runHeadlessStreaming.ts  builds the shared context, installs the
//                              process-level listeners, starts both loops
//     streamingContext.ts      the explicit DI surface — read its header before
//                              touching any of the mutable state
//
//   The two concurrent loops
//     turnLoop.ts              drains the command queue, calls ask(), streams
//     controlLoop.ts           reads stdin, dispatches control_requests
//
//   Control-request handlers (one exported function per subtype)
//     controlHandlers.ts       rewind_files, set_permission_mode, channel_enable
//     initHandler.ts           initialize
//     mcpControlHandlers.ts    mcp_reconnect/toggle/authenticate/clear_auth,
//                              mcp_oauth_callback_url
//     oauthControlHandlers.ts  claude_authenticate, claude_oauth_callback
//     settingsControlHandlers.ts
//                              apply_flag_settings, get_settings,
//                              reload_plugins, seed_read_state,
//                              generate_session_title, side_question,
//                              remote_control
//
//   Supporting units
//     mcpRuntime.ts            SDK/dynamic MCP wiring + plugin hot reload
//     mcpReconcile.ts          the mcp_set_servers diff itself
//     permissionGlue.ts        canUseTool construction
//     sessionLoad.ts           --continue / --resume / --teleport loading
//     structuredIOFactory.ts   StructuredIO vs RemoteIO selection
//     promptBatching.ts        consecutive-prompt coalescing
//     uuidDedupe.ts            runtime duplicate-user-message tracking
//     messageOps.ts            interrupted-message removal
//     orphanPermission.ts      unexpected permission-response recovery
//     readFileCacheHandover.ts the readFileState pin-transfer invariant
//     headlessOptionalModules.ts  feature()-gated module handles
//
// External consumers (src/platform/main/defaultAction/headless.ts) import from
// 'src/platform/headless/print.js'; keeping this file as a re-export shim avoids touching
// every call site and preserves the 11a/11b refactor convention of a barrel at
// the original location.

export { runHeadless } from 'src/platform/headless/print/runHeadless.js'

export {
  joinPromptValues,
  canBatchWith,
} from 'src/platform/headless/print/promptBatching.js'


export { removeInterruptedMessage } from 'src/platform/headless/print/messageOps.js'

export { handleOrphanedPermissionResponse } from 'src/platform/headless/print/orphanPermission.js'

export {
  getCanUseToolFn,
} from 'src/platform/headless/print/permissionGlue.js'

export {
  handleMcpSetServers,
  reconcileMcpServers,
} from 'src/platform/headless/print/mcpReconcile.js'
