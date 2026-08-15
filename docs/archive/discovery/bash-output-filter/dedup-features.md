# Dedup features — detecção dinâmica de redundância

Comandos com erros/logs frequentemente têm **conteúdo duplicado** que regex command-aware não cobre — porque a duplicação depende do que aconteceu em runtime, não do comando em si. Esta página documenta as 3 features de dedup propostas para o filter pipeline.

> **Status:** prototipadas em `validation/pipeline.ts`, validadas com 6 test cases. Já existem no claudin (`src/services/tools/toolResultSummarizer.ts:475-533`) mas só ativam acima do threshold de 8KB. A proposta é **trazer pro filter declarativo** para aplicar mesmo em outputs pequenos.

## 3 estratégias, do mais conservador ao mais agressivo

### 1. `collapseRuns` — runs consecutivos idênticos

```
Input:                          Output:
Connecting...                   Connecting... (×3)
Connecting...                   Failed
Connecting...                   Done.
Failed
Done.
```

**Quando aplicar:**
- Default em todo filter — overhead mínimo, zero false positives
- Output de spinners flushados linha-a-linha (raro em bash, comum em TTY)

**Limitação:** se linhas alternam (`A B A B A B`), nada colapsa.

**Validado em sample sintético:**
- `synthetic-runs.txt` (12 linhas alternadas) → **0% redução** ✓ (limitação confirmada)

### 2. `collapseDigitTemplates` — runs com dígitos variando

```
Input:                          Output:
Progress: 0% (0/100)            Progress: 0% (0/100) (11 updates)
Progress: 1% (1/100)            Done.
Progress: 2% (2/100)
... (8 mais)
Progress: 100% (100/100)
Done.
```

**Como funciona:** substitui dígitos por `#` antes de comparar. Duas linhas viram "mesmo template" se diferem só em números.

**Quando aplicar:**
- Progress bars
- Counters (`Retry 1/10`, `Retry 2/10`, etc.)
- Time-elapsed (`[1s elapsed]`, `[2s elapsed]`)
- File counts (`Processing file 1`, `Processing file 2`)

**Parâmetro `minRun`** (default 5): só colapsa se 5+ linhas seguem o mesmo template — preserva line-numbered debug output (`line 1`, `line 2`, `line 3`).

**Validado:**
- `synthetic-progress.txt` (11 linhas progress bar) → **77% redução** ✓
- Mesmo sample com `collapseRuns` em vez de templates → 0% (confirma necessidade)

### 3. `dedupGlobal` — global, não-consecutivo (mais agressivo)

```
Input:                          Output:
Connecting...                   Connecting...
Failed                          Failed
Connecting...                   Done.
Failed                          [9 duplicate lines deduplicated]
Connecting...
Failed
Connecting...
Failed
Done.
```

**Como funciona:** Set de linhas vistas. Mantém só primeira ocorrência. Adiciona footer com count.

**Quando aplicar:**
- Retry loops com mensagens repetitivas
- Output de scripts que fazem algo N vezes
- Warnings duplicados em arquivos diferentes

**Riscos:**
- **Quebra logs onde repetição = throughput** (ex: "request received" 1000× durante 60s = info de carga)
- **Perde correlação** (qual linha veio de onde quando duplicadas)
- Por isso é **opt-in por filter**, nunca default

**Validado:**
- `synthetic-runs.txt` (12 linhas alternadas) → **71% redução** ✓
- `synthetic-cargo-warnings.txt` (4 warnings idênticos) → 27% redução ✓

## Posição no pipeline

```
1. stripAnsi
2. replace
3. collapseRuns          ← novo, default-on (safe)
4. collapseDigitTemplates ← novo, opt-in
5. dedupGlobal           ← novo, opt-in (mais agressivo)
6. matchOutput
7. stripLines / keepLines
8. truncateLineAt
9. headLines + tailLines
10. maxLines
11. onEmpty
```

**Razão da ordem:**
- ANTES de `matchOutput`: dedup pode permitir que match_output dispare em output mais limpo
- ANTES de `stripLines`: dedup reduz volume que strip patterns precisam processar
- ANTES de `headTail`/`maxLines`: cap não pode acontecer sobre output redundante (perderia info)

## ROI quando combinado com filters command-aware

