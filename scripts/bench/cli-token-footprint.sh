#!/usr/bin/env bash
#
# cli-token-footprint.sh — compare the per-turn token footprint of two
# Claude Code-family CLIs (claude vs claudiodev) on the same workload.
#
# For each CLI it:
#   1. runs N "read this file and summarize it" turns headless (--output-format
#      json) and records tokens sent (input + cache_creation + cache_read) and
#      received (output) per file;
#   2. runs M "edit this file" turns headless against copies in a scratch dir
#      (real source files are NOT mutated);
#   3. captures a /context breakdown at the end (static overhead: system prompt,
#      tools, memory, skills).
#
# Output is a markdown report to stdout and to scripts/bench/results/.
#
# Usage:
#   scripts/bench/cli-token-footprint.sh
#   READ_FILES="src/a.ts src/b.ts" EDIT_FILES="src/c.ts" scripts/bench/cli-token-footprint.sh
#
# Env:
#   CLIS="claudiodev claude"   # which binaries to compare (space-separated)
#   MODEL=claude-opus-4-8      # force same model on both (default: each CLI's default)
#   PROMPT_TMPL="Read the file %s and give a 3-sentence summary of what it does."
#   EDIT_PROMPT_TMPL='Add a single-line comment "// bench touch" at the very top of %s and save the file.'
#   READ_FILES=                # space-separated override; default: top-10 largest non-test src files
#   EDIT_FILES=                # space-separated override; default: 5 medium-sized non-test src files
#
# Requires: jq, and each CLI on $PATH with a working provider/auth.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CLIS="${CLIS:-claudiodev claude}"
PROMPT_TMPL="${PROMPT_TMPL:-Read the file %s and give a 3-sentence summary of what it does.}"
EDIT_PROMPT_TMPL="${EDIT_PROMPT_TMPL:-Add a single-line comment \"// bench touch\" at the very top of %s and save the file.}"
TIMEOUT="${TIMEOUT:-240}"
MODEL="${MODEL:-claude-opus-4-8}"

# Default read workload: the 10 largest non-test source files.
if [ -n "${READ_FILES:-}" ]; then
  # shellcheck disable=SC2206
  R_FILES=( $READ_FILES )
else
  mapfile -t R_FILES < <(find src -type f \( -name '*.ts' -o -name '*.tsx' \) \
    -not -name '*.test.*' -printf '%s %p\n' | sort -rn | head -10 | awk '{print $2}')
fi

# Default edit workload: 5 medium-sized (5k-15k bytes) non-test source files,
# disjoint from the read set, sorted by path for determinism.
if [ -n "${EDIT_FILES:-}" ]; then
  # shellcheck disable=SC2206
  E_FILES=( $EDIT_FILES )
else
  # Build an awk filter that excludes anything already in R_FILES.
  read_filter=$(printf '%s\n' "${R_FILES[@]}" | awk '{printf "exclude[\"%s\"]=1; ", $0}')
  mapfile -t E_FILES < <(find src -type f -size +5k -size -15k \
    \( -name '*.ts' -o -name '*.tsx' \) -not -name '*.test.*' \
    | awk "BEGIN{${read_filter}} !exclude[\$0]" | sort | head -5)
fi

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

RESULTS_DIR="$REPO_ROOT/scripts/bench/results"
mkdir -p "$RESULTS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW_DIR="$(mktemp -d)"
trap 'rm -rf "$RAW_DIR"' EXIT

