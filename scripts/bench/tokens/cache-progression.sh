#!/usr/bin/env bash
#
# cache-progression.sh — measure prompt-cache progression PER API CALL.
#
# Runs N identical read invocations followed by M identical edit invocations
# against the same file (reset between each edit). Goal: distinguish a small-
# prefix cache from a broken cache_control breakpoint, and surface real cache
# degradation across invocations.
#
# WHY per-call (not per-invocation): `--output-format json` reports usage
# AGGREGATED over the whole invocation. A single "Read + summarize" prompt
# takes a variable number of agent steps (2 vs 3 API calls) depending on model
# nondeterminism, so the aggregate cache_read appears to "oscillate" (e.g.
# 54k <-> 83k) when the per-call cache is actually byte-stable. We use
# stream-json and dedup by message.id to attribute usage to each real API call,
# then compare the SAME call position across invocations. That is the only view
# in which genuine cache degradation (a prefix that stops being reused) shows up
# as drift in cache_read at a fixed call index.
#
# Per-call interpretation (for a fixed call position across invocations):
#   - cache_read should be STABLE invocation-to-invocation (byte-identical
#     prefix => same server-side cache hit). Drift = a non-deterministic prefix.
#   - call 1 carries system+tools; call 2+ carry prior tool results. cache_read
#     should grow within an invocation (call N reads what call N-1 wrote).
#
# Usage: scripts/bench/tokens/cache-progression.sh
#   CLIS="claudindev claude"   which binaries to compare
#   READ_TURNS / EDIT_TURNS    invocation counts
#   STRICT_MCP=1               ignore user MCP config (deterministic prefix)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CLIS="${CLIS:-claudindev claude}"
MODEL="${MODEL:-claude-opus-4-8}"
READ_TURNS="${READ_TURNS:-6}"
EDIT_TURNS="${EDIT_TURNS:-3}"
TIMEOUT="${TIMEOUT:-180}"
READ_FILE="${READ_FILE:-src/screens/REPL.tsx}"
EDIT_SRC="${EDIT_SRC:-src/bridge/bridgeEnabled.ts}"
STRICT_MCP="${STRICT_MCP:-1}"   # 1 = ignore user MCP config for a deterministic prefix
READ_PROMPT="Read the file %s and give a 3-sentence summary of what it does."
EDIT_PROMPT='Add a single-line comment "// bench touch" at the very top of %s and save the file.'

command -v jq >/dev/null || { echo "error: jq required" >&2; exit 1; }
RAW_DIR="$(mktemp -d)"; trap 'rm -rf "$RAW_DIR"' EXIT
RESULTS_DIR="$REPO_ROOT/scripts/bench/results"
mkdir -p "$RESULTS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$RESULTS_DIR/cache-progression-$STAMP.md"

model_args=(); [ -n "$MODEL" ] && model_args=(--model "$MODEL")
mcp_args=(); [ "$STRICT_MCP" = "1" ] && mcp_args=(--strict-mcp-config --mcp-config '{"mcpServers":{}}')

