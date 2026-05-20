# Folder-scoped Context — CLAUDE.md por subpasta

> **Fonte:** `claude-mem` repo, `src/services/worker/agents/ResponseProcessor.ts:240-261`, `src/utils/claude-md-utils.ts`, `docs/public/usage/folder-context.mdx`.
> **Verificado contra o repo em 2026-05-19** — a feature EXISTE e auto-escreve (o rascunho anterior duvidava disso). Ver "Correções pós-verificação".

## A feature existe e é real

O `claude-mem` **auto-escreve** arquivos `CLAUDE.md` em subpastas a partir da atividade observada de arquivos. Não é suggestion-only, não é skill manual — é escrita automática feita pelo worker daemon. É **opt-in, desligada por default**.

## Como funciona — cadeia verificada

**Trigger** — `ResponseProcessor.ts:240-261`, dentro do worker daemon, *depois* das observações serem gravadas:

```ts
const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;
if (folderClaudeMdEnabled) {
  const allFilePaths = [];
  for (const obs of observations) {
    allFilePaths.push(...(obs.files_modified || []));
    allFilePaths.push(...(obs.files_read || []));
  }
  if (allFilePaths.length > 0) {
    updateFolderClaudeMdFiles(allFilePaths, session.project, getWorkerPort(), projectRoot);
  }
}
```

**Não é um hook do Claude Code** — roda no worker daemon do claude-mem, no path de processamento de observações.

**Lógica** — `updateFolderClaudeMdFiles` (`claude-md-utils.ts:223`):

1. Coleta `files_modified[]` + `files_read[]` de todas as observações, deriva a pasta-pai de cada (`path.dirname`)
2. Por pasta, chama a API HTTP do worker `/api/search/by-file?...&isFolder=true` para a timeline de atividade recente
3. Formata como tabela markdown `# Recent Activity` (`formatTimelineForClaudeMd`, `:109`)
4. Escreve via `writeClaudeMdToFolder` (`:75`)

**O que escreve:** `CLAUDE.md` em cada subpasta tocada (ou `CLAUDE.local.md` se `CLAUDE_MEM_FOLDER_USE_LOCAL_MD='true'`). Só a região entre as tags `<claude-mem-context>` e `</claude-mem-context>` é gerenciada — `replaceTaggedContent` (`:55`) preserva todo conteúdo do usuário fora das tags. Escrita atômica (`.tmp` + `renameSync`).

## NÃO há heurística de concentração/clustering

**Correção importante ao rascunho anterior:** não existe threshold de concentração (o "70%" do rascunho foi inventado). O trigger é simples: **toda pasta que contém ao menos um arquivo lido/modificado no batch tem seu `CLAUDE.md` regenerado.** Um arquivo basta.

Há filtragem, mas é lógica de *exclusão*, não threshold:

- **Raiz do projeto skipada** — `isProjectRoot()` (`:206`) skipa qualquer pasta com `.git`. O `CLAUDE.md` versionado da raiz **não** é sobrescrito
- **Dirs unsafe skipados** — `res, .git, build, node_modules, __pycache__` (`EXCLUDED_UNSAFE_DIRECTORIES`)
- **Guard hard contra `.git/`** — `writeClaudeMdToFolder` recusa qualquer path sob `.git` (`:78`)
- **Guard de race** — se um `CLAUDE.md`/`CLAUDE.local.md` está entre os arquivos tocados, aquela pasta é skipada
- **Exclude list do usuário** — `CLAUDE_MEM_FOLDER_MD_EXCLUDE` (array JSON)
- **Skip de atividade vazia** — não cria arquivo vazio

**Gate:** `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED`, default `'false'` (`SettingsDefaultsManager.ts:41,116`). Tornado opt-in pelo PR #913 (era always-on antes). O `CHANGELOG.md:833` registra "Removed auto-generated per-directory CLAUDE.md files across the tree" — a feature foi contenciosa e iterada bastante (issues #641, #609, #632, #620, #1165, #2188), por isso hoje é opt-in com uma camada grossa de exclusão.

