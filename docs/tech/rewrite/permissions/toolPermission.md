# Spec: `permissions/toolPermission`

Files: `permissions/useCanUseTool.tsx`,
`permissions/toolPermission/{PermissionContext,permissionLogging}.ts`,
`permissions/toolPermission/handlers/{interactiveHandler,swarmWorkerHandler,coordinatorHandler}.ts`.

## Purpose

This unit is the REPL's permission gate. For each tool call the agent loop
wants to run, it takes the permission decision (from `permissions/decision`, or
a decision the caller forces), and when that decision is "ask" it routes the
question to whoever answers it:
- a coordinator worker's automated checks (PermissionRequest hooks, then the Bash prompt-rule classifier), awaited before anything else;
- the swarm leader, when the session is a worker in an agent team;
- the user's permission dialog, raced by the hooks, the Bash prompt-rule classifier, and the web app connected over the bridge.

It also records every decision on the tool-use context, applies and saves the
rule updates an answer carries, and turns aborts and failures into a
cancellation.

The REPL mounts the hook (`agent/repl/controllers/useToolUseContext.ts`), and
the returned function is what the agent loop, the tools and the sub-agent
runners call as `canUseTool`.

Three build flags shape it, and the shipped build turns all three on:
`BASH_CLASSIFIER` (the Bash prompt-rule classifier), `TRANSCRIPT_CLASSIFIER`
(auto mode) and `BRIDGE_MODE` (the web app). Under `bun test` they read false.
This spec describes the flag-on behaviour; "flag off" marks what changes when a
flag is off.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `useCanUseTool` (default, `useCanUseTool.tsx`) | `(setToolUseConfirmQueue: Dispatch<SetStateAction<ToolUseConfirm[]>>, setToolPermissionContext: (ctx: ToolPermissionContext, options?: { preserveMode?: boolean }) => void) => CanUseToolFn`, a React hook | `agent/repl/controllers/useToolUseContext.ts` (also imported by `agent/repl/REPL.tsx`) |
| `CanUseToolFn` (type) | `(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?) => Promise<PermissionDecision>` | 35 production files: `tools/Tool.ts`, `agent/query.ts`, `agent/QueryEngine.ts`, `agent/tools/{toolExecution,toolOrchestration,toolHooks}.ts`, `tools/AgentTool/{runAgent,resumeAgent}.ts`, `agent/coordinator/{forkedAgent,swarm/inProcessRunner}.ts`, `platform/headless/{structuredIO,print/*}.ts`, `permissions/permissions.ts`, and others |
| `createPermissionContext` (`PermissionContext.ts`) | `(tool, input, toolUseContext, assistantMessage, toolUseID, setToolPermissionContext, queueOps?: PermissionQueueOps) => PermissionContext` | `useCanUseTool.tsx`, `toolPermission/persistPermissions.test.ts` |
| `createPermissionQueueOps` | `(setToolUseConfirmQueue) => PermissionQueueOps` | `useCanUseTool.tsx` |
| `createResolveOnce` | `<T>(resolve: (v: T) => void) => ResolveOnce<T>` | the interactive and swarm handlers |
| `PermissionContext` (type) | the object below | the three handlers |
| `PermissionApprovalSource`, `PermissionRejectionSource` (types) | `{type:'hook', permanent?} \| {type:'user', permanent} \| {type:'classifier'}`; `{type:'hook'} \| {type:'user_abort'} \| {type:'user_reject', hasFeedback}` | `permissionLogging.ts` |
| `PermissionQueueOps` (type) | `{ push(item), remove(toolUseID), update(toolUseID, patch) }` | this unit |
| `ResolveOnce` (type) | `{ resolve(v), isResolved(): boolean, claim(): boolean }` | this unit |
| `handleInteractivePermission` (`handlers/interactiveHandler.ts`) | `(params: InteractivePermissionParams, resolve: (d: PermissionDecision) => void) => void` | `useCanUseTool.tsx` |
| `InteractivePermissionParams` (type) | `{ ctx; description: string; result: PermissionDecision & {behavior:'ask'}; awaitAutomatedChecksBeforeDialog: boolean \| undefined; bridgeCallbacks?: BridgePermissionCallbacks }` | |
| `handleSwarmWorkerPermission` (`handlers/swarmWorkerHandler.ts`) | `(params: SwarmWorkerPermissionParams) => Promise<PermissionDecision \| null>` | `useCanUseTool.tsx` |
| `SwarmWorkerPermissionParams` (type) | `{ ctx; description; pendingClassifierCheck?; updatedInput; suggestions }` | |
| `handleCoordinatorPermission` (`handlers/coordinatorHandler.ts`) | `(params: CoordinatorPermissionParams) => Promise<PermissionDecision \| null>` | `useCanUseTool.tsx` |
| `CoordinatorPermissionParams` (type) | `{ ctx; pendingClassifierCheck?; updatedInput; suggestions; permissionMode: string \| undefined }` | |
| `logPermissionDecision` (`permissionLogging.ts`) | `(ctx: PermissionLogContext, args: PermissionDecisionArgs, permissionPromptStartTimeMs?: number) => void` | `PermissionContext.ts`, `useCanUseTool.tsx` |
| `PermissionLogContext`, `PermissionDecisionArgs` (types) | `{ tool, input, toolUseContext, messageId, toolUseID }`; `{decision:'accept', source: approval \| 'config'} \| {decision:'reject', source: rejection \| 'config'}` | |