Achado importante das medições:

| Comando | Sem dedup | Com dedup | Ganho marginal |
|---|---|---|---|
| cargo build (com strip + match_output) | 55% | 58% | **+3pp** |
| ps aux (com kthread strip + maxLines) | 93% | 93% | **0pp** |
| Synthetic retry loop (sem filter command-aware) | 0% | 71% | **+71pp** |
| Synthetic progress bar (sem filter command-aware) | 0% | 77% | **+77pp** |

**Conclusão:** dedup é **complementar, não substitutivo**.

- Quando o filter command-aware já strippa noise comum, dedup adiciona pouco.
- Quando NÃO há filter (output de script custom, comando desconhecido), dedup é o **principal motor de compressão** — pode ser 70%+ sozinho.

## Recomendação de design

Para o MVP da v1:

```jsonc
// Default global do filter system
{
  "collapseRuns": true   // sempre on — overhead zero, valor real
}

// Filters individuais opcionalmente:
{
  "name": "my-filter",
  "matchCommand": "...",
  "collapseDigitTemplates": true,  // opt-in
  "dedupGlobal": false              // não usar a não ser que documentado
}
```

**Casos onde `dedupGlobal: true` faz sentido:**
- Filters de "fallback genérico" (catch-all para comandos desconhecidos)
- Filters de scripts customizados pelo user via `~/.claudin/filters.json`

**Casos onde NÃO usar `dedupGlobal`:**
- Logs onde repetição é informativa
- Build tools que mostram progresso real
- Output de testes (cada linha é um test, não duplicata)

## Cycle detection — feature futura (v2)

`collapseRuns` + `dedupGlobal` cobrem 80% dos casos reais. O caso restante é **detecção de ciclo**: quando uma sequência de N linhas se repete K vezes, sem ser exatamente idêntica.

Exemplo:
```
Connecting to 10.0.0.1...
Timeout after 5s.
Retrying (1/3)...
Connecting to 10.0.0.1...
Timeout after 5s.
Retrying (2/3)...
Connecting to 10.0.0.1...
Timeout after 5s.
Retrying (3/3)...
```

Aqui `collapseDigitTemplates` cobre o `Retrying (N/3)` mas as outras 2 linhas só seriam dedupadas por algoritmo de **detecção de período**:

1. Para cada starting position, tentar período K=1,2,3,...
2. Se K linhas se repetem N vezes consecutivamente, colapsar

Implementação ~30 linhas. **Adiar pra v2** — não bloqueia o MVP.

## Comparativo com `toolResultSummarizer` atual

claudin já tem `collapseIdenticalRuns` + `collapseDigitTemplates` em `src/services/tools/toolResultSummarizer.ts:475-533`. Diferenças entre o existente e o proposto:

| Aspecto | Summarizer atual | Filter proposto |
|---|---|---|
| Quando ativa | Threshold 8KB | Sempre (per-filter spec) |
| Granularidade | Bash inteiro | Por filter, opt-in |
| `dedupGlobal` | Não tem | Adicionado |
| Configurável pelo user | Não | Sim (via `~/.claudin/filters.json`) |
| Marker no output | `<tool-result-summary>` | `(×N)` inline ou `[N duplicates...]` footer |

**Não há conflito** — summarizer continua atuando acima do threshold; pré-filter declarativo cobre abaixo.

## Validação atual

35 cases pipeline + 3 safety tests, **100% passing**. Dedup features cobrem 6 desses cases:

```
✓ dedup: connection retry alternating (collapseRuns NÃO funciona)    0%    (pred 0%)
✓ dedup: connection retry alternating (dedupGlobal resolve)         71%    (pred 70%)
✓ dedup: progress bar (collapseDigitTemplates)                      77%    (pred 77%)
✓ dedup: progress bar (collapseRuns NÃO suficiente)                  0%    (pred 0%)
✓ dedup: cargo warnings repetidos (collapseRuns NÃO suficiente)      0%    (pred 0%)
✓ dedup: cargo warning header repetido (dedupGlobal real)           27%    (pred 30%)
✓ cargo build + dedup (real cargo sample)                           58%    (pred 67%)
✓ ps aux + dedup (real ps sample)                                   93%    (pred 95%)
```
