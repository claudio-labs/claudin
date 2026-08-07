// Barrel for src/cli/print.
//
// The headless `-p` / `--print` driver and SDK control-protocol host live
// in src/cli/print/runHeadless.ts. Supporting units live next to it in
// src/cli/print/{promptBatching,uuidDedupe,structuredIOFactory,
// orphanPermission,permissionGlue,controlHandlers,initHandler,
// mcpReconcile,messageOps,sessionLoad}.ts.
//
// External consumers (src/main.tsx) still import from 'src/cli/print.js';
// keeping this file as a re-export shim avoids touching every call site
// and preserves the 11a/11b refactor convention of a barrel at the original
// location.
//
// Re-entrancy note: runHeadless registers process-global handlers
// (registerHookEventHandler, setPermissionModeChangedListener) and is
// designed to be called once per process. The CLI exits after -p completes,
// so a second invocation is never expected at runtime. No guard is enforced;
// future callers that need re-entry must unsubscribe first.

export { runHeadless } from 'src/cli/print/runHeadless.js'

export {
  joinPromptValues,
  canBatchWith,
} from 'src/cli/print/promptBatching.js'


export { removeInterruptedMessage } from 'src/cli/print/messageOps.js'

export { handleOrphanedPermissionResponse } from 'src/cli/print/orphanPermission.js'

export {
  getCanUseToolFn,
} from 'src/cli/print/permissionGlue.js'

export {
  handleMcpSetServers,
  reconcileMcpServers,
} from 'src/cli/print/mcpReconcile.js'
