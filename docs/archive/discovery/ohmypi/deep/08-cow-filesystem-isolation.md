# 08 (deep) — COW filesystem isolation para worktrees

## Resumo executivo

`omp` carrega um PAL (Platform Abstraction Layer) em Rust chamado `pi-iso` que
materializa, em milissegundos, uma view gravável de uma árvore de origem
read-only. Em vez de pagar `git checkout`, ele usa o primitivo de COW do FS
hospedeiro (APFS `clonefile`, FICLONE/`btrfs subvolume snapshot`/ZFS, overlayfs,
Windows block clone/ProjFS) e cai para uma cópia recursiva (`Rcopy`) como
fallback universal. Isso é exposto ao TS por `@oh-my-pi/pi-natives`
(`isoResolve`, `isoStart`, `isoStop`, `isoDiff`).

Claudin hoje usa `git worktree add` + hooks `WorktreeCreate`/`WorktreeRemove`
opcionais. O custo de spawn é dominado pelo `checkout` (escrita do working
tree) — barato em repos pequenos e cache quente, mas começa a doer com vários
sub-agents simultâneos ou repos grandes (`dist/`, `node_modules`, V8 caches).

A oportunidade concreta para Claudin não é "substituir" o git worktree, e sim
adicionar um **caminho COW opt-in** para sub-agents paralelos onde branch
git/PR workflow não importa.

---

## omp: como `pi-iso` funciona

Crate Rust `crates/pi-iso/` (`/home/dev/projects/oh-my-pi/crates/pi-iso/`):

- `Cargo.toml:13-25` — só depende de `async-trait`, `similar`, `tokio`, `libc`
  (unix), `windows-sys` (windows). Sem chamadas externas.
- `src/lib.rs:47-66` — enum `BackendKind` com 8 backends:
  `Apfs`, `Btrfs`, `Zfs`, `LinuxReflink`, `Overlayfs`, `WindowsBlockClone`,
  `Projfs`, `Rcopy`.
- `src/lib.rs:106-123` `BackendKind::native()` — escolha por target:
  macOS → `Apfs`, Linux → `Overlayfs`, Windows → `Projfs`, outro → `Rcopy`.
- `src/lib.rs:127-140` ordens automáticas por plataforma. Em Linux:
  `[Btrfs, Zfs, LinuxReflink, Overlayfs, Rcopy]`.
- `src/lib.rs:225-246` trait `IsolationBackend` com `probe()`, `start()`,
  `stop()`, `diff()`. `diff` é o ponto unificado: quando `merged` é git,
  delega para `git diff`; senão walk com `(size, mtime)` (`src/lib.rs:1-19`).
- `src/lib.rs:338-373` `resolve(preferred)` — devolve `Resolution { kind,
  candidates, fell_back, reason }` para o caller iterar nos candidatos.
- `src/apfs.rs:77-113` — wrapper sobre `libc::clonefile(src, dst, 0)`.
  Caminho feliz: 1 syscall. Falha com `ENOTSUP/EOPNOTSUPP/EXDEV` é mapeada
  para `IsoError::Unavailable` (o caller cai para o próximo backend).
- `src/linux_reflink.rs:1-9` — anda recursivamente recriando dirs/symlinks e
  cloando arquivos regulares com `FICLONE` ioctl (btrfs/XFS+reflink/bcachefs).

Shim NAPI (`crates/pi-natives/src/iso.rs`):

- `iso.rs:30-40` — enum numérico `IsoBackendKind` (0..=7) — JS dá `switch`
  sem strcmp.
- `iso.rs:93-127` `iso_backend()`, `iso_probe()`, `iso_resolve()`.
- `iso.rs:131-151` `iso_start(kind?, lower, merged)`, `iso_stop(...)` em
  `spawn_blocking` para virar Promise.
- `iso.rs:25` + `iso.rs:176-180` — `IsoError::Unavailable` vira mensagem
  com prefixo `ISO_UNAVAILABLE:` e o JS tem `iso_is_unavailable_error()`
  para reconhecer e iterar nos candidates.

Uso pelo coding-agent (`packages/coding-agent/src/task/worktree.ts`):

