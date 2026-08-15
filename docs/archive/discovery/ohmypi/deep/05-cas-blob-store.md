# 05 — Content-addressed blob store (deep dive)

## Resumo executivo

omp tem um `BlobStore` simples, global por usuário, endereçado por SHA-256 do
conteúdo cru. Ele é usado hoje só para **uma coisa**: externalizar imagens
(`data:image/...;base64,...` e blocos `image`) de dentro dos JSONLs de sessão.
Texto de tool output é tratado por um sistema **separado**, `ArtifactManager`,
que é session-local e usa IDs numéricos. As duas camadas existem de propósito —
blob otimiza dedupe global, artifact otimiza retrieval por ID estável dentro da
sessão.

Claudin hoje **não tem nada content-addressed**. Tool results grandes são
salvos em `~/.claudin/projects/<dir>/<sessionId>/tool-results/<toolUseId>.<ext>`
(sem hash, sem dedupe). Mesma leitura de arquivo em duas sessões = duas cópias.
Cleanup é puramente time-based (30 dias por padrão), não refcount.

A proposta abaixo importa o **menor** que precisamos do omp (interface simples
`put/get/has` + hex hash + layout fanout-2) e mantém o resto deferido até termos
métricas reais de dedupe. Não é uma reescrita do `toolResultStorage`; é uma
camada de armazenamento que o `toolResultStorage` passa a chamar.

## Implementação omp

Arquivo: `packages/coding-agent/src/session/blob-store.ts` (note: o path no
insight raso estava desatualizado — `packages/agent` foi renomeado para
`packages/coding-agent`).

### API pública

```ts
// blob-store.ts:21–85
class BlobStore {
  constructor(readonly dir: string) {}
  put(data: Buffer): Promise<BlobPutResult>     // async, Bun.write
  putSync(data: Buffer): BlobPutResult          // sync, fs.writeFileSync
  get(hash: string): Promise<Buffer | null>     // null em ENOENT
  has(hash: string): Promise<boolean>           // fsp.access
}

interface BlobPutResult {
  hash: string                                  // sha256 hex
  path: string                                  // <dir>/<hash>
  get ref(): string                             // "blob:sha256:<hash>"
}
```

Não tem `delete`, não tem GC, não tem refcount, não tem TTL. O store é
puramente append-friendly: mesmo conteúdo gera o mesmo path, write é
idempotente, never-delete é assumido.

### Algoritmo de hash

`new Bun.SHA256().update(data).digest("hex")` (`blob-store.ts:29` e `:49`).
SHA-256 hex (64 chars). Não tem opção de blake3 nem de truncar.

### Layout em disco

Um único diretório flat: `<blobsDir>/<sha256-hex>` sem extensão
(`blob-store.ts:30`, `:50`). `<blobsDir>` é o que `getBlobsDir()` devolver —
documentado em `docs/blob-artifact-architecture.md:21` como um diretório global
compartilhado entre todas as sessões do usuário.

**Sem fanout** (`ab/cdef...`). Diretório único com N arquivos. Funciona porque
ext4/btrfs/APFS aguentam dezenas de milhares de entradas sem degradar — mas é
uma escolha de simplicidade, não de escala. Se o N crescer muito, vira problema
para `ls`.

### Refcount / GC

