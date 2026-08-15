# 09 — Validação cética do roadmap "LSP-first agent"

**Data:** 2026-05-27
**Repo:** `main @ c541013`
**Escopo:** desafiar os 5 eixos do roadmap. Postura default = "isso não vai funcionar". O roadmap precisa se provar.
**Memórias aplicáveis:** `no-overclaim-performance`, `plan-elegance-checkpoint`, `verify-privacy-bundle-only`, `discovery-workflow`, `t5.5-add-import-rejected`.

---

## 1. Veredito por eixo

| Eixo | Tema | Veredito | Risco principal |
|------|------|----------|-----------------|
| 1 | Prompt tuning Explore/Plan/main + tool descriptions LSP-first | **YELLOW** | Efeito não-mensurável; prompt bloat; baseline já tem LSPTool exposto |
| 2 | `/review` orquestrado com risk score | **YELLOW** | Mesmo padrão de overclaim do `02§9` do CRG; risk score com pesos arbitrários não-calibrados; lento em monorepos |
| 3 | Wiki auto-gerada | **RED** | Output ruidoso em monorepo TS grande; LLM-summarizer-per-module é caro e duplica `claude-code-guide`; `init.ts:6-37` ser vazio não é dor, é design |
| 4 | Cache LSP in-memory por sessão | **GREEN** (condicional) | Único com mecanismo verificável e self-contained; só se Eixo 1 não anular benefício |
| 5 | Índice persistente cross-sessão | **DEFER (correto)** | Roadmap já adia; manter adiado |

---

## 2. Crítica eixo-a-eixo

### Eixo 1 — Disciplina de uso (prompt tuning + tool descriptions)

**a) Ganho claimado.** Aumentar a taxa de chamadas `LSPTool` vs `GrepTool` para queries do tipo "quem chama X / onde é definido Y", e reduzir Read em N arquivos. Concretamente: tornar `LSPTool` o **default mental** do agente para perguntas de símbolo.

**b) Baseline é straw-man?** **Sim, parcialmente.** O baseline real do Claudin já é:
- `LSPTool` 13 ops registrado e descrito em `src/tools/LSPTool/prompt.ts:1-14` (`04 §1`, `05 §1.1`).
- 12 servers embarcados auto-instaláveis (`src/platform/lsp/builtinServers.ts:461-609`, `05 §1.1`).
- `GrepTool` com `output_mode="symbols"` cobre TS/JS/Py/Go (`src/tools/GrepTool/GrepTool.ts:408-419`, `06`).
- Read `view='outline'` para esqueleto de arquivo (`06`).

Um usuário "atento" do Claudin que sabe que LSPTool existe já chama `findReferences`/`incomingCalls` quando convém. O que o roadmap propõe é mudar o **prior probabilístico** do modelo. Esse efeito é difuso, sem mecanismo direto de medição; é exatamente o tipo de claim contra o qual `02 §9` arma contra o CRG ("38×-528× sem CSV que sustente"). Aqui o equivalente seria "LSP-first prompt aumenta X% as chamadas LSP" — sem A/B controlado, é fé.

**c) Medição mínima.** A/B controlado de 1-2 semanas comparando log de tool-calls em sessões reais (não synthetic). Métrica: ratio `LSP-symbol-ops / (LSP-symbol-ops + Grep-symbol-queries + Read-on-symbol-target)`. Hipótese: tem que subir ≥15 pontos percentuais sem aumentar `total-tokens-per-task` em >5%. Sem essa medida, o eixo é prompt-engineering de fé.

**d) Custos escondidos.**
- **Prompt bloat.** `src/agent/systemPrompt.ts:41-119` + `src/agent/prompts/prompts.ts:230-275` (`08 §1`) já é grande. Adicionar tabela "Tool | Use when" + bloco "use LSP first, fallback to Grep only if Z" mexe no system prompt **de toda** invocação do agente principal e dos Explore/Plan. Inflate de ~200-400 tokens × N turnos × N sessões.
- **Latência cold-start LSP.** `typescript-language-server` em repo grande leva segundos para indexar antes de responder. Em `Grep` o usuário paga ~80ms; o nudge "prefira LSP" pode trocar 80ms por 3-8s no primeiro símbolo. Roadmap não menciona.
- **Servidor LSP indisponível.** Em um repo poliglota onde só TS tem server rodando, o agente nudgeado tenta LSP, falha, cai pra Grep — mas perdeu 1 tool call no caminho. Sem detecção up-front, custo é negativo.
- **Manutenção.** Mais um lugar para sincronizar quando a lista de tools muda (já há `embeddedTools.ts` branch em `exploreAgent.ts:16-22`).