- `worktree.ts:238-285` `TaskIsolationMode` (`none|auto|apfs|btrfs|zfs|reflink|
  overlayfs|projfs|block-clone|rcopy` + legados `worktree|fuse-overlay|
  fuse-projfs`) e `parseIsolationMode` que mapeia o nome amigável para a hint
  do PAL.
- `worktree.ts:287-296` `IsolationHandle` (`mergedDir`, `backend`,
  `fellBack`, `fallbackReason`).
- `worktree.ts:309-343` `ensureIsolation(baseCwd, id, preferred?)` — chama
  `natives.isoResolve(preferred)`, itera nos `candidates` e em cada um tenta
  `isoStart`. Em falha `ISO_UNAVAILABLE:` segue para o próximo; em outra
  classe de erro re-throw. Devolve handle com o backend efetivamente usado.
- `worktree.ts:346-350` `cleanupIsolation(handle)` chama `isoStop`.
- O fluxo de diff/merge a montante (`captureBaseline`, `captureDeltaPatch`,
  `applyNestedPatches`) é construído em cima do clone: cada task isolada
  produz patch reproduzível que é replayado no repo principal.

---

## Claudin: EnterWorktreeTool atual

- `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-127` — fluxo:
  1. recusa se já há sessão worktree;
  2. resolve canonical git root (`findCanonicalGitRoot`, `:84-88`);
  3. delega para `createWorktreeForSession(sessionId, slug)` (`:92`);
  4. `process.chdir` + `setCwd` + `setOriginalCwd`;
  5. limpa caches dependentes de CWD: `clearSystemPromptSections`,
     `clearMemoryFileCaches`, `getPlansDirectory.cache.clear` (`:98-102`).
- `src/vcs/git/worktree.ts:744-820` `createWorktreeForSession`:
  - `:757-770` — se `hasWorktreeCreateHook()`, chama o hook configurado pelo
    usuário e adota o resultado (`hookBased: true`). Esse é o gancho de
    extensibilidade já existente.
  - `:771-810` — caminho default: `getOrCreateWorktree(gitRoot, slug)`
    (interno, faz `git worktree add` + setup) + `performPostCreationSetup`,
    com medição em `creationDurationMs`.
- Hook surface: `src/platform/lifecycleHooks/events.ts:578-631` define
  `hasWorktreeCreateHook()`/`executeWorktreeCreateHook()`. O `WorktreeCreate`
  já é tratado de forma especial no executor (`src/platform/lifecycleHooks/executors.ts:244-378`)
  porque o `output` é interpretado como caminho do worktree.

Medição rápida no próprio repo (cache quente, btrfs):

```
$ time git worktree add /tmp/claudin-test-wt HEAD
real    0m0.124s
$ time cp --reflink=auto -r . /tmp/claudin-reflink-test  # 636 MB com dist/
real    0m5.610s
```

Observações:
- Em repo médio com cache quente, `git worktree add HEAD` ganha do
  `cp --reflink` porque escreve só o working tree (e reusa o object DB).
