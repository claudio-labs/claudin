# Roadmap — Claudin

Itens priorizados por ROI (ganho / esforço). Atualizado em 2026-06-24.

Convenção: cada item tem **Arquivo**, **Problema**, **Ganho**, **Esforço**, **Risco** e checkbox de status.

---

## Tier 8 — Scout opencode (SST)

> Adicionado em 2026-06-24. Itens portáveis levantados no scout do monorepo `../opencode` (SST). Referência completa com `file:line` em team memory `opencode-sst-feature-gap-reference.md` (refresh round 2). **Tax recorrente:** quase tudo lá é Effect/Layer → de-Effect para o runtime Node simples do Claudin. Separado em **Tools** (capacidade nova que o modelo chama) e **Features** (mecanismo interno).

### Sub-tier 8.T — Tools

#### [~] T8.1 `apply_patch` tool (em progresso — branch `feat/apply-patch-tool`)
- **Problema:** modelos `gpt-*` foram treinados no formato de patch do Codex (`*** Begin Patch / Update File / Add File / Delete File`), mas o Claudin só oferece `FileEditTool`/`FileWriteTool` (string-match), o que aumenta falha de edição em providers OpenAI-compat.
- **Ganho:** alto para usuários OpenAI-compat — patch atômico multi-arquivo (add/update/delete/rename) numa só chamada. **Única tool nova de verdade** do opencode.
- **DECISÃO (2026-06-24):** **sem gating** — tool separada, sempre disponível a qualquer modelo, ao lado de `edit`/`write` (zero impacto neles). Parser/applier portados puros do opencode (`patchFormat.ts`, fuzzy 4-pass + EOF anchor); salvaguardas do Edit/Write reusadas (read-before-edit, encoding, secret-guard, UNC skip, file-history/undo, LSP, atomic re-check + rollback). UI = resumo compacto A/M/D + `/diff`. Cache-safe (descrição estática + `lazySchema`, registro fixo após `Write`).
- **Esforço:** baixo-médio — **Risco:** baixo (tool isolada).
- **Status:** `src/tools/ApplyPatchTool/` implementado; 31 testes de unidade/integração + assert de byte-stability/ordem em `measure-tool-schemas.test.ts`; build+smoke OK. Falta: verificação em sessão real.
- **Fonte:** opencode `tool/apply_patch.ts` + `patch/index.ts`.

#### [ ] T8.2 `invalid` tool (recuperação de args malformados)
- **Problema:** quando o modelo emite argumentos malformados para uma tool, vira erro duro de parse e o turno se perde.
- **Ganho:** médio — registry roteia args inválidos para uma tool no-op que devolve `"arguments invalid: …"` como tool_result **normal**, tornando o turno recuperável. ~20 linhas, copia quase verbatim.
- **Esforço:** baixo — **Risco:** baixo (interno, sem capacidade nova exposta).
- **Fonte:** opencode `tool/invalid.ts` (registrada primeiro nos builtins, `registry.ts:220`).

### Sub-tier 8.F — Features: provider / confiabilidade

#### [ ] T8.3 Single-flight OAuth refresh
- **Problema:** refreshes de token OAuth concorrentes (Codex/Copilot/xAI) podem disparar em paralelo ("refresh stampede"), gastando quota e racing o `.credentials.json`.
- **Ganho:** médio-alto — `refreshPromise` de escopo de módulo deduplica refreshes concorrentes; é Promise puro (não-Effect), porta direto.
- **Esforço:** baixo — **Risco:** baixo.
- **Alvo Claudin:** `src/services/api/codexShim.ts`, `providerConfig.ts` (handling de OAuth token).
- **Fonte:** opencode `plugin/openai/codex.ts:412-468`.

#### [ ] T8.4 Detector de context-overflow (regex)
- **Problema:** classificação de erro de overflow de contexto em providers OpenAI-compat é heterogênea entre fornecedores.
- **Ganho:** médio — 19 padrões regex + heurística `4(00|13)` sem body; drop-in para classificar overflow e acionar compaction.
- **Esforço:** baixo — **Risco:** baixo (tabela pura).
- **Alvo Claudin:** `src/services/api/errorUtils.ts`.
- **Fonte:** opencode `llm/provider-error.ts:4-27`.