The permission context is a frozen object. Its members are part of the
contract, because the handlers and the type are exported:
`tool`, `input`, `toolUseContext`, `assistantMessage`, `messageId` (the
assistant message's `message.id`), `toolUseID`, and the operations
`logDecision(args, opts?)`, `persistPermissions(updates)`,
`resolveIfAborted(resolve)`, `cancelAndAbort(feedback?, isAbort?, contentBlocks?)`,
`tryClassifier(pendingCheck, updatedInput)` (present only with
`BASH_CLASSIFIER`), `runHooks(mode, suggestions, updatedInput?, startMs?)`,
`buildAllow(input, opts?)`, `buildDeny(message, reason)`,
`handleUserAllow(input, updates, feedback?, startMs?, contentBlocks?, reason?)`,
`handleHookAllow(input, updates, startMs?)`, `pushToQueue(item)`,
`removeFromQueue()`, `updateQueueItem(patch)`.

## Observable behaviour

### 1. The gate (`useCanUseTool`)

1. The returned function is stable across renders while both setters are the same. A new setter gives a new function.
2. A turn already aborted when the call arrives is answered with a cancel (§3.3, abort form) at once. No check runs, the tool is not asked to describe the call, and nothing is recorded, even when a decision was forced.
3. The decision is `forceDecision` when given, otherwise the permission decision for the call.
4. **Allow.** If the turn was aborted meanwhile, the answer is a cancel. Otherwise the call is allowed with the decision's rewritten input (or the input as made) and its reason, `userModified: false`, and recorded as `accept`/`config`. An auto-mode classifier allow also remembers its reason for the tool use (read back through `getYoloClassifierApproval`).
5. For anything else, the tool describes the call first (`description(input, { isNonInteractiveSession, toolPermissionContext, tools })`). If the turn was aborted meanwhile, the answer is a cancel.
6. **Deny.** The decision is returned as is and recorded `reject`/`config`. An auto-mode classifier deny is also added at the head of the recent auto-mode denials (`{ toolName, display: <the description>, reason: <the classifier reason, or ''>, timestamp }`), and, when the context has a notification sink, announces `{ key: 'auto-mode-denied', priority: 'immediate' }` reading "`<tool's user-facing name, lowercased>` denied by auto mode · /permissions". No other deny is listed or announced.
7. **Ask.** In order:
   1. When the permission context says `awaitAutomatedChecksBeforeDialog` (a coordinator worker), the coordinator route (§4) runs. A decision from it is the answer.
   2. If the turn was aborted, a cancel.
   3. The swarm route (§5) runs. A decision from it is the answer.
   4. Only for the `Bash` tool, with a pending classifier check and outside the coordinator case: if a prompt-rule classification for the same command is already running, it is awaited for at most 2 seconds. A high-confidence match allows the call with the rewritten input, reason `{ type: 'classifier', classifier: 'bash_allow', reason: 'Allowed by prompt rule: "<rule>"' }`, records `accept`/`classifier`, remembers the rule for the tool use, and uses the running classification up. Anything else, or the timeout, goes on to the dialog, which then reuses the same running classification rather than asking the model again.
   5. The dialog route (§6), given the session's bridge callbacks from app state (`replBridgePermissionCallbacks`). Flag off (`BRIDGE_MODE`): no bridge.
8. Any error during the above is a cancel that also aborts the turn. An abort error is treated the same way. The tool use's "classifier checking" mark is cleared when the gate hands over.
9. Flag off (`BASH_CLASSIFIER`): no classifier step anywhere, and the running classification is never consulted. Flag off (`TRANSCRIPT_CLASSIFIER`): no auto-mode memory, denial list or notice.

### 2. Decisions the context builds

- `buildAllow(input, opts)` gives `{ behavior: 'allow', updatedInput, userModified }` (default `false`), plus `decisionReason` and `acceptFeedback` when truthy, and `contentBlocks` when non-empty.
- `buildDeny(message, reason)` gives `{ behavior: 'deny', message, decisionReason }`.

### 3. Cancelling

1. A cancel is `{ behavior: 'ask', message, contentBlocks }` (the blocks as given, possibly undefined).
2. The message: with feedback, the reject-with-reason prefix followed by the feedback; without, the plain reject message. A context with an `agentId` (a sub-agent) uses the sub-agent forms of both. The texts come from `agent/messages/constants.ts`.
3. The turn's abort controller is aborted when asked to (the abort form), or when the cancel carries no feedback, no content blocks, and is not for a sub-agent. Feedback or blocks keep the turn going, and so does a sub-agent's bare reject.
4. `resolveIfAborted(resolve)` answers with the abort-form cancel and returns `true` when the turn is aborted, and does nothing and returns `false` otherwise.

### 4. The coordinator route

1. Runs the PermissionRequest hooks (§7) with the mode, the suggestions and the rewritten input. A hook decision is the answer.
2. Then, with `BASH_CLASSIFIER`, the classifier step (§8). An allow is the answer.
3. Otherwise `null`: the gate goes on, and the dialog it opens later neither runs the hooks again nor classifies again (its classifier indicator is off).
4. If the checks throw, the error is logged and the answer is `null`: the user decides. A thrown non-`Error` is logged as `Automated permission check failed: <value>`. (The error log keeps entries only when error reporting is enabled and nonessential traffic is explicitly allowed.)

### 5. The swarm-worker route

1. Taken only when agent teams are on (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` truthy, or `--agent-teams` on the command line) and the session is a team worker: it has a team name and an agent id, and is not the leader (an agent id of `team-lead` is the leader). Otherwise `null`.
2. With `BASH_CLASSIFIER`, the classifier step (§8) runs first. An allow is the answer, and the leader is not asked.
3. The request goes to the leader's mailbox (`<config home>/teams/<team>/inboxes/<leader name>.json`, where the leader is the team file's lead member, or `team-lead` when it names none), as a `permission_request` message from the worker's name carrying a fresh request id (`perm-<ms>-<random>`), the worker's name as `agent_id`, the tool name, the tool use id, the description, the call as made, and the suggestions (`[]` when none). The answer is listened for under that id before the request is sent.
4. While waiting, the app state's `pendingWorkerRequest` is `{ toolName, toolUseId, description }`. Any outcome sets it back to `null`.
5. The leader's approval (delivered through the inbox poller's `processMailboxPermissionResponse`) allows the call with the leader's input when it has at least one key, else the call as made. Its rule updates are validated (malformed entries dropped), applied and saved as for a user allow (§9), and the decision is recorded as a user accept, permanent when a rule was written to a settings file. `userModified` follows the tool's input-equivalence check.
6. A rejection is a cancel with the leader's feedback (§3), recorded `reject`/`user_reject`.
7. An abort of the turn while waiting is an abort-form cancel.
8. Only the first of these outcomes counts.
9. If the request cannot be built (no worker name), the error is logged and the answer is `null`: the worker's own dialog opens.
10. If it is built but cannot be delivered (no team file, so no leader), nothing reaches any inbox and the worker waits until the turn is aborted. See finding 2.

### 6. The dialog route (`handleInteractivePermission`)

1. Pushes one entry to the dialog queue: the assistant message, the tool, the description, the input to show (the rewritten input, else the call as made), the tool-use context, the tool use id, the ask decision, the time the prompt opened, and, with `BASH_CLASSIFIER`, `classifierCheckInProgress` (true when the ask carries a pending classifier check and the checks were not already awaited). It also carries the callbacks below.
2. **User allow** (`onAllow(input, updates, feedback?, blocks?)`): §9, with the ask decision's reason. With a bridge, the remote end is first sent `{ behavior: 'allow', updatedInput, updatedPermissions }` and its prompt is withdrawn.
3. **User reject** (`onReject(feedback?, blocks?)`): a cancel with the feedback and blocks (§3), recorded `reject`/`user_reject`. With a bridge, the remote end is sent `{ behavior: 'deny', message: <feedback, or 'User denied permission'> }`, then withdrawn.
4. **Abort** (`onAbort`): an abort-form cancel, recorded `reject`/`user_abort`. With a bridge, the remote end is sent `{ behavior: 'deny', message: 'User aborted' }`, then withdrawn.
5. **Re-check** (`recheckPermission`, called when the mode or rules change while the dialog is up): unless already answered, the permission decision is taken again. If it now allows, and nobody answered meanwhile, the dialog is removed, the remote prompt withdrawn, the decision recorded `accept`/`config`, and the call allowed with the fresh rewritten input (else the call as made). Anything else leaves the dialog alone.
6. **Hooks.** Unless the checks were already awaited, the PermissionRequest hooks (§7) run in the background with the session's current mode, the suggestions and the rewritten input. A decision from them, if nobody answered first, removes the dialog, withdraws the remote prompt, and is the answer.
7. **Bridge** (when callbacks are given): the remote end is sent the request once (a fresh UUID, the tool name, the input shown, the tool use id, the description, the suggestions, the blocked path) and listened to under the same id. A remote answer, if nobody answered first, clears the classifier indicator, removes the dialog, and:
   - allow: applies and saves its rule updates (not awaited), records a user accept (permanent when it carried any update), and allows its input, else the input shown, with `userModified: false` and no reason;
   - deny: a cancel with its message (§3), recorded `reject`/`user_reject`.
   An abort of the turn stops listening.
8. **Classifier** (with `BASH_CLASSIFIER`, only for the `Bash` tool with a pending check, unless the checks were already awaited): the tool use is marked as being checked and a prompt-rule classification runs (reusing one already running for the command). While it runs:
   - A keypress in the dialog (`onUserInteraction`) more than 200 ms after it opened hands the dialog to the user: the classification can no longer allow, the mark is cleared and the entry's indicator is turned off. Earlier keypresses are ignored.
   - No match, a match below high confidence, or a failure: the mark and the indicator are cleared, and the dialog stays.
   - A high-confidence match, if nobody answered and the user did not take over: the remote prompt is withdrawn, the mark cleared, the entry patched to `{ classifierCheckInProgress: false, classifierAutoApproved: true, classifierMatchedRule: <rule> }` (with `TRANSCRIPT_CLASSIFIER`), the rule remembered for the tool use, the decision recorded `accept`/`classifier`, and the call allowed **as made** (not the rewritten input) with the `bash_allow` reason. The dialog stays as a checkmark for 3 s when the terminal has focus (or focus is unknown) and 1 s when it does not, then is removed. `onDismissCheckmark` removes it at once, and so does an abort of the turn.
   - A failure after the turn was aborted is swallowed.
9. Only the first answer from the user, a hook, the re-check, the remote end or the classifier counts. Later ones change nothing: no second decision, no dialog removal, no record.
10. Flag off (`BASH_CLASSIFIER`): no indicator field, no classification, and keypresses decide nothing.

### 7. PermissionRequest hooks (`runHooks`)

1. Runs the session's PermissionRequest hooks for the tool (sub-agent hooks for a sub-agent context). Each hook is told the tool name, **the call as made** (not the rewritten input), the mode and the suggestions.
2. The first allow or deny wins. No hook, or none that answers (no output, a failure, unparseable output), gives `null`.
3. Allow: runs with the hook's input, else the rewritten input passed in, else the call as made. Its rule updates are applied and saved (§9), the decision is recorded `accept`/`hook`, and the answer is `{ behavior: 'allow', updatedInput, userModified: false, decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }` (`handleHookAllow`).
4. Deny: recorded `reject`/`hook`. The answer is `{ behavior: 'deny', message: <hook message, or 'Permission denied by hook'>, decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason: <hook message> } }`. A deny with `interrupt: true` also aborts the turn.

### 8. The classifier step (`tryClassifier`, `BASH_CLASSIFIER` only)

- `null` for any tool other than `Bash`, and for a call with no pending check. No model call.
- Uses a classification already running for the command, else asks the model to match the command against the pending check's descriptions.
- Only a high-confidence match to a listed description allows: `{ behavior: 'allow', updatedInput: <rewritten input, else as made>, userModified: false, decisionReason: <bash_allow reason> }`, recorded `accept`/`classifier`, with the rule remembered for the tool use. A medium or low match, no match, an index out of range, or a model failure gives `null`.

### 9. Saving rule updates and user allows

- `persistPermissions(updates)`: with no updates, nothing happens and the result is `false`. Otherwise every update is saved where its destination says (settings-file destinations are written), the updates are applied to the session's permission context through the setter, and the result is whether any update had a settings-file destination. The setter is told to preserve the current mode unless one of the updates is a mode change.
- `handleUserAllow`: saves the updates, records `accept`/user (permanent when something was written to a file), and allows the given input with `userModified` from the tool's input-equivalence check (`false` when the tool has none), the reason, the trimmed feedback (dropped when blank) and the blocks.

### 10. The decision record (`logPermissionDecision`)

- Sets `toolUseContext.toolDecisions` (created when missing) at the tool use id to `{ source, decision, timestamp: <now> }`, replacing any earlier entry for that id.
- `source` labels: `config`; `hook`; `user_permanent` / `user_temporary`; `user_abort`; `user_reject`; `classifier` (with either classifier flag; `unknown` with both off).
- The third parameter is accepted and ignored.

### 11. The queue

`createPermissionQueueOps(setter)` appends on push, drops every entry for the
tool use id on remove, and merges the patch into the matching entries on update,
all through the state setter. A context created without queue operations
ignores queue calls.

### 12. Resolve-once

The first `resolve` delivers its value. Later ones are ignored. `claim()`
returns `true` once and `false` afterwards, without delivering anything; after
a claim the claimer can still deliver. `isResolved()` is true after a claim or
a delivery.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A turn aborted at any step before an answer | An abort-form cancel (`{ behavior: 'ask', message: <reject message> }`), and the turn stays aborted |
| The tool's description throws, or the check throws | A cancel, and the turn is aborted |
| Coordinator checks throw | The dialog, as if no check decided |
| A swarm worker with no name | Its own dialog |
| A swarm team with no config file | The worker waits until the turn is aborted (finding 2) |
| A leader answer with `{}` as input | The call as made |
| Two answers to the same request (any mix of user, hook, remote, classifier, re-check, leader) | The first counts |
| `forceDecision` given | The checks are skipped. An aborted turn is still cancelled |
| A hook with no output, bad output or a non-zero exit | No decision |
| A classifier slower than 2 s on the gate's race | The dialog opens, and the classification can still approve it there |

## Security requirements

Every way to an allow, and every way that must fall back to asking, is pinned
by the tests and mutated by the probe spec.

- **What can allow:** the decision itself (rules, the tool, auto mode), a forced decision, a hook, the Bash prompt-rule classifier (coordinator, swarm, the gate's race, the dialog), the leader, the user, the web app, and a re-check that now allows. Nothing else.
- **Every failure asks or cancels, never allows:** a thrown check or description, an abort at any stage, a failing coordinator check, an unbuildable swarm request, and a classifier failure, timeout, low or medium confidence, no match or an out-of-range index.
- **The classifier allows only `Bash`, only at high confidence, and only for a described rule.** A keypress after the 200 ms grace stops it from allowing.
- **One answer per request.** No later answer can turn a refusal into an allow, re-run the call, or close another dialog.
- **The hooks do not run twice** for a coordinator worker, and the dialog does not classify twice.
- **Only an explicit mode change moves the mode** when rule updates are saved, so a choice inside a sub-agent cannot drop the session out of plan mode.

## Tests that pin it

- `src/permissions/useCanUseTool.characterization.test.tsx` mounts the hook in a real Ink tree over the fake terminal: §1, the coordinator and swarm routes end to end.
- `src/permissions/toolPermission/PermissionContext.characterization.test.ts`: §2, §3, §7, §9–12, with real settings files and real hook commands.
- `src/permissions/toolPermission/handlers/interactiveHandler.characterization.test.ts` (extended, not replaced): §6 without the classifier, including the bridge race.
- `src/permissions/toolPermission/handlers/coordinatorHandler.characterization.test.ts`: §4.
- `src/permissions/toolPermission/handlers/swarmWorkerHandler.characterization.test.ts`: §5, with a real team on disk and the leader's answer delivered through the inbox poller's entry point.
- `src/permissions/toolPermission/toolPermission.classifiers.characterization.test.tsx`: every flag-on branch (§1.4, §1.6, §1.7.4, §4.2, §5.2, §6.8, §8, the bridge from app state). Under the plain runner it starts a child `bun test --feature=BASH_CLASSIFIER --feature=TRANSCRIPT_CLASSIFIER --feature=BRIDGE_MODE` of itself. The model call (`sideQuery`) is the only thing replaced. Measure it alone with those flags.
- The harness is `src/permissions/toolPermission/__testutils__/routeWorld.ts`, on top of `src/permissions/__testutils__/decisionWorld.ts`.
- `scripts/migrations/probes/rewrite-permissions-toolPermission.json`: 40 probes over the six files, every one red.
- Pre-existing and to stay green: `src/permissions/toolPermission/persistPermissions.test.ts`.
- `scripts/migrations/probes/rewrite-levers-headless-io.json` quotes `interactiveHandler.ts` in six probes. They are re-pointed or retired with the rewrite.

No text this unit produces is a model prompt. The texts that reach the model as
tool results are the reject messages (owned by `agent/messages/constants.ts`),
`Permission denied by hook`, and the reason `Allowed by prompt rule: "<rule>"`.
`Permission denied by hook` also appears, as separate copies, in
`permissions/permissions/requestMessage.ts` and
`platform/lifecycleHooks/hookUnits.ts` (pinned by `hookUnits.test.ts`); those
belong to their own units. The mailbox message format belongs to
`agent/coordinator`, and the settings files to `permissions/ruleModel`, so this
unit owns no format on disk and has no fixtures.

## Out of scope

- **Cut: two unreachable branches of the dialog's classifier approval.** It handles an auto-mode classifier reason, and a reason not in the `Allowed by prompt rule: "…"` form, but the background classification only ever reports the Bash prompt-rule classifier in that form. The rewrite drops both.
- **Cut: the unused third parameter of `logPermissionDecision`**, once the callers are rewritten. It stays in the signature until then.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **The bridge race is still in the dialog route.** At `6cd6bf00` the web app's callbacks are still accepted, sent the request, and raced against the local answer (§6.7); the gate passes them from app state under `BRIDGE_MODE`. phase-3.md lists the race as kept (it needs a claude.ai login). | **Keep.** Characterized as it is. |
| 2 | **An undeliverable swarm request hangs the worker.** When the leader cannot be found (no team file) or the mailbox write fails, the request is dropped silently and the worker waits until the turn is aborted. The route's own fallback (the local dialog) is used only when the request cannot be built. | **Fix.** Treat a failed delivery like a failed build: fall back to the worker's own dialog. The call is still asked, and no caller can depend on a hang. |
| 3 | **A swarm worker forwards without running its PermissionRequest hooks** (unless it is also a coordinator worker). The leader decides instead. | **Keep for parity.** The leader is a person, so nothing runs unasked. Teams may rely on the leader seeing every request. |
| 4 | **The dialog's classifier approval runs the call as made, while the coordinator's and the swarm's run the rewritten input.** The dialog showed the rewritten input. | **Keep for parity.** The classification judged the command as made, so running that one is the conservative side. The other routes' rewritten input comes from the same checks. |
| 5 | **A remote allow is recorded as permanent whenever it carries a rule update**, even a session-only one, and its updates are saved without being awaited. The dialog's own allow says permanent only when a settings file was written. | **Fix** the label (nothing reads it but the cleanup after the call). **Keep** the unawaited save for parity. |
| 6 | **A remote allow never counts as a user edit**, even with a different input. | **Keep for parity.** The web app edits on purpose (a plan edit), and the label only changes what the model is told. |
| 7 | **The "classifier checking" mark is cleared as soon as the gate hands over to the dialog**, while the classification is still running. Its only reader (the tool-use row) has it disabled. | **Keep for parity.** Nothing visible depends on it. |
| 8 | **A non-`Bash` ask that carries a pending classifier check shows the classifier indicator for good**, though nothing is classified. Only `Bash` produces pending checks today. | **Fix.** Show the indicator only when a classification will run. Pure hardening, invisible to legitimate use. |
| 9 | **A swarm worker's answer listener stays registered after an abort.** A late answer from the leader is consumed and ignored. | **Fix.** Unregister on abort. Hygiene only. |
| 10 | **A hook is told the call as made, but its bare allow runs the rewritten input.** | **Keep for parity.** The hook contract is shared with `permissions/decision`, whose headless path behaves the same. |

## Target design

- **One router, routes as strategies.** The gate is a pipeline: take the decision, then for an ask try the routes in a fixed order (coordinator checks, swarm leader, the gate's classifier race, dialog). Each route is a small module with one signature: given the request, give a decision or decline. The order and the abort checks between steps live in the router only.
- **A request object instead of a context grab-bag.** Separate what the request is (tool, input, rewritten input, ids, description) from what can be done with it (record, save rules, cancel, build decisions) and from where answers come from (hooks, classifier, leader, remote end, user). Make the first answer wins a property of the request object, so no route can resolve twice.
- **The React part is a thin adapter.** The hook only binds the two setters to the router. Everything else is plain functions, testable without React.
- **Flag sites.** Keep one `feature()` read per flag at the edge (the router's set-up), and pass capabilities in, so the flag-off build loses the routes as a whole rather than branch by branch.
- **Types.** Model the decision record label as a union. Give the remote end's and the leader's answers one shared shape. Keep the exported names and signatures above until their callers are rewritten.
- **Findings.** Apply findings 2, 5 (label), 8 and 9.

## Outcome

Rewritten per method on 2026-10-04.

**The rewrite.** Every inherited body was written anew. `useCanUseTool` is now a plain hook. Under
`toolPermission/`:
- `capabilities.ts` holds the only `feature()` reads.
- `context/` holds the resolve-once, queue, decisions, rule updates, hook verdict and classifier
  verdict.
- `dialog/` holds the remote prompt and the classifier race.
- `gate/` holds the router, the running classification and the auto-mode verdicts.

The characterization suites pass, apart from the three assertions listed under Fixes below. 3,057
caller tests stay green.

**Fixes, each with a test.**
- **Finding 2:** an undeliverable swarm request opens the worker's own dialog instead of hanging.
- **Finding 5:** a remote allow is labelled by what it really persists. The save stays un-awaited.
- **Finding 8:** the classifier indicator only shows for Bash.
- **Finding 9:** an abort unregisters the leader listener.

Findings 2, 5 and 8 had pinned assertions, and only those three changed. They now expect the fixed
behaviour:
- `swarmWorkerHandler.characterization.test.ts`, the missing-team-file row: it now expects `null`;
- `interactiveHandler.characterization.test.ts`, the session-only remote allow: it now expects
  `user_temporary`;
- `toolPermission.classifiers.characterization.test.tsx`, the non-Bash indicator: it now expects
  `false`.

**Kept.** Findings 1, 3, 4, 6, 7 and 10. Finding 1 is the bridge race, which stays because the
remote features stay.

**Probes.**
- `rewrite-permissions-toolPermission.json` has 130 probes.
- The five stale `interactiveHandler` probes in `rewrite-levers-headless-io.json` were re-pointed
  with the same mutations and re-proved.

**Residue, reviewed.** 83 lines of Claude Code remain: the handler signatures, the permission-context
fields that callers read, and the log event shapes.
