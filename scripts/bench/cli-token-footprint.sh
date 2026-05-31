#!/usr/bin/env bash
#
# cli-token-footprint.sh — compare the per-turn token footprint of two
# Claude Code-family CLIs (claude vs claudiodev) on the same workload.
#
# For each CLI it:
#   1. runs N "read this file and summarize it" turns headless (--output-format
#      json) and records tokens sent (input + cache_creation + cache_read) and
#      received (output) per file;
#   2. captures a /context breakdown at the end (static overhead: system prompt,
#      tools, memory, skills).
#
# Output is a markdown report to stdout and to scripts/bench/results/.
#
# Usage:
#   scripts/bench/cli-token-footprint.sh [file1 file2 file3 ...]
#
# Env:
#   CLIS="claudiodev claude"   # which binaries to compare (space-separated)
#   MODEL=claude-opus-4-8      # force same model on both (default: each CLI's default)
#   PROMPT_TMPL="Read the file %s and give a 3-sentence summary of what it does."
#
# Requires: jq, and each CLI on $PATH with a working provider/auth.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CLIS="${CLIS:-claudiodev claude}"
PROMPT_TMPL="${PROMPT_TMPL:-Read the file %s and give a 3-sentence summary of what it does.}"
TIMEOUT="${TIMEOUT:-240}"

# Default workload: the 3 largest non-test source files.
if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  mapfile -t FILES < <(find src -type f \( -name '*.ts' -o -name '*.tsx' \) \
    -not -name '*.test.*' -printf '%s %p\n' | sort -rn | head -3 | awk '{print $2}')
fi

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

RESULTS_DIR="$REPO_ROOT/scripts/bench/results"
mkdir -p "$RESULTS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW_DIR="$(mktemp -d)"
trap 'rm -rf "$RAW_DIR"' EXIT

model_args=()
[ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")

# run_turn <cli> <file> -> writes $RAW_DIR/<cli>.<idx>.json, echoes tsv row
run_turn() {
  local cli="$1" file="$2" idx="$3"
  local prompt out
  # shellcheck disable=SC2059
  prompt="$(printf "$PROMPT_TMPL" "$file")"
  out="$RAW_DIR/${cli}.${idx}.json"
  if ! timeout "$TIMEOUT" "$cli" -p "$prompt" \
        --output-format json --allowedTools Read "${model_args[@]}" \
        >"$out" 2>"$RAW_DIR/${cli}.${idx}.err"; then
    echo "  ! $cli failed on $file (see ${cli}.${idx}.err)" >&2
  fi
  jq -r '[.usage.input_tokens, .usage.cache_creation_input_tokens,
          .usage.cache_read_input_tokens, .usage.output_tokens,
          (.total_cost_usd // 0), (.duration_ms // 0)] | @tsv' "$out" 2>/dev/null \
    || echo -e "0\t0\t0\t0\t0\t0"
}

# context_table <cli> -> echoes the "category<TAB>tokens" lines from /context
context_breakdown() {
  local cli="$1" out="$RAW_DIR/${cli}.context.md"
  timeout "$TIMEOUT" "$cli" -p "/context" "${model_args[@]}" >"$out" 2>/dev/null || true
  # parse markdown rows: | Category | 6.7k | 3.4% |  (skip the per-tool MCP rows)
  awk -F'|' '
    /^\| *[A-Za-z]/ && !/Category/ && !/-----/ && $4 ~ /%/ {
      gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $3);
      print $2 "\t" $3
    }' "$out"
}

# k_to_num "6.7k" -> 6700 ; "416" -> 416
k_to_num() {
  local v="$1"
  if [[ "$v" =~ ^([0-9.]+)k$ ]]; then
    awk "BEGIN{printf \"%d\", ${BASH_REMATCH[1]}*1000}"
  else
    echo "${v//[^0-9]/}"
  fi
}

REPORT="$RESULTS_DIR/cli-token-footprint-$STAMP.md"
{
  echo "# CLI token footprint — $STAMP"
  echo
  echo "Workload: read + 3-sentence summary, one turn per file."
  echo "Model: ${MODEL:-each CLI default}. Files:"
  for f in "${FILES[@]}"; do
    printf -- "- \`%s\` (%s)\n" "$f" "$(du -h "$f" 2>/dev/null | cut -f1)"
  done
  echo

  for cli in $CLIS; do
    echo "## $cli"
    echo
    echo "### Per-turn token usage"
    echo
    echo "| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |"
    echo "|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|"
    s_in=0; s_cw=0; s_cr=0; s_out=0; s_cost=0
    idx=0
    for f in "${FILES[@]}"; do
      IFS=$'\t' read -r in cw cr outt cost ms < <(run_turn "$cli" "$f" "$idx")
      sent=$(( in + cw + cr ))
      printf "| %s | %d | %d | %d | %d | %d | %.4f | %d |\n" \
        "$(basename "$f")" "$sent" "$in" "$cw" "$cr" "$outt" "$cost" "$ms"
      s_in=$((s_in+in)); s_cw=$((s_cw+cw)); s_cr=$((s_cr+cr)); s_out=$((s_out+outt))
      s_cost=$(awk "BEGIN{print $s_cost + $cost}")
      idx=$((idx+1))
    done
    s_sent=$(( s_in + s_cw + s_cr ))
    printf "| **TOTAL** | **%d** | %d | %d | %d | %d | %.4f | |\n" \
      "$s_sent" "$s_in" "$s_cw" "$s_cr" "$s_out" "$s_cost"
    echo
    echo "### /context (static overhead, fresh session)"
    echo
    echo "| Category | Tokens |"
    echo "|----------|-------:|"
    total_ctx=0
    while IFS=$'\t' read -r cat tok; do
      [ -z "$cat" ] && continue
      echo "| $cat | $tok |"
      # Exclude free space, the autocompact reserve, and deferred tool
      # schemas — none of those are part of the per-turn payload that's
      # actually sent (deferred schemas load on demand via tool search).
      case "$cat" in
        "Free space"|"Autocompact buffer"|*"(deferred)"*) ;;
        *) total_ctx=$(( total_ctx + $(k_to_num "$tok") )) ;;
      esac
    done < <(context_breakdown "$cli")
    printf "| **Active total (excl. free/buffer)** | **%d** |\n" "$total_ctx"
    echo
  done
} | tee "$REPORT"

echo >&2
echo "report saved: $REPORT" >&2