**e) Failure modes.**
- Usuário Rust + TS: `rust-analyzer` instala automático mas pode demorar minutos no primeiro warmup → nudge LSP faz a primeira pergunta travar.
- Repo Bash-pesado (scripts/ no Claudin): LSP não cobre, agente tenta, erra, cai pra Grep. Custo extra.
- Nudge "ALWAYS use LSP BEFORE Grep" copiado literal do tom CRG (`07 §Eixo 1` adverte contra isso): se o LSP server estiver derrubado o agente fica em loop "LSP não retornou, vou tentar de novo".

**f) Alternativa menor (60-80% do valor / 20% do custo).** Adicionar **uma única frase** nas descriptions de `LSPTool` e `GrepTool` (`src/tools/LSPTool/prompt.ts`, `src/tools/GrepTool/prompt.ts`) — "for symbol navigation prefer this/that" — sem mexer em Explore/Plan/main agents. Isso testa o nudge no menor canal possível antes de inflar 3 system prompts.

---

### Eixo 2 — `/review` orquestrado com risk score

**a) Ganho claimado.** Substituir o prompt naive de `src/commands/review.ts:9-31` (que só faz `gh pr diff` → LLM) por: parse hunks → para cada símbolo modificado chama `LSPTool.findReferences`/`incomingCalls` → calcula risk score → injeta tabela no prompt + modo `--minimal`.

**b) Baseline é straw-man?** **Em parte sim.** O baseline atual de `review.ts` é genuinamente primitivo (`05 §4.1`, `06 Gap 1`). Mas um usuário atento, vendo um PR de 3 arquivos pequenos, **lê o diff** — não precisa de risk score. O risk score só agrega quando o PR é grande (>10 arquivos) e cross-package. Esse perfil é minoritário em PRs reais do próprio Claudin (`git log --oneline` mostra commits pequenos).

**c) Medição mínima.** Pegar 10 PRs reais já mergeados (5 pequenos ≤3 arquivos, 5 médios/grandes ≥10 arquivos). Rodar `/review` velho e `/review` novo. Métricas:
- **Bugs/observações genuínas** encontradas (revisão humana cega de qual veio de qual).
- **Tokens consumidos** (LSP queries não são grátis).
- **Latência total** do comando.

Critério de ship: nos PRs grandes, novo `/review` precisa achar ≥1 issue extra que o velho não acha, sem inflar tokens >2×. Nos pequenos, **não pode regredir** (mesma qualidade, ≤1.5× tokens).

**d) Custos escondidos.**
- **N×M chamadas LSP.** Um PR com 30 símbolos modificados → 30 `findReferences`. Cada um custa round-trip ao server. Em repo grande, `findReferences` em símbolo hub (ex: `tryGetActiveProvider` chamado em 80 lugares) volta payload pesado — vai inflar o prompt mais que o diff inteiro inflaria. Mesmo modo de falha do CRG `get_review_context(default)` documentado em `02 §9` (graph_tokens >> naive_tokens em PRs pequenos).
- **Risk score com pesos arbitrários.** `07 Eixo 2` propõe `tests 0.30 + security 0.20 + callers 0.10 + hunk_size 0.20 + cross_package 0.20`. Calibração? Nenhuma. `02 §8` aponta exatamente isso como ponto frágil do CRG: "risk score é aditivo, não calibrado". Replicar o erro.
- **`SECURITY_KEYWORDS` falsos positivos.** `07 Eixo 2` já flag que `query/request/http/execute` produz false positives gigantes; mesmo com o filtro proposto, qualquer função `validateInput` vira "security-sensitive".
- **Detecção de testes heurística.** `02 §8` cita CRG: "falsos negativos prováveis em projetos com convenção atípica". Claudin usa `*.test.ts` colocated (regra `testing.md`), o que ajuda — mas test gap detection é frágil mesmo assim.
- **`gh pr diff` parser.** Parser de hunks robusto não é trivial; bordas: renames, binary, diff truncado. Mais código para manter.

**e) Failure modes.**
- PR que toca tipos exportados (`src/tools/Tool.ts`): `findReferences` numa interface central retorna centenas. Tabela injetada estoura janela.
- PR só de docs/markdown: zero símbolos, risk score = 0 em tudo, ferramenta degenera para o caminho velho.
- LSP server crasha no meio do score → metade dos símbolos sem callers → score enviesado pra baixo → "GO" indevido.
- **Concorrência LSP**: hoje cada `LSPTool` call é serial. Disparar 30 em sequência num `/review` é lento (talvez 30-60s de overhead só de orquestração). Paralelizar exige cuidado com o protocolo LSP (1 server, requests concorrentes).