#### [ ] T8.5 Taxonomia status→retryable + sniff 429 quota-vs-ratelimit
- **Problema:** nem todo 429 é retryable — `429 + insufficient.quota` não deve fazer retry, mas 429 puro sim; 529 (overload Anthropic) é explicitamente retryable.
- **Ganho:** médio — tabelas de classificação puras + parse de headers de rate-limit dos dois fornecedores; evita retries inúteis em quota esgotada.
- **Esforço:** médio (de-Effect) — **Risco:** baixo.
- **Alvo Claudin:** `src/services/api/withRetry.ts`, `errors.ts`, `errorUtils.ts`.
- **Fonte:** opencode `llm/route/executor.ts:112-275` + `schema/errors.ts:42-158`.

#### [ ] T8.6 Wirar `compactModel` via scoring `small()`
- **Problema:** compactação usa o modelo principal (caro). O opencode tem um scorer de "modelo barato" (custo·0.8 + idade·0.2, ≤18 meses, nome `/nano|flash|lite|mini|haiku|small|fast/`) mas **nunca o liga na compactação**.
- **Ganho:** médio — compactação mais barata; se a gente fizer o wiring, fica **à frente** do opencode (e resolve o item `compactModel` herdado do backlog openclaude).
- **Esforço:** médio — **Risco:** baixo.
- **Fonte:** opencode `core/catalog.ts:244-281` (scorer existe) vs `session/compaction.ts:200` (usa modelo principal).

### Sub-tier 8.P — Features: permissão / segurança

#### [ ] T8.7 `.env` read = `ask` por padrão
- **Problema:** leitura de `*.env`/`*.env.*` não pede confirmação por padrão; risco de vazar segredos para o contexto do modelo.
- **Ganho:** alto/esforço-trivial — ruleset padrão pede `ask` em `*.env`/`*.env.*` e libera `.env.example`.
- **Esforço:** baixo — **Risco:** baixo.
- **Fonte:** opencode `agent/agent.ts:130-135`.

#### [ ] T8.8 Derived subagent permissions
- **Problema:** sub-agents podem herdar permissões amplas e re-spawnar (`task`) ou spammar `todowrite` recursivamente.
- **Ganho:** médio — função pura (~27 linhas): filho herda **só** `external_directory` + regras `deny` do pai, e auto-nega `todowrite`/`task` a menos que o ruleset do sub-agent opte explicitamente.
- **Esforço:** baixo — **Risco:** baixo (função pura portável direto).
- **Fonte:** opencode `agent/subagent-permissions.ts`.

#### [ ] T8.9 Resolução cross-pending de permissão
- **Problema:** com vários pedidos de permissão pendentes, o usuário responde um a um mesmo quando uma resposta "always" já cobriria os outros.
- **Ganho:** médio (UX) — responder "always" resolve todo pendente cujo pattern agora casa; um reject rejeita todos os pendentes da sessão.
- **Esforço:** médio — **Risco:** baixo.
- **Fonte:** opencode `permission/index.ts:140-177`.

#### [ ] T8.10 Bash prefix→arity table para matching de permissão
- **Problema:** patterns de permissão de Bash casam contra a linha inteira (com flags), não contra o "comando humano".
- **Ganho:** médio — tabela de ~150 comandos com aridade (`git checkout`→2, `npm run dev`→3, `docker compose`→3) para casar o comando significativo. Mais limpo que o canonicalizador atual do bash-filter para esse uso.
- **Esforço:** médio — **Risco:** baixo (tabela de dados pura). Avaliar overlap com o canonicalizador de `bash-filters`.
- **Fonte:** opencode `permission/arity.ts:1-161`.

### Sub-tier 8.L — Features: loop / contexto / agente

#### [ ] T8.11 `doom_loop` detector (3 chamadas idênticas)
- **Problema:** o modelo pode travar repetindo a mesma tool com input idêntico — inclusive em loops de **sucesso**, que o guard de tool-failure não pega.
- **Ganho:** médio — se as 3 últimas chamadas forem mesma tool + input byte-idêntico, dispara `ask` "você travou". Complementa o tool-failure-loop-guard (item herdado do openclaude).
- **Esforço:** médio — **Risco:** baixo.
- **Fonte:** opencode `session/processor.ts:522-546` (threshold = 3).

