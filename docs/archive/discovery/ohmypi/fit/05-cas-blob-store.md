# 05 — CAS blob store: análise de encaixe + ganhos reais

Avaliação concreta de adotar (ou portar inspiração do) `BlobStore` content-addressed
de omp para o Claudin. Sem plano de implementação; só evidência mensurada e
veredito.

## 1. Inventário: onde Claudin persiste output grande hoje

| Local | Storage | Tamanho típico | Dedup | Cleanup |
|---|---|---|---|---|
| `src/utils/toolResultStorage.ts` | `~/.claudin/projects/<dir>/<sid>/tool-results/<toolUseId>.{txt,json}` | 50KB threshold, observado até 645 KB | Nenhum (chave = `toolUseId`, único por invocação) | Time-based 30d via `src/utils/cleanup.ts:155-203`; também deletado por `/clear` (`unlinkSessionSpillDir`, l.146) |
| `src/utils/pasteStore.ts` | `~/.claudin/paste-cache/<sha256_short>.txt` | 11-37 KB observado (5 files, 104 KB total) | **Já content-addressed por SHA-256** (l.21 `hashPastedText`); idempotente | `cleanupOldPastes(cutoffDate)` l.76 |
| `~/.claudin/file-history/<sessionId>/<hashedPath>@v<N>` | Por-sessão, snapshots versionados de arquivos editados | 45 MB total, 3 016 arquivos | Path hasheado, mas conteúdo NÃO dedup (versão N e N+1 ficam lado a lado) | Não localizei GC; cresce |
| Session transcripts `~/.claudin/projects/<dir>/<sid>.jsonl` (+ `subagents/`) | JSONL append-only | 68 KB – 8.9 MB (max observado 9.4 MB) | Nenhum — conteúdo inteiro inline | Não há truncate; 30d cleanup só para tool-results |
| `~/.claudin/shell-snapshots` | Estado de shell por sessão | 3.7 MB total | Nenhum | — |
| MCP tool outputs | Reusa caminho do `toolResultStorage` (passa pelo mesmo `processToolResultBlock`) | Igual ao acima | Nenhum | Igual |
| `~/.claudin/v8cache/` | Bytecode V8 do bundle | 27 MB | N/A (cache de execução) | Invalidado em rebuild |
| Imagens / `data:image/` | **Não há cache dedicado.** Quando o usuário cola/anexa imagem, vira `image_url`/base64 no transcript JSONL inline | Pode ser MBs por imagem | Nenhum — N anexos = N cópias no JSONL | Só junto com o JSONL |

Pontos relevantes:

- `paste-cache` já é o "blob store" interno do Claudin para texto colado. SHA-256, fanout-0, never-delete-on-write. **A primitiva existe.**
- `tool-results` usa `toolUseId` como chave: dedup zero por design (cada
  invocação tem id novo, mesmo que o resultado seja idêntico).
- Imagens são o **único caso onde Claudin joga MBs inline no JSONL** sem
  qualquer externalização — exatamente o problema que omp resolveu primeiro.

## 2. Medições concretas

```
~/.claudin/projects/        348 MB total, 153 projetos, 298 sessões
~/.claudin/file-history/     45 MB total, 3 016 arquivos
~/.claudin/v8cache/          27 MB total
~/.claudin/paste-cache/     104 KB total, 5 arquivos
~/.claudin/plugins/         5.5 MB
```

Tool-results detalhado (todos os projetos, 2 005 arquivos, 5.8 MB):

```
total bytes:  5 814 435
unique bytes: 3 690 892  → 36.5 % "savings" se dedup global
```

Mas isso é enganoso: 1 937 dos 2 005 arquivos são o mesmo fixture de teste de
1 000 bytes (`6c35f0c7885fd1218ac65e1d93b2ee60`, conteúdo `XXXX…`) gerado pelos
`-tmp-claudin-summarizer-int-*`. Filtrando esses:

```
real-world files:    133
real-world unique:    64 hashes (5 hashes duplicados)
real-world bytes:    3 942 435
bytes wasted (dup):    251 543  → 6.4 % savings reais
```

Maiores tool-results individuais (sem dedup, todos < 1 MB):

