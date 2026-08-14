# Bench T6.6 — FileReadTool leitura cirurgica (3-way)

- Timestamp: 2026-05-28T02:51:22.925Z
- Model: `claude-sonnet-4-6`
- Target cwd: `/home/dev/projects/openclaude`
- Runs por prompt: 1
- Variant A (baseline): `/home/dev/projects/claudio/dist/baseline-a/cli.mjs`
- Variant B (description-only): `/home/dev/projects/claudio/dist/feature-b/cli.mjs`
- Variant C (auto-outline): `/home/dev/projects/claudio/dist/feature-c/cli.mjs`

## Tabela por invocacao

| Prompt | V | Run | OK | input+cache | cost $ | wall s | turns | tools | read modes | LSP ops | session |
|---|---|---:|:-:|---:|---:|---:|---:|---|---|---|---|
| outline-first | A | 1 | Y | 75471 | 0.3139 | 22.1 | 2 | Grep=1 LSP=0 Read=0 Glob=0 | outline=0 symbol=0 range=0 full=0 view-full=0 | - | 3d54ed31 |
| outline-first | B | 1 | Y | 78356 | 0.3253 | 27.4 | 2 | Grep=0 LSP=0 Read=1 Glob=0 | outline=1 symbol=0 range=0 full=0 view-full=0 | - | 094bef9c |
| outline-first | C | 1 | Y | 114782 | 0.3350 | 24.6 | 3 | Grep=2 LSP=0 Read=0 Glob=0 | outline=0 symbol=0 range=0 full=0 view-full=0 | - | 00faca9e |

## Sumario por variante

### A (baseline) — n=1

- Avg total input cost tokens (input+cache_read+cache_creation): **75471**
- Avg input tokens (raw): 7
- Avg cache_read tokens: 36623
- Avg cache_creation tokens: 38841
- Avg output tokens: 2113
- Avg duration: 22.08s
- Avg turns: 2.0
- Total cost: $0.3139
- Tool call totals: Grep=1 LSP=0 Read=0 Glob=0
- Read mode totals: outline=0 symbol=0 range=0 full=0 view-full=0
- LSP op totals: -

### B (description-only) — n=1

- Avg total input cost tokens (input+cache_read+cache_creation): **78356**
- Avg input tokens (raw): 7
- Avg cache_read tokens: 36974
- Avg cache_creation tokens: 41375
- Avg output tokens: 1926
- Avg duration: 27.41s
- Avg turns: 2.0
- Total cost: $0.3253
- Tool call totals: Grep=0 LSP=0 Read=1 Glob=0
- Read mode totals: outline=1 symbol=0 range=0 full=0 view-full=0
- LSP op totals: -

### C (auto-outline) — n=1

- Avg total input cost tokens (input+cache_read+cache_creation): **114782**
- Avg input tokens (raw): 8
- Avg cache_read tokens: 75639
- Avg cache_creation tokens: 39135
- Avg output tokens: 2100
- Avg duration: 24.62s
- Avg turns: 3.0
- Total cost: $0.3350
- Tool call totals: Grep=2 LSP=0 Read=0 Glob=0
- Read mode totals: outline=0 symbol=0 range=0 full=0 view-full=0
- LSP op totals: -

## Deltas vs A (baseline)

| Variant | Δ avg total input cost tokens | Δ wall | Δ cost | Δ turns |
|---|---:|---:|---:|---:|
| B | 3.8% | 24.2% | 3.6% | 0.0% |
| C | 52.1% | 11.5% | 6.7% | 50.0% |

### Kill criteria (roadmap)

- **GO ship C** se C reduz input cost tokens em >=20% vs A em >=3/4 prompts, sem regressao de wall/cost > +15%.
- **NO-GO** se C ≈ A em tokens. Marcar T6.6 [~] DROPADO.

## Outputs (resultText) lado a lado

### outline-first

> No arquivo `src/services/messages/messages.ts` (codebase openclaude), liste todas as funcoes exportadas (`export function` e `export async function`) com seu nome e linha de declaracao. Nao preciso do corpo das funcoes.

**Variant A run#1:**

