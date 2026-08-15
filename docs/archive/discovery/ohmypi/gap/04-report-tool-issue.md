# 04 — Gap: outros mecanismos de self-feedback/QA

Mecanismos meta-cognitivos do omp além do `report_tool_issue` já coberto. Filtrado para privacy-safe (local-only, sem phone-home).

## 1. Hindsight (reflect/retain/recall) — memória meta-cognitiva

**omp**:
- `hindsight/` (1658 LOC) — backend de memória reflexiva separado de `memories/`.
- `tools/hindsight-reflect.ts:15-57` — `reflect({ query, context })`: força modelo a parar e introspectar, gerando memória.
- `tools/hindsight-retain.ts:19-56` — `retain({ items[] })`: enfileira fatos via `state.enqueueRetain` (batch debounced).
- `tools/hindsight-recall.ts:14-67` — `recall({ query })`: busca antes de agir.
- Gating: `settings.get("memory.backend") === "hindsight"`. Default-off.
- **Fail-open** (retain.ts:43-44) — batch failure vira UI warning, LLM não sabe.

**Vale pra Claudin?**
- **Parcial.** `src/services/extractMemories/` já cobre retain automático (extração pós-turno). `reflect` (forçar pausa pra introspecção) é o ganho novo.
- **Privacy red flag**: `client.ts` é RPC HTTP. Portar exige backend 100% local (SQLite ou flat-file).
- Risco de duplicar com infra existente.

**Encaixe**: `src/services/hindsight/` paralelo a `extractMemories/`. Reuso `src/memdir/paths.ts`. Tool `src/tools/ReflectTool/`. Flag `HINDSIGHT_REFLECT`.

## 2. Checkpoint/Rewind — investigação sandbox com rollback

**omp**:
- `tools/checkpoint.ts:49-92` — `checkpoint({ goal })`: grava `checkpointMessageCount` + `checkpointEntryId`.
- `:94-150` — `rewind({ report })`: descarta mensagens pós-checkpoint, preserva só `report` consolidado. Top-level session only.
- Pattern = sandbox cognitivo: modelo explora livre, descarta dead-ends, só o relatório entra na história.

**Vale pra Claudin?**
- **Sim, alto valor.** Não há equivalente. Reduz drift em investigações longas.
- 100% local, sem phone-home.
- Sinergia com `src/services/contextCollapse/` e `src/services/compact/`.

**Encaixe**: `src/tools/CheckpointTool/` + `src/tools/RewindTool/`. History mutation hook em `src/QueryEngine.ts` (`messages.length = checkpointCount` + push do report). Flag `CHECKPOINT_REWIND`. Compatível com plan mode hard-gate.

## 3. Reviewer agent + `report_finding` (structured findings)

**omp**:
- `prompts/agents/reviewer.md:1-60` — sub-agent com output schema: `overall_correctness: enum(correct|incorrect)`, `confidence: 0.0-1.0`, `findings[]` com `priority: P0-P3`, `confidence` por finding, `line_start/end ≤10 lines`.
- `tools/review.ts:54-78` — `report_finding({title, body, priority, confidence, file_path, line_start, line_end})` exposta SÓ ao reviewer agent.
- Confidence scoring obrigatório + priority taxonomy.

**Vale pra Claudin?**
- **Sim.** `src/commands/review/` e `src/commands/security-review/` existem mas sem structured output/confidence. Team memory hint: "Review agent as quality gate".
- Local por construção.

**Encaixe**: estender `src/commands/review/index.ts`. Nova tool `src/tools/ReportFindingTool/` gated por permissão (só ao reviewer agent).

## 4. Oracle agent — second-opinion

**omp**:
- `prompts/agents/oracle.md:1-55` — agent senior consultado quando outro "stuck/uncertain". `model: pi/slow`, `thinking-level: xhigh`, `blocking: true`.
- Forces "MUST identify root causes", "MUST consider 2+ hypotheses".

**Vale pra Claudin?**
- **Médio-alto.** `src/coordinator/` é multi-agent mas sem consultor explícito. Encaixa em `AgentTool/`.
- Útil em fallback chain (primário + escalation a modelo mais forte).

**Encaixe**: `src/prompts/agents/oracle.md`. Registrar via `AgentTool/`. Preset adicional `getPrimaryModel`/`getSlowModel` em `src/services/api/providerModels.ts`.

## 5. Autoresearch — closed-loop self-eval com confidence