#### [ ] T8.12 Prune-vs-compact em duas camadas
- **Problema:** a única ferramenta de redução de contexto hoje é compaction/summarização; falta um nível intermediário que apague tool-outputs antigos sem resumir.
- **Ganho:** alto em sessão longa — `prune()` protege os 40k tokens recentes, apaga tool-outputs completos antigos quando o "apagável" passa de 20k, e **nunca** toca em outputs de `skill`. Distinto da summarização. Avaliar overlap com clip-frontier/cache-profile já existentes.
- **Esforço:** alto — **Risco:** médio (interage com cache policy e JSONL).
- **Fonte:** opencode `session/compaction.ts:251-297` (`PRUNE_PROTECT`=40k, `PRUNE_MINIMUM`=20k).

#### [ ] T8.13 Resumable subagent via `task_id`
- **Problema:** continuar um sub-agent anterior exige re-spawn do zero (perde histórico).
- **Ganho:** médio — Task tool aceita `task_id` para continuar o histórico completo de um sub-agent anterior; retorna `task_id` para reuso pelo pai. (Claudin já tem SendMessage para continuar agents — avaliar se cobre o caso ou se vale o handle explícito.)
- **Esforço:** alto — **Risco:** médio.
- **Fonte:** opencode `tool/task.ts:121-123`.

### Sub-tier 8.S — Features: skills

#### [ ] T8.14 Remote skill registries
- **Problema:** skills são só locais; não há como puxar skills de um registry compartilhado.
- **Ganho:** médio — `skills.urls` baixa um `index.json` de registry e cacheia os arquivos. (Bônus já presente no Claudin: skills viram `/commands` auto.)
- **Esforço:** médio — **Risco:** baixo.
- **Fonte:** opencode `skill/discovery.ts:48-95`.

---

## Limpeza oportunista

- [ ] **CHICAGO_MCP cleanup duplicado** em `src/query.ts:1060` e `1621` — flag está `false` em `build.ts`; código morto no open build. Unificar ou gate explícito.
- [ ] **`useMemo(() => false, [])`** em `src/screens/REPL.tsx:618` — slot de hook gasto para constante.
- [ ] **gRPC vaporware em docs** — `CLAUDE.md:40-41,90` e `README.md:66` referenciam `src/grpc/`, `src/proto/`, scripts `dev:grpc*` que não existem no código. Limpar ~5 linhas. Registrado em team memory `grpc-vaporware-in-docs.md`.
- [ ] **`FileEditTool` sem teste unitário direto** — único `.test.ts` cobre só LSP diagnostics. Lógica de match / `replace_all` / quote-normalization sem cobertura.

---

## Ordem sugerida de execução

**Tier 8 (scout opencode SST) — ordem por ROI/risco:**

Leva quick-win (🟢, executar junto — todos pequenos e isolados):

1. T8.1 — `apply_patch` + gating `gpt-*` (maior impacto: usuários OpenAI-compat)
2. T8.3 — single-flight OAuth refresh (blinda adapters OAuth mais usados)
3. T8.2 — `invalid` tool (rede de segurança contra args malformados)
4. T8.4 — detector de context-overflow (drop-in `errorUtils.ts`)
5. T8.7 — `.env` = `ask` por padrão (segurança trivial)
6. T8.8 — derived subagent permissions (função pura)

Segunda leva (🟡, esforço médio):

7. T8.5 — taxonomia 429 quota-vs-ratelimit
8. T8.6 — wirar `compactModel` via `small()` (fica à frente do opencode)
9. T8.11 — `doom_loop` detector
10. T8.9 — resolução cross-pending de permissão
11. T8.10 — bash prefix→arity table (medir overlap com bash-filter antes)
12. T8.14 — remote skill registries

Terceira leva (🔴, maior/bloqueado por avaliação):

13. T8.12 — prune-vs-compact (avaliar overlap com clip-frontier/cache-profile primeiro)
14. T8.13 — resumable subagent via `task_id` (checar se SendMessage já cobre)
