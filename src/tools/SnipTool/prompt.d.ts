// Ambient declarations for a module this fork does not carry.
//
// `scripts/build.ts` pre-scans `src/` for unresolved relative imports and
// redirects each one to the `missing-module-stub` namespace, whose payload is
// `const noop = () => null` plus one `export const <name> = noop` per imported
// binding. Reachability varies and is NOT uniform: some call sites are
// type-only (erased at emit), most sit behind a `feature()` flag that is off
// or inside an `await import()` on a gated path, but the eager imports in
// `src/commands/commands.ts` DO hit the no-op stub at runtime -- which is why
// /upgrade and /extra-usage hang on the Login stub.
//
// Same two conventions as `src/stubbed-modules.d.ts`: every export is `any`
// (that is what a no-op stands for), and the names are listed EXPLICITLY so a
// newly-added import errors here instead of being silently absorbed.

export declare const appendTeamMemorySummaryParts: any
export type appendTeamMemorySummaryParts = any
export declare const isTeamMemFile: any
export type isTeamMemFile = any
export declare const isTeamMemorySearch: any
export type isTeamMemorySearch = any
export declare const isTeamMemoryWriteOrEdit: any
export type isTeamMemoryWriteOrEdit = any
export declare const SNIP_TOOL_NAME: any
export type SNIP_TOOL_NAME = any
