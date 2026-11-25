import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useContext } from 'react';
import { Box, NoSelect, Text } from 'src/terminal/ink.js';
import { Ratchet } from 'src/terminal/design-system/Ratchet.js';
type Props = {
  children: React.ReactNode;
  height?: number;
  /** Keep the ⎿ inside a tool result (ToolResultBody), for what the harness
   *  adds around the result rather than the result itself: a timeout, a
   *  command still running in the background, a hook. */
  mark?: boolean;
};
export function MessageResponse(t0: Props) {
  // Slots 8-9 were added by hand (rules/ink-tui.md §6): $[0] keys the gutter on
  // `unmarked` and $[8] holds it, and $[9] keys the row on the gutter.
  const $ = _c(10);
  const {
    children,
    height,
    mark
  } = t0;
  const isMessageResponse = useContext(MessageResponseContext);
  const unmarked = useContext(ToolResultBodyContext) && !mark;
  if (isMessageResponse) {
    return children;
  }
  let t1;
  if ($[0] !== unmarked) {
    t1 = unmarked ? <NoSelect fromLeftEdge={true} flexShrink={0} width={4} /> : <NoSelect fromLeftEdge={true} flexShrink={0}><Text dimColor={true}>{"  "}⎿ </Text></NoSelect>;
    $[0] = unmarked;
    $[8] = t1;
  } else {
    t1 = $[8];
  }
  let t2;
  if ($[1] !== children) {
    t2 = <Box flexShrink={1} flexGrow={1}>{children}</Box>;
    $[1] = children;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== height || $[4] !== t2 || $[9] !== t1) {
    t3 = <MessageResponseProvider><Box flexDirection="row" height={height} overflowY="hidden">{t1}{t2}</Box></MessageResponseProvider>;
    $[3] = height;
    $[4] = t2;
    $[9] = t1;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const content = t3;
  if (height !== undefined) {
    return content;
  }
  let t4;
  if ($[6] !== content) {
    t4 = <Ratchet lock="offscreen">{content}</Ratchet>;
    $[6] = content;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  return t4;
}

// This is a context that is used to determine if the message response
// is rendered as a descendant of another MessageResponse. We use it
// to avoid rendering nested ⎿ characters.
const MessageResponseContext = React.createContext(false);
function MessageResponseProvider(t0: { children: React.ReactNode }) {
  const $ = _c(2);
  const {
    children
  } = t0;
  let t1;
  if ($[0] !== children) {
    t1 = <MessageResponseContext.Provider value={true}>{children}</MessageResponseContext.Provider>;
    $[0] = children;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}

// A tool's result sits in the same 4-column gutter with no ⎿: the mark is
// kept for the secondary lines around it (MessageResponse's `mark`), the way
// it marks the rules and memories the harness loaded and a running command.
const ToolResultBodyContext = React.createContext(false);
export function ToolResultBody({
  children
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return <ToolResultBodyContext.Provider value={true}>{children}</ToolResultBodyContext.Provider>;
}