**f) Alternativa menor.** **Split 2a/2b.**
- **2a (ship primeiro):** parser de hunks + injeção de tabela "arquivos por hunk size + arquivos cujo path bate `SECURITY_KEYWORDS`" — zero LSP. Captura 50% do valor (estrutura) com 10% do código. Validável em 2 dias.
- **2b (gated):** adicionar `LSPTool.findReferences` por símbolo modificado, **com cap rígido** (ex: top-10 símbolos por hunk size) e `--full` opt-in. Score com 2 dimensões só (callers, test gap), não 5.

Outro alternative menor: **bloco de prompt** que **instrui** a LLM a, durante o review, chamar `LSPTool.findReferences` ela mesma para os 3 símbolos mais centrais. Empurra a decisão pro modelo, sem código novo de orquestração. Custo = ~30 linhas de prompt.

---

### Eixo 3 — Wiki auto-gerada

**a) Ganho claimado.** Substituir `src/platform/wiki/init.ts:6-37` (template vazio com placeholders) por geração automática: walk dirs → Read `view='outline'` → import graph regex → LLM summarizer per module.

**b) Baseline é straw-man?** **Sim, fortemente.** A premissa "template vazio = dor" não foi validada. `init.ts` produz `index.md`, `log.md`, `pages/architecture.md` e `wiki-schema.md` — um **scaffold deliberado** para o usuário preencher. É um sistema de notas append-only, não um gerador de doc. Comparar com `claude-code-guide` agent (mencionado em `06 §6`) que já fala do produto, e com `docs/` humano (que `05 §veredito` cita como melhor que qualquer wiki autogen).

**c) Medição mínima.** Rodar o gerador no próprio Claudin (200+ TS files). Checar:
- Quantos módulos gerados? (suspeita: 50-100, ruído).
- Soma de tokens das páginas vs `CLAUDE.md` atual escrito à mão.
- Um humano (o maintainer) lê 10 páginas geradas — quantas adiciona conhecimento que não está em `CLAUDE.md` + `docs/`? Critério de ship: ≥4/10. Suspeita: ≤1/10.

**d) Custos escondidos.**
- **Custo de LLM por módulo.** "LLM summarizer per module" em repo de 200 arquivos = 200 chamadas. Por sessão? Por commit? Não definido. Se for `/wiki regen`, custo de uma rodada é alto e cresce com repo.
- **Determinismo zero.** Cada regen produz markdown diferente (LLM stochastic). Diff em git fica ruído. Hoje a wiki é editável e estável.
- **Drift.** Quem mantém? Hoje a wiki é "usuário escreve quando lembra". Auto-wiki cria expectativa de freshness — mas regen automático é custo recorrente que ninguém quer.
- **Sobreposição com `claude-code-guide` + `docs/` humano.** `05 §veredito` é explícito: "docs/ humano já existe e é melhor".
- **Import graph regex.** Regex sobre `import` é frágil em TS: dynamic imports, re-exports, path aliases (`src/*`), barrel files. Vai produzir grafo errado em ~10-20% dos arquivos do próprio Claudin.

**e) Failure modes.**
- Monorepo poliglota (Rust+TS): import graph regex só funciona em uma das linguagens; output omite metade.
- Auto-wiki gera página para `src/native-ts/yoga-layout/*` (TS port) — humano sabe que é "TS port de Yoga, não mexer"; LLM faz uma página descrevendo APIs que ninguém deve usar.
- Usuário leva 5 minutos esperando geração, abre, lê superficial, fecha — nunca mais usa. Single-shot "wow" sem retenção.
- Git diff de regen polui PRs futuros.

**f) Alternativa menor.** Substituir `init.ts` por um template **um pouco mais rico**: gerar `pages/<top-level-dir>.md` por entrada de `src/` (ex: `tools.md`, `services.md`, `commands.md`) com apenas o **outline regex** dos arquivos (sem LLM). Zero token cost, deterministico, útil como índice. ~50 linhas de TS. Se isso for usado por 4 semanas, então pensar em LLM summarizer.

---

### Eixo 4 — Cache LSP in-memory por sessão