```
Funções exportadas em `src/services/messages/messages.ts`:

| Linha | Função |
|---|---|
| 187 | `withMemoryCorrectionHint` |
| 202 | `deriveShortMessageId` |
| 236 | `AUTO_REJECT_MESSAGE` |
| 239 | `DONT_ASK_REJECT_MESSAGE` |
| 259 | `isClassifierDenial` |
| 269 | `buildYoloRejectionMessage` |
| 290 | `buildClassifierUnavailableMessage` |
| 312 | `isSyntheticMessage` |
| 333 | `getLastAssistantMessage` |
| 343 | `hasToolCallsInLastAssistantTurn` |
| 413 | `createAssistantMessage` |
| 437 | `createAssistantAPIErrorMessage` |
| 462 | `createUserMessage` |
| 527 | `prepareUserContent` |
| 547 | `createUserInterruptionMessage` |
| 568 | `createSyntheticUserCaveatMessage` |
| 578 | `formatCommandInputTags` |
| 592 | `createModelSwitchBreadcrumbs` |
| 605 | `createProgressMessage` |
| 624 | `createToolResultStopMessage` |
| 635 | `extractTag` |
| 691 | `isNotEmptyMessage` |
| 727 | `deriveUUID` |
| 733/736/739/742/743 | `normalizeMessages` (overloads + impl) |
| 831 | `isToolUseRequestMessage` |
| 845 | `isToolUseResultMessage` |
| 857 | `reorderMessagesInUI` |
| 1081 | `hasUnresolvedHooks` |
| 1100 | `getToolResultIDs` |
| 1117 | `getSiblingToolUseIDs` |
| 1172 | `buildMessageLookups` |
| 1375 | `buildSubagentLookups` |
| 1423 | `getSiblingToolUseIDsFromLookup` |
| 1437 | `getProgressMessagesFromLookup` |
| 1451 | `hasUnresolvedHooksFromLookup` |
| 1463 | `getToolUseIDs` |
| 1483 | `reorderAttachmentsForAPI` |
| 1531 | `isSystemLocalCommandMessage` |
| 1679 | `stripToolReferenceBlocksFromUse
...[truncado]
```

**Variant B run#1:**

```
Lista de funções exportadas em `src/services/messages/messages.ts` (apenas `export function` e `export async function`):

- `withMemoryCorrectionHint` — L187
- `deriveShortMessageId` — L202
- `AUTO_REJECT_MESSAGE` — L236
- `DONT_ASK_REJECT_MESSAGE` — L239
- `isClassifierDenial` — L259
- `buildYoloRejectionMessage` — L269
- `buildClassifierUnavailableMessage` — L290
- `isSyntheticMessage` — L312
- `getLastAssistantMessage` — L333
- `hasToolCallsInLastAssistantTurn` — L343
- `createAssistantMessage` — L413
- `createAssistantAPIErrorMessage` — L437
- `createUserMessage` — L462
- `prepareUserContent` — L527
- `createUserInterruptionMessage` — L547
- `createSyntheticUserCaveatMessage` — L568
- `formatCommandInputTags` — L578
- `createModelSwitchBreadcrumbs` — L592
- `createProgressMessage` — L605
- `createToolResultStopMessage` — L624
- `extractTag` — L635
- `isNotEmptyMessage` — L691
- `deriveUUID` — L727
- `normalizeMessages` — L733, L736, L739, L742 (sobrecargas)
- `isToolUseRequestMessage` — L831
- `isToolUseResultMessage` — L845
- `reorderMessagesInUI` — L857
- `hasUnresolvedHooks` — L1081
- `getToolResultIDs` — L1100
- `getSiblingToolUseIDs` — L1117
- `buildMessageLookups` — L1172
- `buildSubagentLookups` — L1375
- `getSiblingToolUseIDsFromLookup` — L1423
- `getProgressMessagesFromLookup` — L1437
- `hasUnresolvedHooksFromLookup` — L1451
- `getToolUseIDs` — L1463
- `reorderAttachmentsForAPI` — L1483
- `isSystemLocalCommandMessage` — L1531
- `stripToolReferenceBlocksFromUserMessage` — L16
...[truncado]
```

**Variant C run#1:**

```
Funções exportadas em `src/services/messages/messages.ts` (nenhuma `export async function`):

- `withMemoryCorrectionHint` — L187
- `deriveShortMessageId` — L202
- `AUTO_REJECT_MESSAGE` — L236
- `DONT_ASK_REJECT_MESSAGE` — L239
- `isClassifierDenial` — L259
- `buildYoloRejectionMessage` — L269
- `buildClassifierUnavailableMessage` — L290
- `isSyntheticMessage` — L312
- `getLastAssistantMessage` — L333
- `hasToolCallsInLastAssistantTurn` — L343
- `createAssistantMessage` — L413
- `createAssistantAPIErrorMessage` — L437
- `createUserMessage` — L462
- `prepareUserContent` — L527
- `createUserInterruptionMessage` — L547
- `createSyntheticUserCaveatMessage` — L568
- `formatCommandInputTags` — L578
- `createModelSwitchBreadcrumbs` — L592
- `createProgressMessage` — L605
- `createToolResultStopMessage` — L624
- `extractTag` — L635
- `isNotEmptyMessage` — L691
- `deriveUUID` — L727
- `normalizeMessages` — L733, L736, L739, L742 (overloads), L743 (impl)
- `isToolUseRequestMessage` — L831
- `isToolUseResultMessage` — L845
- `reorderMessagesInUI` — L857
- `hasUnresolvedHooks` — L1081
- `getToolResultIDs` — L1100
- `getSiblingToolUseIDs` — L1117
- `buildMessageLookups` — L1172
- `buildSubagentLookups` — L1375
- `getSiblingToolUseIDsFromLookup` — L1423
- `getProgressMessagesFromLookup` — L1437
- `hasUnresolvedHooksFromLookup` — L1451
- `getToolUseIDs` — L1463
- `reorderAttachmentsForAPI` — L1483
- `isSystemLocalCommandMessage` — L1531
- `stripToolReferenceBlocksFromUserMessage` — L1679
- `stripCaller
...[truncado]
```

