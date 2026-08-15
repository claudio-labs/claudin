// Permanent no-op — the real hook is Anthropic-internal and this fork never
// received it. `REPL.tsx` imports and calls it unconditionally, so the shape
// below is the contract: `onBeforeQuery` must keep returning true or the REPL
// stops sending queries.
//
// The header used to justify the missing imports with a build overlay that
// staged this file under `scripts/external-stubs/` — a directory that does not
// exist in this repo and never did. The reorg's path rewriter dutifully updated
// the fictional path to match the new tree, which made it read as current. It
// was inherited from upstream; the self-contained style is kept because there
// is nothing here worth importing, not because resolution would break.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type M = any;
export function useMoreRight(_args: {
  enabled: boolean;
  setMessages: (action: M[] | ((prev: M[]) => M[])) => void;
  inputValue: string;
  setInputValue: (s: string) => void;
  setToolJSX: (args: M) => void;
}): {
  onBeforeQuery: (input: string, all: M[], n: number) => Promise<boolean>;
  onTurnComplete: (all: M[], aborted: boolean) => Promise<void>;
  render: () => null;
} {
  return {
    onBeforeQuery: async () => true,
    onTurnComplete: async () => {},
    render: () => null
  };
}
