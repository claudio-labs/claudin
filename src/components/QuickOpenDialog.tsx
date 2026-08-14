import { c as _c } from "react-compiler-runtime";
import * as path from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from 'src/context/overlayContext.js';
import { generateFileSuggestions } from 'src/hooks/fileSuggestions.js';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { Text } from 'src/ink.js';
import { logEvent } from 'src/services/analytics/index.js';
import { getCwd } from 'src/utils/fs/cwd.js';
import { openFileInExternalEditor } from 'src/utils/editor.js';
import { truncatePathMiddle, truncateToWidth } from 'src/utils/text/format.js';
import { highlightMatch } from 'src/components/highlightMatch.js';
import { readFileInRange } from 'src/utils/fs/readFileInRange.js';
import { FuzzyPicker } from './design-system/FuzzyPicker.js';
import { LoadingState } from './design-system/LoadingState.js';
import type { SuggestionItem } from './PromptInput/PromptInputFooterSuggestions.js';
type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};
const VISIBLE_RESULTS = 8;
const PREVIEW_LINES = 20;
/** The focused file's first `effectivePreviewLines` lines, once loaded. */
type Preview = {
  path: string;
  content: string;
};

/**
 * Quick Open dialog (ctrl+shift+p / cmd+shift+p).
 * Fuzzy file finder with a syntax-highlighted preview of the focused file.
 */