```
645 457 B  aargau/90eec.../bkugu7fxe.txt
431 193 B  claudin/83a8e1cc.../bm79jd0om.txt
251 131 B  claudin/9ea27fe0.../bg4n2svbo.txt
187 707 B  claudin/4a6e3245.../bh66joegq.txt
141 529 B  claudin/4a6e3245.../b3m7oz4gc.txt
```

Tamanho médio de um tool-results dir por sessão: 80–500 KB (mediana ~100 KB).

Conclusão das medições: 348 MB total estão dominados por **transcripts JSONL e
file-history**, não por tool-results. Tool-results inteiros somam 5.8 MB (1.7%
do `projects/`). Dedup de tool-results global recuperaria ~250 KB no estado
atual. Não move a agulha.

## 3. Onde CAS ganha de verdade no Claudin

| Cenário | Ganho concreto | Tamanho típico |
|---|---|---|
| Mesma imagem (screenshot, logo, PDF page) anexada em N turnos / N sessões | Cada inline base64 = ~1.3× o binário; dedup elimina N-1 cópias | 100 KB – 5 MB por imagem |
| WebFetch da mesma URL em sessões diferentes (já comum: docs do react, MDN) | Hoje vai para `toolResultStorage` com `toolUseId` novo cada vez = N cópias | 20–500 KB por fetch |
| Compaction que reemite o mesmo blob (Read de arquivo grande aparece pré e pós compact) | `toolResultStorage` já é idempotente por `toolUseId` (l.196 `wx` flag), mas compaction gera *novo* id → reescreve | 50–600 KB |
| `/resume` de session com Bash retomado | omp tem; Claudin também (não precisa CAS para isto, `toolUseId` já basta) | — |
| File-history: edits sucessivos do mesmo arquivo onde só 5 linhas mudam | Hoje grava arquivo inteiro versionado; CAS de chunks ou hash do conteúdo total **não** ajuda, precisa rolling hash / chunking | até 45 MB/repo |

**Ganho real esperado**: o vetor com payoff é **imagens** (caso omp), não
tool-results de texto. Hoje Claudin não tem caso de imagem heavy (não vi nenhum
`.png` em `~/.claudin` fora dos plugins do marketplace), mas se o roadmap inclui
anexos visuais (já há suporte de paste de imagem), inline base64 no JSONL escala
mal: uma imagem de 500 KB anexada e rementida em 6 turnos = 3 MB no transcript.

## 4. Onde NÃO ganha (e o overhead aparece)

- Output único por sessão (todo Bash de comando `git status`, `ls`, etc):
  hash custa CPU, ganho zero. Threshold mínimo é obrigatório.
- Texto < 1 KB: header `sha256:<64 hex>` + path = ~80 B; hash + I/O custa
  microssegundos × N invocações. omp usa 1 024 B como gate (insight 5, deep
  doc).
- Conteúdo sensível (secrets em env, .env lidos por Read): dedup global
  vaza entre projetos — `~/.claudin/projects/A` lê `.env`, blob fica em store
  global, projeto `B` consegue `has(hash)` se adivinhar conteúdo. omp aceita
  isso porque blob store é per-user; Claudin precisaria escopar por projeto.
- Tool results compactos cuja preview já mora no contexto: `toolResultStorage`
  hoje só persiste se `> 50 KB` (`DEFAULT_MAX_RESULT_SIZE_CHARS`). Quase tudo
  abaixo desse threshold nunca chega ao disco.
- File-history: a unidade lá é versão de arquivo inteiro; dedup precisa de
  chunking (rsync-style) ou xdelta. CAS plano não resolve.

## 5. Riscos reais

1. **GC errado deleta blob ainda referenciado.** omp evita GC inteiramente
   (never-delete + 30d sweep). Se Claudin implementar refcount via grep nos
   JSONLs, mudança no formato do transcript quebra o sweep. Mark-sweep contra
   `MEMORY.md` + transcripts é correto mas caro (varrer todos os projects toda
   semana).
2. **Corrupção meio-write.** omp usa `Bun.write` async e `fs.writeFileSync`
   sync; nenhum dos dois faz rename atômico. Crash entre `open()` e `close()` =
   blob parcial com hash certo no path mas bytes incompletos. Mitigação trivial
   (write a `.tmp` + rename) que omp não tem.