**a) Ganho claimado.** Memoizar `documentSymbol`/`findReferences` por `(path, content-hash)`. Invalidar em `FileEdit`/`FileWrite`. Reduzir latência e duplicação de queries LSP dentro de uma sessão.

**b) Baseline é straw-man?** **Não.** Hoje toda chamada `LSPTool.findReferences` vai ao server, mesmo sendo a 3ª vez no mesmo arquivo na mesma sessão. Mecanismo de ganho é direto e mensurável: cache hit = zero tool latency, zero token de payload duplicado.

**c) Medição mínima.** Instrumentar `src/tools/LSPTool/LSPTool.ts`: contar hits/misses por sessão durante 1 semana de uso pessoal. Critério ship: hit rate ≥30% em sessões >10 turnos. Abaixo disso, ganho não justifica complexidade.

**d) Custos escondidos.**
- **Memory pressure.** `findReferences` em símbolo hub pode retornar 100s de locations. Memoizar 50 desses = MB de heap residente por sessão longa.
- **Invalidação correta.** Edit em `a.ts` não invalida só cache de `a.ts` — invalida qualquer cache de símbolos **definidos em outros arquivos** que referenciam `a.ts`. Roadmap diz "invalidate on FileEdit/FileWrite write" — isso é insuficiente; precisa invalidar reverse-deps. Implementar errado = stale results = pior que sem cache (bug silencioso vs lentidão visível).
- **Hash content vs file mtime.** Content-hash exige ler+hash o arquivo antes de cada lookup. Para `findReferences` em 30 arquivos isso é 30 reads. Pode anular o ganho. mtime+size é mais barato mas frágil.
- **Concorrência.** Se houver paralelismo (`Promise.all` de LSP queries), cache precisa de mutex/locking ou aceitar double-fetch no race.
- **Interage com Eixo 1.** Se Eixo 1 funcionar (mais chamadas LSP), Eixo 4 fica mais valioso. Se Eixo 1 NÃO funcionar (chamadas LSP permanecem raras), o hit rate fica baixo e Eixo 4 é trabalho desperdiçado. Ver §3.

**e) Failure modes.**
- Invalidation bug: usuário edita arquivo, cache retorna referências antigas, agente sugere fix baseado em info stale. Difícil de debugar.
- Cache cresce sem cota → sessão de 4h consome GB.
- Edit externo (usuário no editor) não dispara nenhum hook do Claudin → cache nunca invalida.

**f) Alternativa menor.** Memoizar **só `documentSymbol`** (mais cacheável, payload menor, invalidação simples = só o arquivo editado). Skip `findReferences` no cache até medir. Captura 60% do valor com 20% do código e elimina o problema de reverse-deps.

---

### Eixo 5 — Índice persistente cross-sessão

**a) Ganho claimado.** Não definido — adiado até 2+3 provarem valor.

**b/c/d/e/f)** Roadmap já trata como DEFER. Sustentar. `08 §Eixo 5` e `06 Gap 3` já alertam:
- SQLite no bundle quebra "single-file `dist/cli.mjs`" (`CLAUDE.md` Architecture).
- `~/.claudin/<repo>/index.db` fica fora do `verify:privacy` (memória `verify-privacy-bundle-only`).
- Só justifica em monorepos enormes (`04 §5`) — fora do perfil dominante do Claudin.

**Veredito:** manter DEFER. Inclusive: condicionar a 2 **e** 3 mostrarem valor **medido em sessões reais**, não em demo.

---

## 3. Interações cross-axis

- **Eixo 1 anula parcialmente Eixo 4?** Sim, parcialmente. Se Eixo 1 nudge o agente a usar LSP mais vezes (em vez de Read+Grep), o cache do Eixo 4 amortiza essas chamadas extras. **Mas** se Eixo 1 funciona pelo lado oposto — agente pergunta menos coisas redundantes porque o LSP entrega a resposta em 1 shot — o hit rate do Eixo 4 cai. Não dá pra prever sem dados. **Recomendação:** medir Eixo 1 primeiro (1 semana de A/B), aí decidir Eixo 4.

- **Eixo 2 sem Eixo 1.** Pior cenário: `/review` orquestrado **força** muitas chamadas LSP server-side num agente ainda mal nudgeado para LSP. Resultado: o `/review` fica caro/lento, e quando o usuário sai dele e volta ao Explore o agente ainda faz Grep+Read pesado. Pior trade: melhora 1 comando e empiora a média. **Recomendação:** Eixo 1 antes do Eixo 2, ou pelo menos em paralelo.

