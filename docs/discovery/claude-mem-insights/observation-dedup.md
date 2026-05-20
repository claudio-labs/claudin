# Observation Dedup — content-hash + UNIQUE constraint

> **Fonte:** `claude-mem` repo, `src/services/sqlite/observations/store.ts`, `src/services/sqlite/schema.sql`.
> **Verificado contra o repo em 2026-05-19.** O rascunho anterior (`dedup-window.md`) afirmava uma "janela de 30s" e funções `collapseRuns`/`collapseDigitTemplates`/`dedupGlobal` — **nada disso existe no claude-mem**. Ver "Correções pós-verificação".

## O que o claude-mem REALMENTE faz

Dedup de observações é **por hash de conteúdo + constraint UNIQUE do SQLite**. Não há janela de tempo, não há matching fuzzy.

**Hash** — `computeObservationContentHash()` (`store.ts:8-17`):

```
content_hash = SHA256(memorySessionId + '\x00' + title + '\x00' + narrative)  → hex, 16 chars
```

**Insert** — `storeObservation()` (`store.ts:19-80`):

```sql
INSERT INTO observations (...) ON CONFLICT(memory_session_id, content_hash) DO NOTHING
```

Em conflito, re-seleciona a linha existente (`store.ts:68-70`) e devolve o id dela. **Nenhuma comparação de timestamp** no path de dedup — `created_at_epoch` é gravado mas nunca consultado para dedup.

O header do schema (`schema.sql:16-17,54`) chama explicitamente a janela de tempo de **"legacy dedup window"** que foi **substituída** pela constraint UNIQUE. O teste `tests/sqlite/data-integrity.test.ts:87-96` insere observações idênticas a 31s de distância e prova que ainda colapsam — ou seja, a janela de 30s não existe mais.

## Insights

1. **Separador NUL no hash** (`store.ts:14`): junta `[memorySessionId, title, narrative]` com `\x00` em vez de concatenar direto. Previne colisão de fronteira (`("ab","c")` vs `("a","bc")`). Tem teste dedicado (`data-integrity.test.ts:62-73`).
2. **Dedup é intra-sessão, não global.** A chave UNIQUE inclui `memory_session_id`, e esse id muda a cada restart do worker. A *mesma* observação produzida em dois lifetimes diferentes do worker hasheia diferente e **não** dedupa entre restarts.
3. **Só conteúdo byte-idêntico colapsa.** É SHA256 exato — qualquer diferença de caractere em title/narrative gera hash diferente. **Não há matching de similaridade/fuzzy.** Observações quase-idênticas (típicas de loop de tentativa-erro) **não** colapsam no claude-mem.
4. **Fail-loud em inconsistência:** se `ON CONFLICT` dispara mas o re-select não acha a linha, o código lança erro (`store.ts:72-76`) em vez de devolver id bogus.
5. **Dedup de IDs numa camada acima:** `ResponseProcessor.ts:177` dedupa *IDs* de observação antes de sync/broadcast, justamente porque o dedup no DB pode produzir menos linhas que inputs.

## Por que o ganho de tokens aqui é modesto

O dedup do claude-mem é exact-content — só evita gravar duas vezes a *exata mesma* observação dentro de uma sessão. Isso é mais uma feature de **correção/storage** do que de economia de tokens. O caso que mais infla memória — loop de debug gerando N observações *parecidas mas não idênticas* — o claude-mem **não** resolve.

→ Tier baixo. Mas há um espaço de melhoria que o Claudio poderia ocupar **indo além do claude-mem**: dedup fuzzy.

## Aplicabilidade no Claudio

O `extractMemories` do Claudio roda por turno/sessão. Em sessões de debug iterativo pode produzir memórias `project` redundantes que inflam o `MEMORY.md` — e índice maior = mais custo no boot de toda sessão futura (ver [`tiered-memory-rendering.md`](tiered-memory-rendering.md) e [`progressive-memory-recall.md`](progressive-memory-recall.md)).

**Proposta — dois níveis:**

### Nível A — dedup exato (copiar do claude-mem, barato)

Antes de gravar uma memória nova, computar `SHA256(type + '\x00' + title + '\x00' + body)` e checar contra as memórias existentes do projeto. Hash igual → não grava. Custo trivial, pega o caso de re-extração idêntica.

### Nível B — dedup fuzzy (ir além do claude-mem)

O claude-mem **não tem isto** e é onde o ganho real está. Antes de gravar:

- Comparar `title`/`description` da memória nova com as gravadas na mesma sessão por similaridade textual barata (Jaccard de tokens do título, ou prefixo comum)
- Similaridade alta → **atualizar a memória existente** (mesclar facts, atualizar timestamp) em vez de criar nova
- Escopo: mesma sessão + mesma subárvore de arquivos é sinal mais forte que tempo de relógio

## Sobre o "Nível 2" do rascunho anterior (colapso de linhas de log)

O rascunho citava `collapseRuns`/`collapseDigitTemplates`/`dedupGlobal` como sendo do claude-mem. **Eles não existem no claude-mem** (busca exaustiva no repo: zero matches). Esses nomes pertencem ao discovery do **próprio Claudio** — `docs/discovery/bash-output-filter/`, que já especifica colapso de linhas para output de shell.

→ **Nada a portar nesse nível.** O `BashOutputFilter` do Claudio já cobre colapso de linhas de log; não é uma técnica do claude-mem. Registrar só como nota: o claude-mem **não** faz compressão de log por colapso de linhas.

## Decisões abertas

1. **Nível A já vale sozinho?** Sim — barato e correto. Implementar junto com `structured-extraction`.
2. **Nível B: colapsar ou substituir?** Recomendação: atualizar a existente, descartar a nova.
3. **Métrica de similaridade do Nível B** — Jaccard de tokens do título é suficiente? Ou comparar `files_modified`?
4. **Incluir `memorySessionId` no hash?** O claude-mem inclui (dedup intra-sessão). Para o Claudio, memória é persistente entre sessões — **não** incluir session id, senão re-extração idêntica em outra sessão não dedupa.

## Correções pós-verificação (2026-05-19)

| Claim original | Status | Correção |
|---|---|---|
| Janela de dedup de 30s | ❌ | Não existe. Dedup é `SHA256` de conteúdo + UNIQUE `(memory_session_id, content_hash)` |
| "observações quase-idênticas colapsam" | ❌ | Só byte-idênticas colapsam. Sem fuzzy/similaridade |
| `architecture-overview.md:103` documenta os 30s | ⚠️ | O doc deles tem a linha, mas é **stale** — o próprio schema chama a janela de "legacy/replaced" |
| `collapseRuns`/`collapseDigitTemplates`/`dedupGlobal` são do claude-mem | ❌ | Não existem no claude-mem. São do discovery `bash-output-filter/` do próprio Claudio |

## Arquivos de referência (claude-mem)

| Tema | Arquivo:linha |
|---|---|
| Hash de conteúdo | `src/services/sqlite/observations/store.ts:8-17` |
| Insert com ON CONFLICT | `src/services/sqlite/observations/store.ts:40` |
| Invariante de schema | `src/services/sqlite/schema.sql:16-17,54` |
| Teste (independência de tempo) | `tests/sqlite/data-integrity.test.ts:87-96` |
