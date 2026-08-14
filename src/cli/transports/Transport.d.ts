// Ambient declaration for Transport.ts — the named `Transport` interface this
// fork never received. Two call-site shapes need satisfying:
//
//  - `WebSocketTransport implements Transport` (WebSocketTransport.ts) needs a
//    named TYPE export.
//  - `import Transport from './Transport.js'` used as `typeof Transport`
//    (SSETransport.ts, remoteIO.ts) needs a default VALUE export — see the
//    comment in SSETransport.ts for why the class has always been imported
//    that way here, not as a named type.
//
// Both are `any`, same convention as `src/stubbed-modules.d.ts`.
export type Transport = any
declare const _default: any
export default _default