model_args=()
[ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")

# STRICT_MCP=1 ignores each CLI's configured MCP servers so the comparison
# reflects the CLI's intrinsic footprint, not whichever MCP tools happen to be
# wired up on one side. Default off (real-world footprint).
STRICT_MCP="${STRICT_MCP:-0}"
mcp_args=(); [ "$STRICT_MCP" = "1" ] && mcp_args=(--strict-mcp-config --mcp-config '{"mcpServers":{}}')

# Cost estimate (rough): last run averaged ~$0.05-$0.30/turn depending on file size.
n_read=${#R_FILES[@]}
n_edit=${#E_FILES[@]}
n_clis=$(echo "$CLIS" | wc -w)
n_total=$(( (n_read + n_edit) * n_clis ))
echo "==> $n_read read turns + $n_edit edit turns × $n_clis CLIs = $n_total turns total" >&2
echo "==> Rough cost estimate: \$$(awk "BEGIN{printf \"%.2f\", $n_total*0.15}") (varies by file size)" >&2

# run_turn <cli> <file> <idx> <tools> <prompt_tmpl> -> writes $RAW_DIR/<cli>.<idx>.json, echoes tsv row
run_turn() {
  local cli="$1" file="$2" idx="$3" tools="$4" tmpl="$5"
  local prompt out
  # shellcheck disable=SC2059
  prompt="$(printf "$tmpl" "$file")"
  out="$RAW_DIR/${cli}.${idx}.json"
  if ! timeout "$TIMEOUT" "$cli" -p "$prompt" \
        --output-format json --allowedTools "$tools" "${model_args[@]}" "${mcp_args[@]}" \
        >"$out" 2>"$RAW_DIR/${cli}.${idx}.err"; then
    echo "  ! $cli failed on $file (see ${cli}.${idx}.err)" >&2
  fi
  # `// 0` on every field: an errored/timed-out result has no `.usage`, which
  # would otherwise emit empty cells (printf "%d" → "invalid number") and zero
  # the row silently.
  jq -r '[(.usage.input_tokens // 0), (.usage.cache_creation_input_tokens // 0),
          (.usage.cache_read_input_tokens // 0), (.usage.output_tokens // 0),
          (.total_cost_usd // 0), (.duration_ms // 0)] | @tsv' "$out" 2>/dev/null \
    || echo -e "0\t0\t0\t0\t0\t0"
}

# context_table <cli> -> echoes the "category<TAB>tokens" lines from /context
context_breakdown() {
  local cli="$1" out="$RAW_DIR/${cli}.context.md"
  timeout "$TIMEOUT" "$cli" -p "/context" "${model_args[@]}" "${mcp_args[@]}" >"$out" 2>/dev/null || true
  # parse markdown rows: | Category | 6.7k | 3.4% |  (skip the per-tool MCP rows)
  awk -F'|' '
    /^\| *[A-Za-z]/ && !/Category/ && !/-----/ && $4 ~ /%/ {
      gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $3);
      print $2 "\t" $3
    }' "$out"
}

# k_to_num "6.7k" -> 6700 ; "416" -> 416 ; anything without digits -> 0
# Always emits an integer so callers can use it in `$(( ))` without aborting.
k_to_num() {
  local v="$1"
  if [[ "$v" =~ ^([0-9.]+)k$ ]]; then
    awk "BEGIN{printf \"%d\", ${BASH_REMATCH[1]}*1000}"
  else
    local digits="${v//[^0-9]/}"
    echo "${digits:-0}"
  fi
}

# stage_edits <cli> -> copies E_FILES into $RAW_DIR/edits/<cli>/ and echoes
# the staged paths (one per line) in the same order as E_FILES.
stage_edits() {
  local cli="$1"
  local dest="$RAW_DIR/edits/$cli"
  rm -rf "$dest"
  mkdir -p "$dest"
  local i=0
  for f in "${E_FILES[@]}"; do
    # Use index-prefixed names to avoid basename collisions across dirs.
    local target="$dest/$(printf '%02d' "$i")_$(basename "$f")"
    cp "$f" "$target"
    echo "$target"
    i=$((i+1))
  done
}

REPORT="$RESULTS_DIR/cli-token-footprint-$STAMP.md"
{
  echo "# CLI token footprint — $STAMP"
  echo
  echo "Workload: $n_read read turns + $n_edit edit turns per CLI."
  echo "Model: ${MODEL:-each CLI default}."
  echo
  echo "**Read files:**"
  for f in "${R_FILES[@]}"; do
    printf -- "- \`%s\` (%s)\n" "$f" "$(du -h "$f" 2>/dev/null | cut -f1)"
  done
  echo
  echo "**Edit files** (copied to scratch dir; real files untouched):"
  for f in "${E_FILES[@]}"; do
    printf -- "- \`%s\` (%s)\n" "$f" "$(du -h "$f" 2>/dev/null | cut -f1)"
  done
  echo

  for cli in $CLIS; do
    echo "## $cli"
    echo
    echo "### Per-turn token usage (reads)"
    echo
    echo "| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |"
    echo "|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|"
    r_in=0; r_cw=0; r_cr=0; r_out=0; r_cost=0
    idx=0
    for f in "${R_FILES[@]}"; do
      IFS=$'\t' read -r in cw cr outt cost ms < <(run_turn "$cli" "$f" "r$idx" "Read" "$PROMPT_TMPL")
      sent=$(( in + cw + cr ))
      printf "| %s | %d | %d | %d | %d | %d | %.4f | %d |\n" \
        "$(basename "$f")" "$sent" "$in" "$cw" "$cr" "$outt" "$cost" "$ms"
      r_in=$((r_in+in)); r_cw=$((r_cw+cw)); r_cr=$((r_cr+cr)); r_out=$((r_out+outt))
      r_cost=$(awk "BEGIN{print $r_cost + $cost}")
      idx=$((idx+1))
    done
    r_sent=$(( r_in + r_cw + r_cr ))
    printf "| **TOTAL reads** | **%d** | %d | %d | %d | %d | %.4f | |\n" \
      "$r_sent" "$r_in" "$r_cw" "$r_cr" "$r_out" "$r_cost"
    echo

    echo "### Per-turn token usage (edits)"
    echo
    echo "| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |"
    echo "|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|"
    e_in=0; e_cw=0; e_cr=0; e_out=0; e_cost=0
    idx=0
    # Stage fresh copies for this CLI so each starts from identical baseline.
    mapfile -t staged < <(stage_edits "$cli")
    for f in "${staged[@]}"; do
      IFS=$'\t' read -r in cw cr outt cost ms < <(run_turn "$cli" "$f" "e$idx" "Read,Edit" "$EDIT_PROMPT_TMPL")
      sent=$(( in + cw + cr ))
      printf "| %s | %d | %d | %d | %d | %d | %.4f | %d |\n" \
        "$(basename "$f")" "$sent" "$in" "$cw" "$cr" "$outt" "$cost" "$ms"
      e_in=$((e_in+in)); e_cw=$((e_cw+cw)); e_cr=$((e_cr+cr)); e_out=$((e_out+outt))
      e_cost=$(awk "BEGIN{print $e_cost + $cost}")
      idx=$((idx+1))
    done
    e_sent=$(( e_in + e_cw + e_cr ))
    printf "| **TOTAL edits** | **%d** | %d | %d | %d | %d | %.4f | |\n" \
      "$e_sent" "$e_in" "$e_cw" "$e_cr" "$e_out" "$e_cost"
    echo

    g_sent=$(( r_sent + e_sent ))
    g_in=$(( r_in + e_in ))
    g_cw=$(( r_cw + e_cw ))
    g_cr=$(( r_cr + e_cr ))
    g_out=$(( r_out + e_out ))
    g_cost=$(awk "BEGIN{print $r_cost + $e_cost}")
    echo "### GRAND TOTAL (reads + edits)"
    echo
    echo "| | Sent | input | cache write | cache read | output | cost USD |"
    echo "|-|-----:|------:|------------:|-----------:|-------:|---------:|"
    printf "| **%s** | **%d** | %d | %d | %d | %d | **%.4f** |\n" \
      "$cli" "$g_sent" "$g_in" "$g_cw" "$g_cr" "$g_out" "$g_cost"
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
