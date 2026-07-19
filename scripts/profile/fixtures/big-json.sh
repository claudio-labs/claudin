#!/usr/bin/env bash
# Deterministic ~80KB homogeneous JSON array for the cache-ab-bench `json`
# workload. Pure local generator — no network/auth — so the bench is
# reproducible run-to-run. Emits a single minified line (the realistic
# `gh ... --json` / `curl | jq -c` shape), which is exactly why the feature
# persists a JSON-lines canonical so Read offset/limit still addresses rows.
#
# Usage: big-json.sh [count] [salient]
#   count    rows (default 300 ≈ 80KB)
#   salient  when non-empty, inject a few rare/error rows into the dropped
#            MIDDLE window (the #41..#(n-10) zone the head/tail compressor
#            discards). Keys stay identical (still schema-factors); only the
#            VALUES are rare: state="CONFLICT" (vs OPEN/MERGED) + an error
#            keyword in the title. This is the #6 salient-row-preservation
#            fixture — it lets the bench prove whether the failing row is the
#            one being dropped. Default (no arg) stays byte-identical so the
#            existing constant-field-hoist baseline is unchanged.
set -euo pipefail
n="${1:-300}"
salient="${2:-}"

# Salient rows live deep in the dropped middle (head keeps #1..#40, tail keeps
# the last 10), so a naive head/tail window discards every one of them.
mid=$((n / 2))
is_salient() {
  [ -n "$salient" ] || return 1
  case "$1" in "$mid" | "$((mid + 1))" | "$((mid + 70))") return 0 ;; esac
  return 1
}

printf '['
for ((i = 1; i <= n; i++)); do
  [ "$i" -gt 1 ] && printf ','
  if is_salient "$i"; then
    # Rare status value + error keyword — both #6 signals, same key signature.
    printf '{"number":%d,"title":"Pull request %d: merge FAILED — conflicting changes block this branch","state":"CONFLICT","author":"dev","mergeable":false,"comments":%d,"labels":["area/cache","type/perf"]}' \
      "$i" "$i" "$((i * 2))"
    continue
  fi
  state=$([ $((i % 2)) -eq 0 ] && echo OPEN || echo MERGED)
  mergeable=$([ $((i % 3)) -eq 0 ] && echo true || echo false)
  printf '{"number":%d,"title":"Pull request %d: a reasonably long descriptive title used to pad the row width for benchmarking","state":"%s","author":"dev","mergeable":%s,"comments":%d,"labels":["area/cache","type/perf"]}' \
    "$i" "$i" "$state" "$mergeable" "$((i * 2))"
done
printf ']\n'
