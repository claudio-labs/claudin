# Structured Extraction — taxonomia fechada + skip-routine + tool_choice

> **Fonte:** `claude-mem` repo, `plugin/modes/code.json`, `src/sdk/parser.ts`, `src/services/worker/agents/ResponseProcessor.ts`, `src/server/generation/providers/ClaudeObservationProvider.ts`.
> **Verificado contra o repo em 2026-05-19** — ver "Correções pós-verificação".

## Contexto

Esta página combina três técnicas relacionadas. O ganho de tokens é **indireto**: extração mais limpa e melhor classificada → menos memórias ruidosas → menos contexto carregado em toda sessão futura.

**Descoberta importante:** o `claude-mem` define um *contract* de saída forte, mas o implementa do jeito errado — XML em texto livre + regex parser, **sem** `tool_choice`/structured output. O próprio código admite (`src/sdk/parser.ts:5`, `TODO(#2233)`) que tool-use API seria melhor — chama o XML de "bridge". O Claudio deve copiar o *contract* e descartar o *mecanismo*.

## Técnica 1 — Taxonomia fechada (copiar)

`plugin/modes/code.json` define enums fechados para classificar cada observação:

- **`type`** — `observation_types` (`code.json:5-62`) tem **8 valores**: `bugfix, feature, refactor, change, discovery, decision, security_alert, security_note`.
  - **Inconsistência real no claude-mem:** o array de dados tem 8, mas `type_guidance` (`code.json:106`) diz ao LLM "MUST be EXACTLY one of these **6** options" e omite `security_alert`/`security_note`. O parser valida contra os 8 (`parser.ts:106`), então um type de segurança seria aceito — mas o modelo nunca é instruído que pode emiti-lo. Parece um prompt não atualizado quando os types de segurança foram adicionados. **Lição para o Claudio:** enum e prompt-guidance devem ser single-sourced para não divergir.
- **`concepts`** — `observation_concepts` (`code.json:63-99`) tem **7 valores**: `how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off`.
- Campos com limites (advisory, **não enforçados**): `subtitle` ≤ 24 palavras (`code.json:114`), `facts[]`, `narrative`, `files_read[]`, `files_modified[]`. O parser não conta nem valida nada além do enum de `type`.

**Estado no Claudio:** memórias já têm `type` (`user | feedback | project | reference`) — mas esse é o eixo de **escopo/audiência**, não de **natureza do conhecimento**. Falta o eixo `concept`.

**Proposta:** adicionar campo `concept` opcional ao frontmatter de memória, enum fechado adaptado: `{ gotcha, pattern, trade-off, how-it-works, why-it-exists, decision }`. Ganho: filtro fino no recall (ver [`progressive-memory-recall.md`](progressive-memory-recall.md)) — buscar "todos os gotchas de provider" sem ler tudo.

## Técnica 2 — Skip-routine guidance (copiar, custo zero)

`code.json:105` instrui o agente observador a **retornar resposta vazia** para trabalho de rotina: status checks, npm installs sem erro, listings vazios, file searches sem follow-up.

Em vez de *comprimir* lixo, **descarta** lixo na origem. Memória só para o não-óbvio.

**Detalhe de implementação — skip é dual-channel:**

1. Tag explícita `<skip_summary reason="..."/>` — `parser.ts:48-64` aceita como `valid: true` + `skipped: true`.
2. Resposta vazia / não-XML — `parser.ts:42-44` → `valid: false` → descartada em `ResponseProcessor.ts:37`.

O prompt (`code.json:105`) manda "return an empty response only" — ou seja, roteia o skip de rotina pelo path *inválido*, que é silenciosamente ack-ado. O provider ainda sintetiza `<skip_summary reason="all_events_private"/>` quando o privacy-stripping esvazia o batch (`ClaudeObservationProvider.ts:61`) para não cobrar a API.

**Proposta:** adicionar uma seção "skip guidance" ao prompt do `src/services/extractMemories/`. ~10 linhas. Instruir explicitamente: não extrair memória de tarefas de rotina, comandos triviais bem-sucedidos, navegação exploratória sem conclusão. Custo zero, ganho imediato em ruído.

## Técnica 3 — Output estruturado de verdade (fazer melhor que o claude-mem)

O `claude-mem` faz XML-em-texto porque nasceu antes da tool-use API estável. O Claudio **não tem essa dívida** — `src/services/api/` já abstrai providers (`openaiShim`, `codexShim`) e todos suportam tool calling ou `response_format`.

**Proposta:** o `extractMemories` deve usar saída estruturada nativa:

- Providers Anthropic/OpenAI-compat: `tool_choice` forçando uma tool `record_memory` com input schema zod
- Fallback (provider sem tool calling): `response_format: json_schema` ou, em último caso, prompt + parse zod
- Parse e validação via zod na saída — não regex

