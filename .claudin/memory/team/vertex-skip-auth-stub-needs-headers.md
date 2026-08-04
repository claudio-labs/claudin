---
name: vertex-skip-auth-stub-needs-headers
description: The CLAUDE_CODE_SKIP_VERTEX_AUTH stub GoogleAuth must return a real Headers from getRequestHeaders() — a plain object kills every Vertex request
type: project
---

In `src/services/api/client.ts`, the `CLAUDE_CODE_SKIP_VERTEX_AUTH` escape hatch
swaps a stub in for `GoogleAuth` so Vertex traffic can be pointed at a proxy that
injects auth itself. That stub's `getClient().getRequestHeaders()` **must return
a real `Headers`**, not a plain object.

**Why:** `@anthropic-ai/vertex-sdk` (0.19.0, `client.js` `_adaptRequest`) does
`authClient.projectId ?? googleAuthHeaders.get('x-goog-user-project')` and then
`buildHeaders([googleAuthHeaders, request.headers])`. The stub client has no
`projectId`, so the `??` never short-circuits and `.get()` is always called. The
stub used to return `{}`, so **every** request under the flag died with
`TypeError: googleAuthHeaders.get is not a function` — and that line sits
*outside* the SDK's try/catch, so it surfaced as a raw TypeError rather than the
`APIConnectionError` the SDK raises for auth failures. Fixed 2026-08-03 to
`() => new Headers()`.

This was stale-contract rot, not a regression from any bump: google-auth-library
moved `getRequestHeaders()` to `Promise<Headers>` well before v11, and 10.7.0 and
11.0.0 declare it identically. Nothing exercised the flag, so it rotted silently.
See [[dependabot-bumps-2026-08-03-no-code-changes]].

**How to apply:** the guard is the test
`'CLAUDE_CODE_SKIP_VERTEX_AUTH stub returns Headers the Vertex SDK can read'` in
`src/services/api/client.test.ts`. It drives the **real** vertex-sdk with a
stubbed `globalThis.fetch` and asserts the request URL reaches
`/projects/test-project/locations/…:rawPredict`, which is only reachable if
`.get()` resolved on the line before. Verified by break-and-restore: reverting
the stub to `{}` makes exactly that test fail with the TypeError above. It needs
`ANTHROPIC_VERTEX_PROJECT_ID` set, since an empty `Headers` yields no project id
and the SDK otherwise throws "No projectId was given".