- **Eixo 3 contamina Eixo 2.** Se a wiki autogen entra antes do `/review` melhorado, o `/review` velho tem mais "conteúdo de wiki" para indexar/citar, e o sinal de melhoria do Eixo 2 fica mascarado. Inverso: Eixo 2 primeiro, Eixo 3 nunca (suspeita).

- **Sequencing risk:** o eixo que mais pode envenenar UX se vier primeiro é o **Eixo 3 (wiki)** — gera artefato visível (pasta `.claudin/wiki/` cheia de markdown gerado por LLM), que se for ruim destrói confiança do usuário no comando `/wiki`. Eixo 4 (cache) é o menos arriscado: invisível, falha silenciosa se buggy mas reversível por flag.

---

## 4. Cenários céticos

### 4.1 PR de 3 arquivos com novo `/review`
Provável: tabela de risk score injeta 200-400 tokens, mas como são 3 arquivos pequenos a LLM já lia todos. **Valor agregado próximo de zero.** Pior: tempo do review aumenta 5-15s (LSP queries). Casa com o cenário CRG do `02 §9`: graph_tokens > naive_tokens em PRs pequenos.

### 4.2 `/wiki` no próprio Claudin (200+ TS files)
Provável: gera 100-150 páginas. Maioria descreve módulos triviais (`src/shared/fs/path.ts`, `src/shared/envUtils.ts`). Top-10 páginas (`QueryEngine`, `openaiShim`, `Tool`, `providerConfig`, `LSPTool`) duplica conteúdo já em `CLAUDE.md` + `.claudin/rules/search-strategy.md`. Output: **ruidoso**. Maintainer abre 2-3 páginas, fecha, deleta a pasta.

### 4.3 Repo polyglot Rust+TS
Eixo 1: `rust-analyzer` cold-start lento (`builtinServers.ts:461-609` lista mas warmup é caro) → nudge LSP-first faz primeira query Rust travar. Eixo 2: risk score só usa LSP no que tem server rodando — se Rust LSP não estiver up, o subgraph Rust fica com risk=0 falso (sem callers detectados). Eixo 3: regex import scanner só pega TS (regra `import` JS); módulos Rust ficam fora ou geram placeholders. Eixo 4: cache funciona em ambas, neutro. **Gains são TS-heavy.**

### 4.4 Novo contribuidor + "show me README"
Agente nudgeado "LSP first" recebe "show me README". Risco baixo de regressão se o nudge for bem escrito ("for **symbol** queries, prefer LSP") — mas o `07 Eixo 1` documenta tom CRG "ALWAYS use X BEFORE Y" que é fácil de copiar agressivo. Se vier copiado literal, agente tenta `LSPTool.workspaceSymbol("README")` antes de `Read README.md`. Failure mode real e específico.

---

## 5. Counterfactual: e se shipar só doc?

| Eixo | Valor capturado por 1 doc dizendo "use LSPTool mais" | Custo |
|------|----------------------------------------------------|-------|
| 1 | 40-60% — usuários que leem doc absorvem; maioria dos agentes melhora pouco (não leem doc) | ~30 min |
| 2 | 10-20% — doc não pode parsear diff por você | ~15 min |
| 3 | 0% — doc não gera wiki | n/a |
| 4 | 0% — doc não cacheia | n/a |
| 5 | 100% (já é defer) | 0 |

**Conclusão honesta:** para Eixo 1, o doc captura grande parte do valor. Para Eixos 2 e 4, é preciso código.

---

## 6. Edits recomendadas no roadmap

1. **Eixo 1:** restringir o nudge ao primeiro canal (descriptions de `LSPTool` e `GrepTool` em `src/tools/LSPTool/prompt.ts` e `src/tools/GrepTool/prompt.ts`). Adiar a mexida nos system prompts de Explore/Plan/main (`src/tools/AgentTool/built-in/exploreAgent.ts:13-57`, `planAgent.ts:14-71`, `systemPrompt.ts:41-119`) até medir efeito da mudança nas tool descriptions sozinha. Banir o tom "ALWAYS use LSP BEFORE" (`07 Eixo 1` adverte) — usar "for symbol queries prefer LSP, fallback Grep when language has no server".

2. **Eixo 2:** split 2a/2b.
   - **2a:** parser de hunks + injeção de tabela estática (lines changed, hunk count, security-keyword match no path) — sem LSP.
   - **2b:** risk score com **2 dimensões** (callers via LSP + test gap), não 5. Cap rígido de 10 símbolos LSP-quizzed por PR. Bloco `## Verdict: GO|NO-GO|NEEDS-WORK` ao final (steal do `pre_merge_check_prompt`, `07 Eixo 2`).
   - Ship 2a primeiro, medir, então 2b.
   - Calibrar risk score contra ≥10 PRs reais antes de publicar pesos (`no-overclaim-performance`).