**omp**:
- `autoresearch/` (~12 arquivos) — agente que itera experimentos com baseline metrics.
- `tools/log-experiment.ts:39-56` — schema `metric: number`, `status: keep|discard|crash|checks_failed`, `metrics`, `asi: { hypothesis, rollback_reason, next_action_hint }`.
- `state.ts` `computeConfidence` — multiplos do noise floor.
- `flag_runs` para reward hacking detection.

**Vale pra Claudin?**
- **Só vale com modo benchmark/optimization explícito.** Hoje não existe.
- Postpone.

## 6. LSP post-edit diagnostics injection (verify-self automático)

**omp**:
- `edit/index.ts:489-511` `#beginDeferredDiagnosticsForPath` — após cada edit, AbortController colhe diagnostics tardios.
- `:513-527` `#injectLateDiagnostics` — enfileira `lsp-late-diagnostic` (`role: custom, display: false`) no histórico. **Modelo recebe feedback automático sem chamar tool.**

**Vale pra Claudin?**
- **Sim, 80% da infra existe.** `src/platform/lsp/diagnosticsForToolResult.ts` + `awaitDiagnosticsForFile.ts` + `diagnosticTracking.ts:30-40` (baseline).
- **Falta:** canal de injeção *deferred* (mensagens que chegam depois do tool result ter retornado).

**Encaixe**: `src/QueryEngine.ts` adicionar `queueDeferredMessage` entre turnos. `src/tools/FileEditTool/FileEditTool.ts` caller-side wiring.

## 7. IRC dedupe — loop/stuck detection

**omp**:
- `session/agent-session.ts:447-483` `dedupeIrcReply` — detecta runs >3 de linhas idênticas, colapsa para `[…N×]`, hard-cap 4KiB.
- Comentário (`:450-453`): "Models occasionally loop on a single line (~16 reports)".
- Fail-open detection — não para o modelo, comprime output ofensivo.

**Vale pra Claudin?**
- **Sim, baixíssimo custo.** Defensiva contra OpenAI-compat providers que loop mais.
- Aplicável em `src/outputFilter/Bash/` e streaming text.

**Encaixe**: util genérico `src/utils/textDedupe.ts`. Aplicar em streaming pipe ou antes de `QueryEngine.ts` consumir. Sem flag — mitigação defensiva direta.

## 8. Confidence scoring no schema

**omp**:
- `reviewer.md:19-22, 41-44` — `confidence: number` obrigatório no output structured. Mesmo padrão em `autoresearch/state.ts`.

**Vale pra Claudin?**
- **Sim como convenção de schema**, não como infra.
- Exemplo: `src/tools/VerifyPlanExecutionTool/` deveria incluir confidence.

**Encaixe**: bullet em `.claudin/rules/typescript-patterns.md`: "Tools que retornam veredito devem incluir `confidence: z.number().min(0).max(1)`".

## 9. NÃO portar

- `eval/` Jupyter-style kernel — Claudin não tem use case (REPLTool é genérico).
- `autoresearch/` completo — sem caso de uso.
- `hindsight/client.ts` RPC — viola privacy hard rule.
- Telemetria de tool execution — Claudin já bate omp em privacy.

## 10. Priorização por ROI

| # | Mecanismo | Esforço | Ganho | Privacy | Prio |
|---|---|---|---|---|---|
| 2 | Checkpoint/Rewind | M | Alto | ✓ | **P0** |
| 6 | Late LSP diagnostics injection | S | Alto | ✓ | **P0** |
| 7 | Dedupe loop output | S | Médio | ✓ | **P1** |
| 3 | Reviewer structured findings | M | Médio-alto | ✓ | **P1** |
| 1 | Hindsight reflect-only | M | Médio | ✓ se local | **P2** |
| 4 | Oracle agent | S | Médio | ✓ | **P2** |
| 8 | Confidence em schemas (convenção) | XS | Baixo | ✓ | **P3** |

**Targets concretos:**
- `src/QueryEngine.ts` — hook `queueDeferredMessage` (#6) + history mutation hooks (#2).
- `src/platform/lsp/diagnosticsForToolResult.ts` — extender com path "deferred" (#6).
- `src/tools/FileEditTool/FileEditTool.ts` — caller-side wiring (#6).
- `scripts/build.ts` featureFlags — `CHECKPOINT_REWIND`, `HINDSIGHT_REFLECT`, `REVIEWER_FINDINGS`.
- `scripts/verify-no-phone-home.ts` — sem novos entries; tudo local.