3. **Cross-project leakage.** omp é **global** por usuário (`~/.omp/blobs/`).
   Confirmado em `packages/coding-agent/src/session/blob-store.ts:21-22` (dir
   recebido no constructor, mas o caller global, ver `docs/blob-artifact-architecture.md`
   linhas 21-33). Claudin convencionou per-project (`~/.claudin/projects/<dir>/`).
   Adotar CAS global quebra a expectativa: blob de `aargau` visível a partir de
   um terminal aberto em `claudin`. Solução: blob store **per-project**
   (`~/.claudin/projects/<dir>/blobs/`), o que reduz a janela de dedup mas
   preserva o isolamento atual.
4. **Ownership/permissions.** `paste-cache` hoje tem `0600` em cada arquivo;
   `tool-results` tem `0644` (default `umask`). CAS adotando 0644 expõe
   blobs sensíveis em multi-user host. Não é regressão (já está exposto via
   tool-results), mas é hora de uniformizar.
5. **Hash collision: não-risco.** SHA-256 ~2^128 ops para colisão.

## 6. Encaixe com `toolResultStorage` atual

Opções:

**(a) Substituir** — `toolResultStorage` para de usar `toolUseId` e passa a
hash o conteúdo. Custo: rerefenciar leituras (`getToolResultPath(toolUseId)` é
chamado pelo replayer de compaction); `<persisted-output>` precisa virar
`<persisted-output ref="sha256:...">`. Tem que migrar files existentes ou
manter dual-read forever. Ganho real: 250 KB hoje. **Não vale.**

**(b) Complementar (camada nova)** — manter `toolResultStorage` como é (chave
por `toolUseId`, simples, funciona), introduzir `BlobStore` só para o vetor
de imagens / anexos quando começarem a aparecer no JSONL. O `paste-cache`
basicamente já faz isso para texto; o que falta é o equivalente para binário,
nos moldes de `externalizeImageDataUrl` do omp.

**(c) Não fazer nada** — `paste-cache` cobre texto colado, `toolResultStorage`
cobre tool outputs, `file-history` cobre snapshots. Os 348 MB observados não
vêm de duplicação evitável; vêm de transcripts grandes (que CAS plano não
resolve) e file-history versionado (que precisa chunking, não hash de
conteúdo inteiro).

Arquivos que mudariam num dual-read da opção (b), só para registro:

- `src/utils/pasteStore.ts` — extrair `BlobStore` genérico, paste continua
  consumindo a abstração.
- Novo: persistor de imagens anexadas (hoje passa direto no
  message content, sem cache). Ponto de entrada: o code path que monta
  `image_url`/`image` blocks no input do usuário.
- `src/utils/cleanup.ts` — sweep do novo dir.
- `src/commands/clear/caches.ts` — adicionar o dir aos comandos `/clear`.

Nada toca `toolResultStorage.ts` ou compaction. Risco baixo, escopo minúsculo.

## 7. Veredito

Ganho percentual estimado de disco se adotarmos CAS do jeito omp **hoje**:

- Sobre `~/.claudin/projects/` (348 MB): < 0.1 % (250 KB de tool-result dup).
- Sobre `~/.claudin/file-history/` (45 MB): 0 % (CAS plano não dedup chunks).
- Sobre transcripts JSONL grandes (5–9 MB cada): 0 % (não há repetição
  binária entre eles hoje).

**Se** o roadmap incluir anexos de imagem recorrentes (paste de screenshot,
PDFs renderizados, multimodalidade), o ganho potencial em 6 meses é da ordem
de dezenas de MB a poucas centenas de MB por usuário ativo — equivalente
ao que omp economiza hoje na própria base. Sem esse driver, CAS é otimização
sem problema.

Vale a pena: **CONDICIONAL — porque o ganho mensurável hoje (~250 KB / 0.07 %
de `projects/`) não justifica tocar `toolResultStorage`, que já funciona via
`toolUseId` idempotente. Mas se entrar fluxo de imagens/anexos binários no
roadmap, vale extrair a primitiva `BlobStore` a partir do `pasteStore`
existente e usá-la *só* para externalizar binários do JSONL — exatamente o
caso para o qual omp criou o `BlobStore` (não para tool outputs de texto).
Manter per-project, nunca global.**
