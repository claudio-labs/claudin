# 05 — Content-addressed blob store

## O que omp faz

`packages/agent/src/session/blob-store.ts` armazena artefatos (tool outputs grandes, anexos, transcripts) endereçados por hash do conteúdo. Mesmo conteúdo → mesmo path → dedupe automático entre sessões.

## Por que importa para Claudin

- Hoje `src/services/tools/toolResultStorage.ts` salva output grande de tools por sessão, sem dedupe.
- Mesmo `Read` de um arquivo grande em N sessões = N cópias.
- Compaction frequentemente re-emite o mesmo blob: CAS poderia substituir por referência.
- `~/.claudin/projects/<dir>/blobs/sha256/ab/cdef...` dá GC trivial (refcount ou mark-sweep contra MEMORY.md/transcripts).

## Perguntas em aberto

- Qual hash? sha256 (paranoia) vs blake3 (rápido)?
- Tamanho mínimo para entrar no CAS (não vale guardar 200 bytes hashado)?
- Como rerefenciar dentro de transcripts JSONL — `{"$blob": "sha256:..."}`?
- Encriptação at-rest (settings.json já é plaintext, então provavelmente não)?

## Referência

- `packages/agent/src/session/blob-store.ts` (omp)
- `src/services/tools/toolResultStorage.ts` (claudin)