# run_invocation: cli prompt tools tag
#   stdout: TSV per API call -> "callno  in  cw  cr  out"
#           plus one trailing summary line -> "SUMMARY  num_turns  agg_cw  agg_cr  cost  ms"
run_invocation() {
  local cli="$1" prompt="$2" tools="$3" tag="$4"
  local raw="$RAW_DIR/${cli}.${tag}.jsonl"
  timeout "$TIMEOUT" "$cli" -p "$prompt" \
    --output-format stream-json --verbose --allowedTools "$tools" \
    "${model_args[@]}" "${mcp_args[@]}" \
    >"$raw" 2>"$RAW_DIR/${cli}.${tag}.err" || echo "  ! $cli failed on $tag" >&2

  # Per-call usage: dedup by message.id (events for one id stream contiguously,
  # so emit the LAST line of each contiguous id group = final usage for that call).
  jq -rc 'select(.type=="assistant")
          | [.message.id,
             (.message.usage.input_tokens // 0),
             (.message.usage.cache_creation_input_tokens // 0),
             (.message.usage.cache_read_input_tokens // 0),
             (.message.usage.output_tokens // 0)] | @tsv' "$raw" 2>/dev/null \
  | awk -F'\t' '
      NR==1 { pid=$1; line=$0; n=0; next }
      $1!=pid { n++; sub(/^[^\t]*\t/,"",line); print n"\t"line; pid=$1 }
      { line=$0 }
      END { if (NR>0) { n++; sub(/^[^\t]*\t/,"",line); print n"\t"line } }'

  # Aggregate summary from the terminal result event.
  jq -rc 'select(.type=="result")
          | "SUMMARY\t\(.num_turns // 0)\t\(.usage.cache_creation_input_tokens // 0)\t\(.usage.cache_read_input_tokens // 0)\t\(.total_cost_usd // 0)\t\(.duration_ms // 0)"' \
        "$raw" 2>/dev/null | head -1 \
    || echo -e "SUMMARY\t0\t0\t0\t0\t0"
}

emit_block() {  # cli label count prompt tools tagprefix [reset_src]
  local cli="$1" label="$2" count="$3" prompt="$4" tools="$5" tagp="$6" reset_src="${7:-}"
  echo "### $label ($count invocations, same prompt)"
  echo
  echo "Per-API-call (compare cache_read down a fixed Call # — stable = healthy):"
  echo
  echo "| Inv | Call | input | cache_write | cache_read | output |"
  echo "|----:|-----:|------:|------------:|-----------:|-------:|"
  local summaries=()
  for i in $(seq 1 "$count"); do
    local p="$prompt"
    if [ -n "$reset_src" ]; then
      local scratch="$RAW_DIR/edits/$cli"; mkdir -p "$scratch"
      local target="$scratch/$(basename "$reset_src")"
      cp "$reset_src" "$target"
      p="$(printf "$EDIT_PROMPT" "$target")"
    fi
    local out; out="$(run_invocation "$cli" "$p" "$tools" "${tagp}$i")"
    while IFS=$'\t' read -r c f1 f2 f3 f4; do
      if [ "$c" = "SUMMARY" ]; then
        # f1=num_turns f2=agg_cw f3=agg_cr f4... handled below via separate parse
        summaries+=("$i|$f1|$f2|$f3")
      else
        printf "| %d | %s | %s | %s | %s | %s |\n" "$i" "$c" "$f1" "$f2" "$f3" "$f4"
      fi
    done <<< "$out"
  done
  echo
  echo "Aggregate per invocation (what the old per-invocation view showed):"
  echo
  echo "| Inv | num_turns | agg cache_write | agg cache_read |"
  echo "|----:|----------:|----------------:|---------------:|"
  for s in "${summaries[@]}"; do
    IFS='|' read -r inv nt cw cr <<< "$s"
    printf "| %s | %s | %s | %s |\n" "$inv" "$nt" "$cw" "$cr"
  done
  echo
}

{
  echo "# Cache progression (per-call) — $STAMP"
  echo
  echo "Model: \`$MODEL\` · STRICT_MCP=$STRICT_MCP"
  echo "Read file: \`$READ_FILE\` · Edit file: \`$EDIT_SRC\`"
  echo
  echo "Cache TTL is 1h on first-party. The per-call table is the signal:"
  echo "a healthy cache shows the SAME cache_read at a fixed Call # across"
  echo "invocations. The aggregate table varies with agent step count"
  echo "(num_turns) and is kept only for reference."
  echo

  read_prompt_str="$(printf "$READ_PROMPT" "$READ_FILE")"

  for cli in $CLIS; do
    echo "## $cli"
    echo
    emit_block "$cli" "Reads" "$READ_TURNS" "$read_prompt_str" "Read" "r"
    [ "$EDIT_TURNS" -gt 0 ] && emit_block "$cli" "Edits" "$EDIT_TURNS" "" "Read,Edit" "e" "$EDIT_SRC"
  done
} | tee "$REPORT"

echo "report saved: $REPORT" >&2
