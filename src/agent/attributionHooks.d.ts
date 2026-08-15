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

export declare const sweepFileContentCache: any
export type sweepFileContentCache = any
export declare const clearAttributionCaches: any
export type clearAttributionCaches = any
export declare const registerAttributionHooks: any
export type registerAttributionHooks = any
