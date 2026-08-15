import { c as _c } from "react-compiler-runtime";
import type { ReactNode } from 'react';
import React from 'react';
import { supportsHyperlinks } from 'src/ink/supports-hyperlinks.js';
import Text from 'src/ink/components/Text.js';
export type Props = {
  readonly children?: ReactNode;
  readonly url: string;
  readonly fallback?: ReactNode;
};

// 'ink-link' is a real host element recognized by the renderer (src/ink/dom.ts).
// tsconfig uses jsx:"react-jsx" (automatic runtime), which resolves the JSX
// namespace from the "react" module's own exported JSX (react/jsx-runtime.d.ts
// re-exports React.JSX) — NOT the true global JSX namespace, so a
// `declare global { namespace JSX {...} }` augmentation is a silent no-op
// here (the shared src/ink/global.d.ts's 'ink-box'/'ink-text'/etc entries have
// the same latent bug, visible as the same error on other ink components).
// The augmentation has to target "react"'s own JSX namespace instead.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-link': { href: string; children?: ReactNode };
    }
  }
}
export default function Link(t0: Props) {
  const $ = _c(5);
  const {
    children,
    url,
    fallback
  } = t0;
  const content = children ?? url;
  if (supportsHyperlinks()) {
    let t1;
    if ($[0] !== content || $[1] !== url) {
      t1 = <Text><ink-link href={url}>{content}</ink-link></Text>;
      $[0] = content;
      $[1] = url;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  const t1 = fallback ?? content;
  let t2;
  if ($[3] !== t1) {
    t2 = <Text>{t1}</Text>;
    $[3] = t1;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
}
