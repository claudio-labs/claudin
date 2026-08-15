// Ambient declarations for a module this fork does not carry.
//
// `scripts/build.ts` pre-scans `src/` for unresolved relative imports and
// redirects each one to the `missing-module-stub` namespace, whose payload is
// `const noop = () => null` plus one `export const <name> = noop` per imported
// binding. Reachability varies and is NOT uniform: some call sites are
// type-only (erased at emit), most sit behind a `feature()` flag that is off
// or inside an `await import()` on a gated path, but the eager imports in
// `src/commands.ts` DO hit the no-op stub at runtime -- which is why
// /upgrade and /extra-usage hang on the Login stub.
//
// Same two conventions as `src/stubbed-modules.d.ts`: every export is `any`
// (that is what a no-op stands for), and the names are listed EXPLICITLY so a
// newly-added import errors here instead of being silently absorbed.

export declare const agentColor: any
export type agentColor = any
export declare const agentName: any
export type agentName = any
export declare const agentSetting: any
export type agentSetting = any
export declare const attributionSnapshots: any
export type attributionSnapshots = any
export declare const contentReplacements: any
export type contentReplacements = any
export declare const contextCollapseCommits: any
export type contextCollapseCommits = any
export declare const contextCollapseSnapshot: any
export type contextCollapseSnapshot = any
export declare const customTitle: any
export type customTitle = any
export declare const fileHistorySnapshots: any
export type fileHistorySnapshots = any
export declare const fullPath: any
export type fullPath = any
export declare const js: any
export type js = any
export declare const listAllLiveSessions: any
export type listAllLiveSessions = any
export declare const messages: any
export type messages = any
export declare const mode: any
export type mode = any
export declare const prNumber: any
export type prNumber = any
export declare const prRepository: any
export type prRepository = any
export declare const prUrl: any
export type prUrl = any
export declare const sendToUdsSocket: any
export type sendToUdsSocket = any
export declare const tag: any
export type tag = any
export declare const worktreeSession: any
export type worktreeSession = any
