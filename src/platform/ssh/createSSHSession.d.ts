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

export declare const Dispatch: any
export type Dispatch = any
export declare const ReactNode: any
export type ReactNode = any
export declare const RefObject: any
export type RefObject = any
export declare const SSHSessionError: any
export type SSHSessionError = any
export declare const SetStateAction: any
export type SetStateAction = any
export declare const c: any
export type c = any
export declare const createLocalSSHSession: any
export type createLocalSSHSession = any
export declare const createSSHSession: any
export type createSSHSession = any
export declare const cwd: any
export type cwd = any
export declare const dangerouslySkipPermissions: any
export type dangerouslySkipPermissions = any
export declare const extraCliArgs: any
export type extraCliArgs = any
export declare const host: any
export type host = any
export declare const local: any
export type local = any
export declare const permissionMode: any
export type permissionMode = any
export declare const randomUUID: any
export type randomUUID = any
export declare const ssh: any
export type ssh = any
export declare const useCallback: any
export type useCallback = any
export declare const useEffect: any
export type useEffect = any
export declare const useRef: any
export type useRef = any
export declare const useState: any
export type useState = any
export declare const useSyncExternalStore: any
export type useSyncExternalStore = any
export declare const SSHSession: any
export type SSHSession = any
