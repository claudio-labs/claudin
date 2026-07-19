# Bench A/B — effort (adaptive vs xhigh) x narracao

- Timestamp: 2026-05-30T01:08:23.052Z
- Model: `claude-opus-4-8`
- Bundle (A e B): `/home/dev/projects/claudio/dist/cli.mjs`
- Variante A: effort=`adaptive`
- Variante B: effort=`xhigh`
- Runs por prompt: 1
- KPI: chars de narracao inter-tool-call (texto assistant fora da resposta final)

## Tabela por invocacao

| Prompt | V | eff | Run | OK | narr blocks | narr chars | answer chars | out tok | cost $ | wall(s) | turns | tools |
|---|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | adaptive | 1 | Y | 6 | 837 | 6609 | 4828 | 0.7764 | 71.4 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | xhigh | 1 | Y | 0 | 0 | 6783 | 5662 | 2.0408 | 87.6 | 12 | Read=10 Grep=0 Glob=0 Bash=1 |

## Sumario

### A (effort=adaptive) (n=1)

- Avg narration blocks: 6.00
- Avg narration chars: 837
- Avg answer chars: 6609
- Avg output tokens: 4828
- Avg cost: $0.7764 (total $0.7764)
- Avg cache-creation tokens: 41634
- Avg turns: 12.0
- Tool totals: Read=9 Grep=0 Glob=2 Bash=0

### B (effort=xhigh) (n=1)

- Avg narration blocks: 0.00
- Avg narration chars: 0
- Avg answer chars: 6783
- Avg output tokens: 5662
- Avg cost: $2.0408 (total $2.0408)
- Avg cache-creation tokens: 169588
- Avg turns: 12.0
- Tool totals: Read=10 Grep=0 Glob=0 Bash=1

### Delta (A=adaptive -> B=xhigh)

- Narration chars: 837 -> 0 (rel -100.0%)
- Narration blocks: 6.00 -> 0.00 (rel -100.0%)
- Output tokens: 4828 -> 5662 (rel 17.3%)
- Answer chars: 6609 -> 6783 (rel 2.6%)
- Avg cost delta: 162.8%

### Kill criteria (meta usuario: -70 a -80% de narracao)

- SHIP (recomendar xhigh default p/ loops 4.8) se B reduz narration chars em >=70% rel E answer chars nao cai >15% E custo nao estoura (>+30%).
- PARCIAL/INVESTIGAR se narration cai mas <70%, OU cai >=70% porem custo sobe demais (>+30%) — comparar com Frente 1 (stripper determinístico).
- KILL (effort inerte p/ narracao) se reducao <25% — seguir com Frente 1.
- DEGRADOU se answer chars despenca >15% (modelo ficou mudo demais).

- Veredito: **PARCIAL (atingiu narracao mas custo estourou) -> comparar Frente 1**
  - narration chars delta: -100.0% (meta <=-70: OK)
  - answer chars delta: 2.6% (OK)
  - cost delta: 162.8% (caro)

> Ler runs BRUTAS, nao so medias. Narracao no mesmo baseline varia ~551-1037 chars
> entre runs identicas (ruido). Exigir efeito bem acima desse ruido.

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A (effort=adaptive) run#1** (6 blocks):

- The directory exists. The most relevant files for tool-call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- The middle of messageConverter.ts (lines 51-411) is where the tool_use → tool_calls translation happens. Let me read it, plus the streamParser for the reverse direction.
- I need the core of both: the tool_use→tool_calls mapping in messageConverter (100-364) and the tool_call reassembly loop in streamParser (51-494).
- I still need lines 150-314 (the pre-scan + tool_result emission + assistant tool_use mapping start) and the streamParser tool-call reassembly (51-494).
- The streamParser tool-call reassembly loop (lines 100-444) is the key reverse path. Let me read it.
- The core streaming reassembly (lines 200-394, where tool_call deltas accumulate) is still hidden. Let me read it.

