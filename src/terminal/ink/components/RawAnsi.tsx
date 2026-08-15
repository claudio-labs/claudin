import { c as _c } from "react-compiler-runtime";
import React from 'react';
type Props = {
  /**
   * Pre-rendered ANSI lines. Each element must be exactly one terminal row
   * (already wrapped to `width` by the producer) with ANSI escape codes inline.
   */
  lines: string[];
  /** Column width the producer wrapped to. Sent to Yoga as the fixed leaf width. */
  width: number;
};

// 'ink-raw-ansi' is a real host element recognized by the renderer
// (src/terminal/ink/dom.ts, render-node-to-output.ts). tsconfig uses jsx:"react-jsx"
// (automatic runtime), which resolves the JSX namespace from the "react"
// module's own exported JSX (react/jsx-runtime.d.ts re-exports React.JSX) —
// NOT the true global JSX namespace, so a `declare global { namespace JSX
// {...} }` augmentation is a silent no-op here (the shared
// src/terminal/ink/global.d.ts's 'ink-box'/'ink-text'/etc entries have the same
// latent bug, visible as the same error on other ink components). The
// augmentation has to target "react"'s own JSX namespace instead.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-raw-ansi': { rawText: string; rawWidth: number; rawHeight: number };
    }
  }
}

/**
 * Bypass the <Ansi> → React tree → Yoga → squash → re-serialize roundtrip for
 * content that is already terminal-ready.
 *
 * Use this when an external renderer (e.g. the ColorDiff NAPI module) has
 * already produced ANSI-escaped, width-wrapped output. A normal <Ansi> mount
 * reparses that output into one React <Text> per style span, lays out each
 * span as a Yoga flex child, then walks the tree to re-emit the same escape
 * codes it was given. For a long transcript full of syntax-highlighted diffs
 * that roundtrip is the dominant cost of the render.
 *
 * This component emits a single Yoga leaf with a constant-time measure func
 * (width × lines.length) and hands the joined string straight to output.write(),
 * which already splits on '\n' and parses ANSI into the screen buffer.
 */
export function RawAnsi(t0: Props) {
  const $ = _c(6);
  const {
    lines,
    width
  } = t0;
  if (lines.length === 0) {
    return null;
  }
  let t1;
  if ($[0] !== lines) {
    t1 = lines.join("\n");
    $[0] = lines;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== lines.length || $[3] !== t1 || $[4] !== width) {
    t2 = <ink-raw-ansi rawText={t1} rawWidth={width} rawHeight={lines.length} />;
    $[2] = lines.length;
    $[3] = t1;
    $[4] = width;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  return t2;
}
