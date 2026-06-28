#!/usr/bin/env bash
# Deterministic ~80KB homogeneous JSON array for the cache-ab-bench `json`
# workload. Pure local generator — no network/auth — so the bench is
# reproducible run-to-run. Emits a single minified line (the realistic
# `gh ... --json` / `curl | jq -c` shape), which is exactly why the feature
# persists a JSON-lines canonical so Read offset/limit still addresses rows.
#
# Usage: big-json.sh [count]   (default 300 rows ≈ 80KB)
set -euo pipefail
n="${1:-300}"
printf '['
for ((i = 1; i <= n; i++)); do
  [ "$i" -gt 1 ] && printf ','
  state=$([ $((i % 2)) -eq 0 ] && echo OPEN || echo MERGED)
  mergeable=$([ $((i % 3)) -eq 0 ] && echo true || echo false)
  printf '{"number":%d,"title":"Pull request %d: a reasonably long descriptive title used to pad the row width for benchmarking","state":"%s","author":"viudes","mergeable":%s,"comments":%d,"labels":["area/cache","type/perf"]}' \
    "$i" "$i" "$state" "$mergeable" "$((i * 2))"
done
printf ']\n'