- O cenário onde COW puro ganha é quando `lower` **inclui builds, caches,
  node_modules, dist/** — coisas que `git worktree add` não copia (não estão
  tracked), mas que o sub-agent quer no isolamento. Aí o git worktree força
  você a refazer `bun install`/`bun run build` por worktree, que custa
  segundos a minutos.

---

## Proposta

Duas formas, não exclusivas:

### Forma A (mínima, recomendada primeiro) — Pre-step COW antes do `git worktree`

Adicionar ao `createWorktreeForSession` um caminho opt-in que, **antes** de
escolher git worktree vs hook, tenta criar a árvore via COW e depois roda
`git worktree add --no-checkout` apontando para esse diretório, fazendo o
checkout virar no-op. Ganho: o `dist/`, `node_modules`, `.claudin/v8cache/`
viajam de graça via reflink/clonefile.

Trade-off: continua sendo um worktree git de verdade, branch existe, PR
workflow intacto. É um speedup, não uma substituição.

### Forma B (mais ambiciosa) — Backend de isolamento alternativo via hook

Reusar o já existente `WorktreeCreate` hook como ponto de extensão: um hook
"cow-isolate" que faz `cp --reflink=always` no Linux ou `cp -c` no macOS, e
devolve o path. O `EnterWorktreeTool` não muda; tudo passa pelo hook.
Custo: branch git é perdido nesse caminho — útil só para sub-agents.

A Forma B já tem precedente: `worktree.ts:769` marca `hookBased: true`, então
o teardown deve respeitar que não há branch para podar.

---

## Detecção de capability sem Rust

Bun tem `bun:ffi`. Mas a forma pragmática é não usar FFI nenhuma: confiar
em `cp` (coreutils ≥ 7.5 tem `--reflink`) e `clonefile` via `/bin/cp -c`
no macOS (BSD `cp` aceita `-c` desde macOS 10.13).

Snippet conceitual (não implementar, só ilustração):

```typescript
import { spawn } from 'node:child_process'
import { statfs } from 'node:fs/promises'   // node 18.15+ tem statfs

type CowKind = 'apfs-clonefile' | 'linux-reflink' | 'none'

// Module-level regex per as regras do projeto
const REFLINK_FS = new Set([
  'btrfs', 'xfs', 'bcachefs', 'zfs', 'ocfs2', 'apfs',
])

async function detectCow(path: string): Promise<CowKind> {
  if (process.platform === 'darwin') {
    // APFS é o default desde macOS 10.13; assumir disponível e testar com
    // dry-run de `cp -c` em /tmp seria o probe defensivo.
    return 'apfs-clonefile'
  }
  if (process.platform !== 'linux') return 'none'
  try {
    // node:fs/promises statfs devolve { type, bsize, ... } onde type é
    // o magic number; mais portável é parsear /proc/mounts e mapear o
    // mountpoint do path → fstype.
    const s = await statfs(path)
    // 0x9123683E = BTRFS_SUPER_MAGIC, 0x58465342 = XFS_SUPER_MAGIC, etc.
    const magicToFs: Record<number, string> = {
      0x9123683e: 'btrfs',
      0x58465342: 'xfs',
      0xca451a4e: 'bcachefs',
    }
    const fs = magicToFs[s.type]
    return fs && REFLINK_FS.has(fs) ? 'linux-reflink' : 'none'
  } catch {
    return 'none'
  }
}

async function tryCowClone(src: string, dst: string): Promise<boolean> {
  const flag = process.platform === 'darwin' ? '-c' : '--reflink=always'
  const proc = spawn('cp', [flag, '-a', src, dst], { stdio: 'ignore' })
  return await new Promise(res => proc.on('exit', code => res(code === 0)))
}
```

Por que não FFI direto em `clonefile(2)`/`FICLONE`:
- `bun:ffi` exige carregar `libSystem.dylib`/`libc.so` e symbol lookups
  por plataforma. Aumenta a superfície de bug por plataforma.
- `cp -c` / `cp --reflink=always` já é o wrapper validado; falha rápido
  com `EXDEV`/`EOPNOTSUPP` e retorna exit code não-zero.
- A detecção via `statfs` é suficiente para um "vale a pena tentar" antes
  de pagar fork/exec.

---

## Fallback chain pragmático (sem Rust)

```
[1] detectCow(repoRoot) === 'apfs-clonefile'  → cp -c -a src dst
[2] detectCow(repoRoot) === 'linux-reflink'   → cp --reflink=always -a src dst
[3] git worktree add  (caminho atual de Claudin)
[4] cp -a (cópia profunda — só se git falhar e usuário pediu isolamento)
```

A cadeia respeita o invariante de Claudin: nunca bloquear o usuário. Falha
em [1]/[2] desce para [3] silenciosamente; [4] só com flag explícita.

---

## Trade-off: COW dá file isolation mas perde branch

- COW puro materializa um diretório independente. **Não há ref git nova.**
- O fluxo de PR de Claudin (`/review`, `gh pr create`) assume branch.
- Sub-agents que só rodam tools (sem intenção de virar PR) não precisam
  de branch; aí o COW é puro ganho.
- O melhor dos dois mundos é a **Forma A** acima: COW seeda o working
  tree e `git worktree add --no-checkout` ainda cria a ref.

---

## Riscos / arestas

1. **Cleanup de orphan clones.** APFS `clonefile` cria árvore independente.
   Se o processo morrer entre `start` e o registro em `~/.claudin/.../activeWorktreeSession`,
   o diretório fica órfão. Mitigar com `ExitWorktreeTool` resiliente +
   prune periódico (`worktree.ts:1172` já chama `git worktree prune`; o
   análogo COW seria varrer um diretório fixo tipo `~/.claudin/worktrees/cow/`).
2. **Dono/permissão.** `cp -a` preserva uid/gid/mode/xattr; `clonefile`
   preserva. `cp --reflink=always` preserva quando combinado com `-a`.
   Cuidado com setuid em `node_modules/.bin` (não é típico, mas pode
   confundir scanners).
3. **Integridade quando original muda.** COW é por-bloco (APFS, btrfs) ou
   por-arquivo (FICLONE walk). Mudanças no `lower` **não** aparecem no
   `merged` — é um snapshot. Isso é o efeito desejado, mas o usuário pode
   se confundir vs overlayfs (que reflete mudanças do lower até o primeiro
   write no upper).
4. **Cross-device EXDEV.** `clonefile`/reflink falham entre volumes diferentes.
   Resolver com `lower` e destino no mesmo mountpoint; documentar.
5. **`.git` clonado vs `gitdir` apontado.** Se copiar o `.git` por cima,
   acaba com duas refs apontando para a mesma working copy. `git worktree
   add --no-checkout` resolve trocando para gitdir apontado.
6. **Hook conflict.** Se o usuário já tem `WorktreeCreate` configurado, o
   COW interno tem que ceder. Hierarquia: hook > COW > git worktree builtin.

---

## Caso de uso real em Claudin: sub-agents paralelos

Cenário concreto: um `AgentTool` spawn-ando 4 sub-agents para investigar
diferentes módulos do repo simultaneamente.

Hoje:
- Todos compartilham CWD (memória atual `team/stdin-readable-wedge.md` é
  um sintoma: estado global do processo é problemático).
- Race em `FileWrite` se dois agentes editam o mesmo arquivo.
- Ou um único `git worktree` global, que não escala para N agentes.

Com COW:
- Cada sub-agent recebe seu próprio `mergedDir` via clone — escritas
  isoladas, leituras compartilham blocos.
- Spawn em ~50 ms (APFS) ou ~100 ms (btrfs FICLONE) por agente em vez de
  `git worktree add` × 4 (escalando linearmente com tamanho do working
  tree, principalmente `dist/`).
- Merge dos resultados via `pi-iso`-style `diff` (ou git diff em cada
  worktree) → patches aplicados sequencialmente no host.

Esse é o caso onde a Forma B (hook COW puro, sem branch) ganha: agentes
investigativos não geram commit.

---

## Métrica de sucesso

Tempo de spawn por sub-agent isolado:

| Backend                          | Alvo p50 | Alvo p95 |
|----------------------------------|----------|----------|
| APFS `clonefile`                 | < 50 ms  | < 200 ms |
| btrfs FICLONE (`cp --reflink`)   | < 100 ms | < 400 ms |
| `git worktree add` (atual)       | 100–800 ms (cache quente, sem `node_modules`) |
| `cp -a` deep copy (fallback)     | (excluir do orçamento; só se nada mais) |

Critério de "vale a pena enviar":
- Spawn de 4 sub-agents paralelos em < 250 ms total p50 em macOS.
- Zero race em FileWrite em teste de 4 agentes editando arquivos vizinhos.
- Resultado merged volta para o host em < 500 ms p95 (git diff + apply).
- Fallback para git worktree não regride o caso single-agent atual.

---

## Referências de arquivo

- `/home/dev/projects/oh-my-pi/crates/pi-iso/src/lib.rs:47-373`
- `/home/dev/projects/oh-my-pi/crates/pi-iso/src/apfs.rs:77-113`
- `/home/dev/projects/oh-my-pi/crates/pi-iso/src/linux_reflink.rs:1-9,41-64`
- `/home/dev/projects/oh-my-pi/crates/pi-natives/src/iso.rs:25-180`
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/task/worktree.ts:238-350`
- `/home/dev/projects/claudin/src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-127`
- `/home/dev/projects/claudin/src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:1-50,281-329`
- `/home/dev/projects/claudin/src/vcs/git/worktree.ts:744-820,1052,1172`
- `/home/dev/projects/claudin/src/platform/lifecycleHooks/events.ts:578-631`
- `/home/dev/projects/claudin/src/platform/lifecycleHooks/executors.ts:244-378`
- `clonefile(2)` (man), `ioctl_ficlone(2)` (man), `cp(1)` `--reflink`.