**Nenhum.** O doc é explícito: "blobs can outlive any individual session file"
(`blob-artifact-architecture.md:33`). Resume/fork/move **não** copiam ou movem
blobs (`blob-artifact-architecture.md:196–197`: "blobs are global and
content-addressed, so no blob directory copy is required").

Quando um blob fica órfão (única sessão que o referenciava foi deletada), ele
permanece em disco para sempre. Não há mark-sweep, não há refcount em
metadata. O custo é tolerado porque:

1. dedupe entre sessões reduz o churn,
2. imagens são o único caso atual, e imagens repetem muito (screenshots, ícones).

### Tamanho mínimo

`BLOB_EXTERNALIZE_THRESHOLD = 1024` bytes (citado em
`blob-artifact-architecture.md:86`). Strings menores que ~1KB não viram blob —
ficam inline no JSONL. Justificativa implícita: o overhead de um hash+filepath
+ rehydrate stat passa do custo de 1KB no JSON.

### Encoding

**Bytes crus.** Sem zstd, sem gzip, sem encoding wrap. `Bun.write(blobPath,
data)` direto.

- Imagens binárias: `Buffer.from(base64Data, "base64")` → bytes binários
  (`blob-store.ts:125`).
- Data URLs (`data:image/png;base64,...`): a string UTF-8 inteira do data URL
  é gravada como bytes (`blob-store.ts:109`). Faz isso porque a rehydration
  precisa restaurar o transport-format exato que o provider exige.

Dedupe via hash funciona porque conteúdo idêntico → hash idêntico, mesmo sem
compressão.

### Como referencia blobs em transcripts

Substituição inline dentro do entry JSON. Não é um envelope JSON estruturado
(`{$blob: "..."}`); é uma string com prefixo `blob:sha256:<hex>` no slot onde
estaria a base64 ou o data URL (`blob-store.ts:6`):

```ts
const BLOB_PREFIX = "blob:sha256:";
```

Helpers:

- `isBlobRef(s)` — `s.startsWith("blob:sha256:")` (`blob-store.ts:88`).
- `parseBlobRef(s)` — extrai hash (`blob-store.ts:93`).
- `externalizeImageData / externalizeImageDataUrl` — substituem inline
  (`blob-store.ts:107, 123` + variantes `*Sync`).
- `resolveImageData / resolveImageDataUrl` — lêem o blob e voltam ao formato
  original na carga da sessão (`blob-store.ts:141, 158`). Se o blob sumiu:
  `logger.warn` e retorna a ref **as-is** (`blob-store.ts:147, 165`). Nunca
  crasha o resume.

O pipeline persistência → rehidratação:

1. `prepareEntryForPersistence` (citado em `blob-artifact-architecture.md:79`)
   roda antes do write do JSONL: troca `data: <base64>` por
   `data: "blob:sha256:..."`.
2. Ao carregar, `resolveBlobRefsInEntries`
   (`blob-artifact-architecture.md:96`) varre os entries e re-injeta os bytes
   in-memory.

JSONL persistido fica compacto; runtime vê dados completos.

## Estado atual Claudin

### O que existe

`src/services/tools/toolResultStorage.ts:171 persistToolResult()` — única função de
persistência de tool result no projeto.

Comportamento concreto:

- **Trigger** (`toolResultStorage.ts:342–348`): quando `contentSize(block) >
  threshold`. Threshold vem de `getPersistenceThreshold(toolName,
  declaredMax)` (`toolResultStorage.ts:59`) que aplica
  `Math.min(declared, DEFAULT_MAX_RESULT_SIZE_CHARS)`, com
  `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`
  (`src/constants/toolLimits.ts:13`).
- **Path** (`toolResultStorage.ts:118`):
  `~/.claudin/projects/<dir>/<sessionId>/tool-results/<toolUseId>.<ext>`
  com ext = `txt` para string, `json` para array de blocks.
- **Naming** (`toolResultStorage.ts:188, 196`): chave é o `toolUseId` —
  UUID gerado por turn, garantido único por invocação. Write é `wx` (fail on
  EEXIST), mas `EEXIST` é silenciosamente aceito porque microcompact pode
  replayar a mesma persistência.
- **Mensagem que o modelo vê**
  (`toolResultStorage.ts:223 buildLargeToolResultMessage`):
  `<persisted-output>\n Output too large (...). Full output saved to:
  <filepath>\n\nPreview (first 2000 bytes):\n<preview>\n...\n</persisted-output>`.
  Preview é os primeiros ~2KB cortados em newline boundary
  (`toolResultStorage.ts:375 generatePreview`).
- **Lifetime**: arquivo permanece até cleanup time-based em
  `src/shared/cleanup.ts:155 cleanupOldSessionFiles` (default
  `cleanupPeriodDays`, geralmente 30 dias). `/clear` chama
  `unlinkSessionSpillDir(oldSessionId)` (`toolResultStorage.ts:146`) para o
  diretório inteiro da sessão antiga.

### O que **não** existe

- Nenhum hash de conteúdo em nada que persiste tool output. `imageStore.ts` e
  `mcpOutputStorage.ts` também não usam SHA — confirmado por grep.
- Nenhum dedupe entre sessões. Sessão A leu `package.json` → 200KB salvos em
  `<A>/tool-results/<id1>.txt`. Sessão B leu o mesmo `package.json` → outros
  200KB em `<B>/tool-results/<id2>.txt`.
- Nenhum dedupe **dentro** da mesma sessão. Se o agente lê o mesmo arquivo
  grande duas vezes (`Read` com offsets diferentes que se sobrepõem),
  cada call gera arquivo separado.
- Imagens (`src/terminal/image/imageStore.ts`) não usam content-addressing — verifiquei
  acima, sem `createHash` no arquivo.

### Compaction: o que sobrevive entre turnos

`src/services/compact/postCompactCleanup.ts:42 runPostCompactCleanup`:

- Reseta caches in-memory (`microcompactState`, prompt cache break detection,
  session ingress, diagnostic tracker, skipped timestamps).
- Reconstrói `ContentReplacementState`
  (`postCompactCleanup.ts:63`) — release de entries para mensagens que sumiram.
- **Não toca** em `tool-results/`. Arquivos `.txt`/`.json` persistidos por
  `persistToolResult()` sobrevivem a `/compact`, microcompact, e a qualquer
  rewind dentro da sessão. Eles só somem em:
  - `/clear` (`unlinkSessionSpillDir`),
  - cleanup time-based (`cleanupOldSessionFiles`, default 30 dias).

Isso significa que a referência `<persisted-output>...Full output saved to:
<filepath>...</persisted-output>` que ficou na transcript continua resolvível
depois do compact — o modelo pode pedir um `Read` desse path e funciona.
**Este é o ganho real que CAS preservaria/melhoraria.**

### Tamanho típico de blobs (estimativa de campo)

Pela threshold de 50KB, só candidatos a CAS seriam outputs acima disso. Em
ordem decrescente de frequência observada nas sessões reais (heurística — não
medi com profiler):

- `Bash` em comandos verbosos (test runners, `npm install` log, `git log
  --stat -p`): tipicamente 50KB–500KB (o filter já corta ruído, mas grandes
  saídas estruturadas passam).
- `Read` de arquivos grandes (TSX gigantes, JSON de schema, lockfiles):
  100KB–2MB. `bun.lock` ~ 500KB, `package-lock.json` em mono-repos passa de
  1MB.
- `Grep` com `-A`/`-B` em context-heavy patterns: 50–200KB.
- `WebFetch` de páginas convertidas a Markdown: 30–300KB.

Conteúdo **alta-dedupe**: lockfiles, schemas, MEMORY.md, arquivos de config
referenciados em N sessions. Conteúdo **baixa-dedupe**: bash output (timestamps,
PIDs, paths absolutos), test runs.

## Proposta de migração

### Camada nova: `src/utils/blobStore.ts`

API mínima espelhando omp, em TS puro (sem Bun-only):

```ts
import { createHash } from 'node:crypto'

export interface BlobPutResult {
  hash: string                                  // hex
  ref: string                                   // "blob:sha256:<hash>"
  path: string                                  // absolute
  alreadyExisted: boolean                       // útil para métricas de dedupe
}

export class BlobStore {
  constructor(private readonly dir: string) {}
  put(content: Buffer | string): Promise<BlobPutResult>
  get(hash: string): Promise<Buffer | null>
  has(hash: string): Promise<boolean>
  // Sem delete público — só GC interno.
}
```

`toolResultStorage.ts` passa a chamar `blobStore.put()` em vez de
`writeFile(filepath, ...)`. A mensagem `<persisted-output>` continua sendo o
contrato com o modelo, só muda o que aparece em "Full output saved to":

```
Full output saved to: blob:sha256:abc123...  (or read at: ~/.claudin/.../blobs/ab/c123...)
```

Ou — mais conservador — mantemos o filepath absoluto na mensagem (modelo já
sabe usar isso com `Read`), e o `ref` só é usado internamente para dedupe e
para a transcript persistida.

### Layout em disco

```
~/.claudin/projects/<dir>/blobs/<hash[:2]>/<hash[2:]>
```

**Fanout-2** (256 subdirs), diferente do omp que é flat. Razão: Claudin pode
acumular significativamente mais blobs (Bash + Read + Grep + WebFetch é muito
mais volume que só imagens), e flat com 100k+ arquivos degrada `readdir` em
ext4. Fanout-2 mantém ~400 arquivos por dir num cenário de 100k blobs.

Escopo `<projectDir>` (não global por usuário como omp) porque:

- Privacidade: dados de um projeto não vazam para outro via cross-session
  dedupe.
- Cleanup mais fácil: apagar `~/.claudin/projects/<dir>/` (já suportado) leva
  os blobs junto.
- Trade-off: perde-se dedupe entre projetos (ex: mesmo node_modules em dois
  worktrees). Aceitável — projetos diferentes geralmente têm conteúdo
  diferente.

### Escolha de hash: SHA-256

Recomendo manter **SHA-256** apesar da pergunta no insight raso. Razões:

- `node:crypto` já está no bundle (zero novas deps); blake3 exige pacote
  externo (`blake3` ou `@noble/hashes`).
- SHA-256 de 50KB–2MB num laptop moderno são microssegundos, não milissegundos.
  Não é hot path — só roda quando passa do threshold (`>50KB`), que acontece
  algumas vezes por minuto no pior caso.
- Universal: ref `blob:sha256:<hex>` é interoperável com omp (mesmo prefixo
  exatamente), o que facilita uma futura ponte de import/export.
- 64 chars hex no path são feios mas legíveis. blake3 não economiza nada de
  prático aqui.

Truncar para 32 hex chars (128 bits) seria seguro contra colisão acidental e
metade do espaço em disco no path. **Não recomendo** truncar — o ganho é
ínfimo e quebra interoperabilidade com qualquer ferramenta que assume
sha256-full.

### GC strategy: mark-sweep periódico, **não** refcount em SQLite

Refcount em SQLite seria correto teoricamente mas:

- Adiciona uma dependência (`better-sqlite3`/`bun:sqlite`) ao caminho crítico
  de cada `persistToolResult`.
- Atomicidade entre "write blob" + "incrementa refcount" exige WAL/transação,
  que é um vetor inteiro de bugs novos (orfan refs por crash entre os dois
  passos).
- Recovery (e.g. depois de `kill -9` durante write) precisa varredura. Aí já
  estamos fazendo mark-sweep de qualquer jeito.

**Mark-sweep periódico** é mais simples e mais robusto:

1. Trigger: `cleanupOldSessionFiles` em `src/shared/cleanup.ts` já roda em
   background no startup. Adicionar uma fase nova depois da limpeza de sessões
   antigas.
2. Mark: varre todos os JSONL de sessão sobreviventes em
   `~/.claudin/projects/<dir>/`, regex para `blob:sha256:[0-9a-f]{64}`, coleta
   em `Set<string>`.
3. Sweep: lista `~/.claudin/projects/<dir>/blobs/**/*`, se hash não está no
   set **e** `mtime > 24h` (margem para sessions ativas que ainda não fizeram
   flush para JSONL), unlink.
4. Logar `tengu_blob_gc_swept` com bytes liberados.

Vantagem: zero state. Desvantagem: O(N) onde N = total de blobs no projeto.
Como o cleanup já é "rodar uma vez por sessão de claudin", não é problema.

### Tamanho mínimo

Manter o **threshold de 50KB** atual (`DEFAULT_MAX_RESULT_SIZE_CHARS`) para
quando entra no blob store. Ele já existe e é validado. O `BLOB_EXTERNALIZE_THRESHOLD`
de 1KB do omp faz sentido para imagens (qualquer imagem útil > 1KB), mas para
tool output em texto 1KB é muito pequeno — o overhead do `<persisted-output>`
envelope (~150 bytes) + path + preview já são ~500 bytes, ratio ruim.

### Migração: leitor dual

Por **2 minor versions** (ex: v0.5.x e v0.6.x):

1. Write path: tudo novo vai para CAS (`<dir>/blobs/<hash[:2]>/<rest>`).
2. Read path: quando o modelo pede `Read <path>` num path antigo
   (`<dir>/<sessionId>/tool-results/<id>.txt`), o `FileReadTool` resolve
   normalmente — não precisamos de migração ativa.
3. Cleanup time-based continua expirando o `tool-results/` legado naturalmente.
4. Para refs **dentro** de JSONL persistido (se vamos adotar o formato
   `blob:sha256:` em transcripts), o resolver precisa aceitar tanto a ref
   nova quanto strings antigas que apontam para filepath. Adicionar
   `isBlobRef(s)` análogo ao omp.

Não precisa de script de migração one-shot. Em ~30 dias o último arquivo de
`tool-results/` antigo expira e a estrutura nova é a única que sobra.

### Sequência de adoção sugerida

1. Introduzir `BlobStore` em `src/utils/blobStore.ts` + testes.
2. Cabear `persistToolResult` para escrever em CAS, mas continuar emitindo
   filepath absoluto na mensagem (zero mudança no contrato com o modelo).
3. Adicionar fase de mark-sweep em `cleanup.ts`. Métricas: blobs total,
   blobs órfãos, bytes recuperados.
4. (Opcional, depois de dados de campo) Mudar mensagem para incluir
   `blob:sha256:` ref se houver UX claro para reuso entre turnos.
5. (Mais tarde, se imagens migrarem) `src/terminal/image/imageStore.ts` adota o mesmo
   blob store. Ganho de dedupe real para screenshots repetidos.

## Riscos

### Corrupção

Cenário: write parcial (disco cheio no meio da gravação, kernel panic, kill
durante `writeFile`). Resultado: arquivo com hash X tem conteúdo ≠ X. Próximo
`get(X)` devolve bytes errados, ninguém detecta.

Mitigação:

- Write atômico: gravar em `<dir>/blobs/<ab>/<rest>.tmp.<random>`, `fsync`,
  `rename` para o destino final. `rename` é atômico em POSIX. Análogo ao que
  `cas` do git faz com objects.
- Verificação opcional em `get()`: recalcular hash quando GC roda, marcar
  blobs corrompidos como órfãos para sweep.

omp **não** faz nenhuma das duas (`Bun.write` direto). Aceitável para imagens
porque o impacto de uma imagem corrompida é uma única imagem ruim numa sessão
antiga. Para tool output em texto, é mais sério — o modelo pode citar dados
falsificados sem perceber.

### Race em writes concorrentes

Dois processos `claudin` (duas sessões abertas no mesmo projeto) gravam o mesmo
hash simultaneamente. Ambos escrevem o mesmo path.

Análise:

- Se ambos escrevem **o mesmo conteúdo** (hash igual → conteúdo igual por
  definição), o resultado final é correto, qualquer write "vence".
- Race window: leitor que abre o arquivo no meio do segundo write pode ler
  partial. Improvável (writes pequenos, leituras só ocorrem turnos depois)
  mas possível.

Mitigação: padrão `*.tmp` + `rename` resolve completamente — `rename` é a
operação de commit, leitor sempre vê o arquivo completo ou nada.

Não precisa de file locking; o próprio CAS é idempotente.

### Disk full

Mark-sweep mitiga acúmulo mas não impede um único turn gigante (e.g. WebFetch
de 50MB) de encher um SSD pequeno num CI worker.

Mitigações sugeridas:

- Cap superior de tamanho por blob: se `content.size > 10MB`, recusar e cair
  no comportamento atual (truncate + preview), ou armazenar com extensão
  `.large` e GC mais agressivo (e.g. 7 dias em vez de 30).
- Settings: expor `blobStoreMaxBytes` em `~/.claudin/settings.json`. Quando o
  total ultrapassa, o sweep deleta os blobs com `mtime` mais antigo (LRU
  approximada).
- Verificar `statfs` antes de write — se < 100MB livres, recusar e logar
  `tengu_blob_disk_pressure`. Não bloqueia o turn (fallback para truncate).

### Privacy

CAS guarda payloads exatos das tools. Arquivos com segredos (`.env`,
`credentials.json`, OAuth tokens lidos por engano) podem ficar em
`~/.claudin/.../blobs/` por 30 dias. Comportamento idêntico ao atual
`tool-results/`, mas com path menos óbvio. **Não é uma regressão**, mas vale
documentar no `README` da pasta.

### Hash colision (não-risco)

SHA-256 prático: 2^128 operations para colisão. Não é vetor.

## Referências de código

### oh-my-pi

- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/blob-store.ts:6` —
  prefixo `blob:sha256:`.
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/blob-store.ts:21–85` —
  classe `BlobStore`.
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/blob-store.ts:107–134` —
  externalize helpers.
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/blob-store.ts:141–168` —
  resolve helpers (fallback warn em miss).
- `/home/dev/projects/oh-my-pi/docs/blob-artifact-architecture.md:21–33` —
  boundary global e implicações.
- `/home/dev/projects/oh-my-pi/docs/blob-artifact-architecture.md:79–92` —
  dataflow de persistência (threshold de 1024 bytes).
- `/home/dev/projects/oh-my-pi/docs/blob-artifact-architecture.md:94–109` —
  rehydration on load.

### claudin

- `/home/dev/projects/claudin/src/services/tools/toolResultStorage.ts:118` —
  layout atual de tool-results.
- `/home/dev/projects/claudin/src/services/tools/toolResultStorage.ts:146` —
  `unlinkSessionSpillDir` (deletado no `/clear`).
- `/home/dev/projects/claudin/src/services/tools/toolResultStorage.ts:171` —
  `persistToolResult`.
- `/home/dev/projects/claudin/src/services/tools/toolResultStorage.ts:223` —
  formato `<persisted-output>` que o modelo vê.
- `/home/dev/projects/claudin/src/services/tools/toolResultStorage.ts:308–369` —
  trigger por threshold.
- `/home/dev/projects/claudin/src/constants/toolLimits.ts:13` —
  `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`.
- `/home/dev/projects/claudin/src/shared/cleanup.ts:155` —
  `cleanupOldSessionFiles` (time-based, 30d default).
- `/home/dev/projects/claudin/src/shared/cleanup.ts:196–203` —
  varre tool-results dentro de session dirs.
- `/home/dev/projects/claudin/src/services/compact/postCompactCleanup.ts:42` —
  `runPostCompactCleanup` (não toca em tool-results).
- `/home/dev/projects/claudin/src/services/compact/postCompactCleanup.ts:159–165` —
  comentário explícito: arquivos persistidos sobrevivem ao compact.
