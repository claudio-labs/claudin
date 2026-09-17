---
name: systemprompt-snapshot-harness-drift
description: snapshot systemPrompt.main.txt cobre texto injetado pelo harness ("Notes for this model"); o regen captura variação local como se fosse fato — comparar com o main antes de commitar
type: project
---

O teste `systemPrompt.characterization.test.ts` ("prompt byte-identical") captura o prompt INTEIRO, incluindo blocos injetados pelo harness outside do repo — o bloco "Notes for this model" e as linhas de modelo variam por máquina/sessão. Em 2026-09-17 o teste quebrou na branch `chore/remove-ultraplan` E no `main` (provado por rebuild+repro, nada a ver com a remoção de ultraplan); o regen `UPDATE_PROMPT_SNAPSHOT=1` foi commitado por decisão do usuário.

**Why:** O snapshot é byte-byte sobre saída que inclui texto variável; um regen pode gravar notas locais do harness como se fossem o prompt do produto.

**How to apply:** Antes de commitar um regen, olhar o diff e identificar o que é texto de harness vs. prompt do produto. Se houver menção de "Notes for this model", é harness-local — e a mudança de sistema-prompt real deve ser provada por outra fonte (grep no fonte).

Relacionado: [[removal-pass-only-provably-dead]]