export function QuickOpenDialog(t0: Props) {
  const $ = _c(35);
  const {
    onDone,
    onInsert
  } = t0;
  useRegisterOverlay("quick-open");
  const {
    columns,
    rows
  } = useTerminalSize();
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14));
  let t1: string[];
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [results, setResults] = useState(t1);
  const [query, setQuery] = useState("");
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | null>(null);
  const queryGenRef = useRef(0);
  let t2;
  let t3: React.DependencyList;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => () => {
      queryGenRef.current = queryGenRef.current + 1;
      return void queryGenRef.current;
    };
    t3 = [];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  useEffect(t2, t3);
  const previewOnRight = columns >= 120;
  const effectivePreviewLines = previewOnRight ? VISIBLE_RESULTS - 1 : PREVIEW_LINES;
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = (q: string) => {
      setQuery(q);
      const gen = queryGenRef.current = queryGenRef.current + 1;
      if (!q.trim()) {
        setResults([]);
        return;
      }
      generateFileSuggestions(q, true).then(items => {
        if (gen !== queryGenRef.current) {
          return;
        }
        const paths = items.filter(_temp).map(_temp2).filter(_temp3).map(_temp4);
        setResults(paths);
      });
    };
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  const handleQueryChange = t4;
  let t5;
  let t6;
  if ($[4] !== effectivePreviewLines || $[5] !== focusedPath) {
    t5 = () => {
      if (!focusedPath) {
        setPreview(null);
        return;
      }
      const controller = new AbortController();
      const absolute = path.resolve(getCwd(), focusedPath);
      readFileInRange(absolute, 0, effectivePreviewLines, undefined, controller.signal).then(r => {
        if (controller.signal.aborted) {
          return;
        }
        setPreview({
          path: focusedPath,
          content: r.content
        });
      }).catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        setPreview({
          path: focusedPath,
          content: "(preview unavailable)"
        });
      });
      return () => controller.abort();
    };
    t6 = [focusedPath, effectivePreviewLines];
    $[4] = effectivePreviewLines;
    $[5] = focusedPath;
    $[6] = t5;
    $[7] = t6;
  } else {
    t5 = $[6];
    t6 = $[7];
  }
  useEffect(t5, t6);
  const maxPathWidth = previewOnRight ? Math.max(20, Math.floor((columns - 10) * 0.4)) : Math.max(20, columns - 8);
  const previewWidth = previewOnRight ? Math.max(40, columns - maxPathWidth - 14) : columns - 6;
  let t7;
  if ($[8] !== onDone || $[9] !== results.length) {
    t7 = (p_1: string) => {
      const opened = openFileInExternalEditor(path.resolve(getCwd(), p_1));
      logEvent("tengu_quick_open_select", {
        result_count: results.length,
        opened_editor: opened
      });
      onDone();
    };
    $[8] = onDone;
    $[9] = results.length;
    $[10] = t7;
  } else {
    t7 = $[10];
  }
  const handleOpen = t7;
  let t8;
  if ($[11] !== onDone || $[12] !== onInsert || $[13] !== results.length) {
    t8 = (p_2: string, mention: boolean) => {
      onInsert(mention ? `@${p_2} ` : `${p_2} `);
      logEvent("tengu_quick_open_insert", {
        result_count: results.length,
        mention
      });
      onDone();
    };
    $[11] = onDone;
    $[12] = onInsert;
    $[13] = results.length;
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  const handleInsert = t8;
  const t9 = previewOnRight ? "right" : "bottom";
  let t10;
  if ($[15] !== handleInsert) {
    t10 = {
      action: "mention",
      handler: (p_4: string) => handleInsert(p_4, true)
    };
    $[15] = handleInsert;
    $[16] = t10;
  } else {
    t10 = $[16];
  }
  let t11;
  if ($[17] !== handleInsert) {
    t11 = {
      action: "insert path",
      handler: (p_5: string) => handleInsert(p_5, false)
    };
    $[17] = handleInsert;
    $[18] = t11;
  } else {
    t11 = $[18];
  }
  let t12;
  if ($[19] !== maxPathWidth) {
    t12 = (p_6: string, isFocused: boolean) => <Text color={isFocused ? "suggestion" : undefined}>{truncatePathMiddle(p_6, maxPathWidth)}</Text>;
    $[19] = maxPathWidth;
    $[20] = t12;
  } else {
    t12 = $[20];
  }
  let t13;
  if ($[21] !== preview || $[22] !== previewWidth || $[23] !== query) {
    t13 = (p_7: string) => preview ? <><Text dimColor={true}>{truncatePathMiddle(p_7, previewWidth)}{preview.path !== p_7 ? " \xB7 loading\u2026" : ""}</Text>{preview.content.split("\n").map((line: string, i_1: number) => <Text key={i_1}>{highlightMatch(truncateToWidth(line, previewWidth), query)}</Text>)}</> : <LoadingState message={"Loading preview\u2026"} dimColor={true} />;
    $[21] = preview;
    $[22] = previewWidth;
    $[23] = query;
    $[24] = t13;
  } else {
    t13 = $[24];
  }
  let t14;
  if ($[25] !== handleOpen || $[26] !== onDone || $[27] !== results || $[28] !== t10 || $[29] !== t11 || $[30] !== t12 || $[31] !== t13 || $[32] !== t9 || $[33] !== visibleResults) {
    t14 = <FuzzyPicker title="Quick Open" placeholder={"Type to search files\u2026"} items={results} getKey={_temp5} visibleCount={visibleResults} direction="up" previewPosition={t9} onQueryChange={handleQueryChange} onFocus={setFocusedPath} onSelect={handleOpen} onTab={t10} onShiftTab={t11} onCancel={onDone} emptyMessage={_temp6} selectAction="open in editor" renderItem={t12} renderPreview={t13} />;
    $[25] = handleOpen;
    $[26] = onDone;
    $[27] = results;
    $[28] = t10;
    $[29] = t11;
    $[30] = t12;
    $[31] = t13;
    $[32] = t9;
    $[33] = visibleResults;
    $[34] = t14;
  } else {
    t14 = $[34];
  }
  return t14;
}
function _temp6(q_0: string) {
  return q_0 ? "No matching files" : "Start typing to search\u2026";
}
function _temp5(p_3: string) {
  return p_3;
}
function _temp4(p_0: string) {
  return p_0.split(path.sep).join("/");
}
function _temp3(p: string) {
  return !p.endsWith(path.sep);
}
function _temp2(i_0: SuggestionItem) {
  return i_0.displayText;
}
function _temp(i: SuggestionItem) {
  return i.id.startsWith("file-");
}