## Por que isso economiza tokens

O Claudio **já carrega** `CLAUDE.md` aninhado de forma lazy — arquivos de subpasta só entram no contexto quando o agente trabalha naquela subárvore. Conhecimento de `src/services/api/` não custa nada enquanto o agente mexe em `src/components/`. O que o claude-mem adiciona é a **escrita automática** desses arquivos.

Em vez de um `CLAUDE.md` raiz monolítico pago em toda sessão, o conhecimento fica **co-localizado e lazy-loaded**.

## Proposta para o Claudio

O Claudio hoje escreve memória só em `~/.claudio/projects/<dir>/memory/` (fora do git). Portar a escrita automática em `CLAUDE.md` versionado tem risco real.

### Riscos — por que isto é tier médio, não alto

1. **`CLAUDE.md` é versionado em git.** Escrita automática nele = commits gerados por máquina em arquivo revisado por humanos. O claude-mem mitiga com (a) tags `<claude-mem-context>` que isolam a região gerenciada, (b) opção `CLAUDE.local.md`, (c) doc dizendo para gitignorar. Ainda assim foi contencioso o suficiente para virar opt-in.
2. **Atividade de arquivos é sinal fraco.** O claude-mem regenera por *qualquer* arquivo tocado — sem heurística de relevância. Para o Claudio, isso geraria ruído.

### Recomendação

Caminho mais seguro que o do claude-mem:

- **v1: extractor sugere ao usuário** ("este aprendizado parece específico de `src/services/api/` — adicionar ao `CLAUDE.md` de lá?") em vez de escrever sozinho
- **v2: escrita automática só em `CLAUDE.local.md`** (gitignored, escopo de subpasta), nunca no `CLAUDE.md` versionado sem aprovação — espelha o `CLAUDE_MEM_FOLDER_USE_LOCAL_MD` deles
- Sempre isolar a região gerenciada com tags-sentinela (copiar o padrão `<claude-mem-context>`) para nunca tocar conteúdo humano
- Default OFF, gate por feature flag — como o claude-mem aprendeu pela via dura

## Decisões abertas

1. **Escrever, sugerir, ou só em `.local.md`?** Recomendação: sugerir na v1.
2. **Trigger por quê?** O claude-mem usa "qualquer arquivo tocado". Para o Claudio, melhor disparar a partir de uma memória `project` já extraída cujos `files_modified` apontam para uma subpasta — sinal mais forte que atividade bruta.
3. **Interação com o store de memória existente** — a memória vai para `CLAUDE.md` da subpasta *em vez de* `memory/`, ou *além de*? Recomendação: ou um ou outro, evitar duplicação.

## Correções pós-verificação (2026-05-19)

| Claim original | Status | Correção |
|---|---|---|
| "não tenho certeza se a feature existe" | ✓ resolvido | **Existe** e auto-escreve; opt-in, default OFF |
| Trigger por concentração de arquivos (~70%) | ❌ | Sem heurística de concentração — toda pasta com qualquer arquivo tocado é regenerada |
| Fonte: `docs/architecture-overview.md` | ❌ | Esse arquivo **não menciona** a feature. Doc real: `docs/public/usage/folder-context.mdx` |
| (implícito) é um hook pós-sessão | ❌ | É escrita worker-side em `ResponseProcessor`, não um hook do Claude Code |

## Arquivos de referência (claude-mem)

| Tema | Arquivo:linha |
|---|---|
| Trigger + gate de setting | `src/services/worker/agents/ResponseProcessor.ts:240-261` |
| Lógica de pastas + exclusões | `src/utils/claude-md-utils.ts:223` |
| Escrita atômica + guard `.git` | `src/utils/claude-md-utils.ts:75-98` |
| Preservação de conteúdo do usuário | `src/utils/claude-md-utils.ts:55-73` |
| Default do setting | `src/shared/SettingsDefaultsManager.ts:41,116` |
| Doc user-facing | `docs/public/usage/folder-context.mdx` |