3. **Eixo 3:** **drop o LLM-summarizer-per-module.** Substituir por: scaffold determinístico, 1 página por top-level dir em `src/`, conteúdo = outline regex (já temos `src/tools/shared/codeOutline/scanSymbols.ts`, `06 Gap 3`). Zero LLM. Se ninguém usar isso em 4 semanas, kill o eixo todo. Não substituir o `init.ts:6-37` — **aumentar** com 1 modo `wiki regen --outline-only`.

4. **Eixo 4:** começar memoizando **só `documentSymbol`**. Adicionar `findReferences` ao cache só depois de medir hit rate por 1 semana. Invalidação por path do arquivo editado **+ caps de tamanho** (ex: max 100 entries, LRU). Documentar limitação reverse-deps.

5. **Eixo 5:** sustentar DEFER. Adicionar critério explícito de descongelamento: "só se Eixos 2 e 4 mostrarem ganho **medido** em ≥3 sessões reais por ≥2 semanas".

6. **Sequência:** Eixo 1 (descriptions only) → instrumentação/medição → Eixo 4 (documentSymbol cache) → Eixo 2a (parser+tabela) → medir → Eixo 2b (LSP score) → Eixo 3 (scaffold determinístico) → reavaliar 5.

---

## 7. Kill criteria por eixo

| Eixo | Sinal observável mid-implementation | Ação |
|------|-------------------------------------|------|
| 1 | A/B de 1 semana sobre tool descriptions mostra <5pp de aumento na ratio LSP/(LSP+Grep) para queries de símbolo | Abandonar; não mexer em system prompts |
| 2a | Parser de hunks tem >10% erro em 20 PRs reais do Claudin | Reverter |
| 2b | Em 10 PRs reais, novo /review não acha ≥1 issue extra que velho não acha **OU** consome >2× tokens | Reverter para 2a |
| 3 | Maintainer (você) abre <3 páginas geradas em 4 semanas | Deletar feature; manter scaffold estático |
| 4 | Hit rate <20% em 5 sessões reais >10 turnos | Reverter; cache não justifica complexidade |
| 5 | (defer) Se em 6 meses 2 e 4 não acumularam evidência de ganho | Sustentar defer indefinidamente |

---

## 8. Recomendação final

**Ship subset: Eixo 4 (escopo reduzido) + Eixo 2a + experimento mínimo do Eixo 1.**

Concretamente, em ordem:

1. **Eixo 1 minimal:** editar 2 strings — `src/tools/LSPTool/prompt.ts` e `src/tools/GrepTool/prompt.ts` — para incluir "for symbol queries prefer the other when applicable" cruzado. Instrumentar tool-call counters por 1-2 semanas. Custo: ~1 dia + medida.

2. **Eixo 4 reduzido:** cache in-memory **só de `documentSymbol`**, com LRU cap, invalidação por path em FileEdit/FileWrite. Toca `src/tools/LSPTool/LSPTool.ts` + `src/agent/tools/toolExecution.ts` (`08 Eixo 4`). Custo: ~3 dias.

3. **Eixo 2a:** parser de hunks + tabela estática (sem LSP), substitui o prompt de `src/commands/review.ts:9-31`. Bloco `## Verdict` ao final. Custo: ~2-3 dias.

**Não shipar agora:**
- Eixo 2b (LSP-driven risk score): só após 2a e Eixo 4 medirem ganho.
- Eixo 3 (wiki autogen): replace por scaffold estático ou drop. Atual `init.ts` não é dor; é design.
- Eixo 5: sustentar DEFER.

Justificativa: o roadmap como apresentado tem alto risco de repetir o erro do CRG documentado em `02 §9` — mecanismo elegante, marketing à frente do mensurável, ganho que evapora no caso comum (PR pequeno, sessão curta, repo médio). O recorte sugerido isola o que é **mecanicamente verificável** (cache hit/miss, tool-call ratio) do que é **fé arquitetural** (risk score calibrado, wiki útil), e ship só o primeiro até o segundo provar valor.

Maintainer único: cada eixo é também superfície de bug, suporte, documentação. Comprometer com 5 eixos = 5 frentes de manutenção. Comprometer com 2.5 = sobra capacidade pra iterar com base no que medir.