Isso é **literalmente o TODO do `claude-mem`** (`parser.ts:5`, `TODO(#2233)`). O Claudio pode entregar certo desde o início.

**Nota:** no claude-mem, zod existe (`src/core/schemas/`, ~21 arquivos) mas só valida payloads HTTP/storage — `MemoryItemSchema.type` é `z.string()`, **não** enum. Nenhum schema zod toca a saída do LLM. O enum fechado vive só como dados em `code.json` + validação no parser regex.

## Técnica 4 — Política de falha (copiar)

Há duas camadas, em arquivos diferentes:

- **Parse fail total → discard + ack, NO retry** (`ResponseProcessor.ts:37-47`). O comentário no código explica: re-enfileirar uma resposta de baixo sinal cria loop que queima quota até o restart guard disparar. Descartar-com-ack troca uma observação possivelmente perdida por segurança contra loop.
- **Field-level fail (ex: enum inválido) → fallback ao primeiro valor do enum (`bugfix`) + `logger.error`** (`parser.ts:108-117`). A observação ainda é gravada — preserva sinal em vez de jogar fora o evento inteiro.

```ts
// claude-mem ResponseProcessor.ts:37-47 (parafraseado)
if (!parsed.valid) {
  logger.warn('PARSER', 'non-XML/empty response — ignoring queued batch')
  await sessionManager.confirmClaimedMessages(session.sessionDbId) // ack
  return // sem re-queue
}
```

**Trick relacionado — dedup de concept** (`parser.ts:119`): `cleanedConcepts = concepts.filter(c => c !== finalType)`. O sistema antecipa o LLM confundir os eixos ortogonais "type" e "concept" e remove silenciosamente o overlap.

**Proposta:** o `extractMemories` do Claudio deve seguir o mesmo princípio:

- Saída inválida → loga via `logError`, **não** re-tenta a extração, segue a sessão (a memória daquele turno simplesmente não é gravada)
- Enum/campo individual inválido → fallback ao default do schema zod + `logError`, grava o resto

Alinha com a regra do projeto "fallback pattern — nunca bloquear o usuário" (`typescript-patterns.md`).

## Resumo do que copiar

| Técnica | Esforço | Risco | Onde mexer |
|---|---|---|---|
| Skip-routine no prompt | ~10 linhas | Nenhum | `src/services/extractMemories/` (prompt) |
| Campo `concept` enum | schema bump | Baixo (retroativo via regex) | frontmatter de memória + extractor |
| `tool_choice` estruturado | ~80 linhas | Médio (testar cada provider) | `src/services/extractMemories/` + `test:provider` |
| Política discard+ack | ~15 linhas | Nenhum | `src/services/extractMemories/` (error path) |

## Antipadrão — NÃO copiar

- XML-em-texto + regex parser (`src/sdk/parser.ts`). É a dívida que o próprio `claude-mem` quer pagar (`TODO(#2233)`).
- `tools`/`tool_choice` ausentes no request do observer (`ClaudeObservationProvider.ts:76-81`).
- Enum dessincronizado entre dados e prompt-guidance (8 types nos dados, "6" no guidance).

## Correções pós-verificação (2026-05-19)

| Claim original | Status | Correção |
|---|---|---|
| `type` enum de 6 valores | ❌ | **8 valores** — adiciona `security_alert`, `security_note` (`code.json:49,56`). O guidance ainda diz "6" — inconsistência real |
| `title` ≤ 24 palavras, `subtitle` 1 frase | ❌ | Invertido: o cap "≤24 palavras" é do **`subtitle`** (`code.json:114`); `title` não tem limite de palavras |
| `concepts` enum de 7 | ✓ | Confirmado |
| field-level fallback em `ResponseProcessor.ts:35-47` | ⚠️ | Fallback de campo é em **`parser.ts:108-117`**. `ResponseProcessor.ts:37-47` é só o discard total |
| skip guidance `code.json:105`, "bridge" `parser.ts:5` | ✓ | Confirmados |
| zod só em HTTP payloads | ✓ | Confirmado — `MemoryItemSchema.type` é `z.string()`, não enum |

## Arquivos de referência (claude-mem)

| Tema | Arquivo:linha |
|---|---|
| Taxonomia + skip guidance | `plugin/modes/code.json:5-99` (skip :105, type guidance :106, subtitle cap :114) |
| Parser XML + TODO de schema | `src/sdk/parser.ts:5, 41-151` (concept dedup :119) |
| Política discard total | `src/services/worker/agents/ResponseProcessor.ts:37-47` |
| Fallback de campo | `src/sdk/parser.ts:108-117` |
| Provider sem tool_choice | `src/server/generation/providers/ClaudeObservationProvider.ts:76-81` |
| Schema zod persistido | `src/core/schemas/memory-item.ts:8-26` |
