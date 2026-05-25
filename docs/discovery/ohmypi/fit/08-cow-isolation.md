# 08 — Fit: COW filesystem isolation

Análise concreta de encaixe da ideia "pi-iso" (omp) em Claudio: substituir/
complementar `git worktree add` por COW filesystem (APFS clonefile, btrfs
FICLONE, overlayfs) para isolar sub-agents.

Referências: `docs/discovery/ohmypi/08-cow-filesystem-isolation.md`,
`docs/discovery/ohmypi/deep/08-cow-filesystem-isolation.md`,
`/home/viudes/projects/oh-my-pi/crates/pi-iso/`.

---

## 1. Worktree hoje em Claudio

`src/utils/worktree.ts:744` `createWorktreeForSession(sessionId, slug, ...)`:

1. `validateWorktreeSlug` (segmento alfanumérico, max 64 chars).
2. Se `hasWorktreeCreateHook()` → executa hook do usuário e adota
   `{ worktreePath, hookBased: true }` (`:757-770`). **Hook tem precedência
   sobre git builtin.** Esse é o gancho para VCS não-git.
3. Senão `findGitRoot()` → `getOrCreateWorktree(gitRoot, slug)` →
   `performPostCreationSetup` (`:771-810`). Setup faz:
   - copia `settings.local.json` para o worktree;
   - aponta `core.hooksPath` para o repo principal (husky);
   - opcionalmente symlinka diretórios (`worktree.symlinkDirectories`);
   - aplica `.worktreeinclude` (gitignored files que valem a pena copiar).
4. Grava em `~/.claudio/projects/<dir>/projectConfig.activeWorktreeSession`.

`createAgentWorktree(slug)` (`:944`) é o caminho usado por `AgentTool`
quando `isolation: 'worktree'` é solicitado (`AgentTool.tsx:540-554`).
Mesma estrutura — hook > git — mas sem registrar sessão global.

**Uso real**:
- `EnterWorktreeTool` (slash explícito do usuário).
- `setup.ts:231-233` (auto-resume de sessão).
- `AgentTool.tsx:543` (sub-agent com `isolation: 'worktree'`, opt-in).
- `bridgeMain.ts:967` (bridge gRPC com isolamento).

### Medição neste repo (btrfs, cache quente, sem `node_modules` copiado)

```
git worktree add /tmp/test-wt HEAD
real 0.101s  (~100 ms)
```

Segunda execução: `real 0.103s`. p50 ≈ 100 ms.

Quatro `git worktree add` em **paralelo**: `real 0.113s`. O git serializa
muito pouco — quase grátis paralelizar (provavelmente porque o checkout
é só metadata + uns poucos arquivos via sparse).

Quatro `git worktree add` **sequenciais**: `real 0.454s` (~110 ms cada).

`du -sh`:
- `dist/` 178M
- `node_modules/` 385M
- `.git/` 14M
- `.claudio/v8cache/` ausente (limpo pelo build atual)
- Total repo: 637M

O `git worktree add` **não copia** `dist/`/`node_modules/` (ficam fora
do tree; `node_modules` é gitignored). O worktree fica leve por padrão.
**Por isso é rápido**: o trabalho real do checkout é `.ts/.tsx` etc, não
o GB de `node_modules`.

---

## 2. Sub-agents paralelos em Claudio

`src/coordinator/workerAgent.ts` existe mas é minúsculo (`WORKER_AGENT`,
14 linhas) — define uma agent built-in para o `COORDINATOR_MODE`. O motor
de paralelismo de fato é `AgentTool` (`src/tools/AgentTool/AgentTool.tsx`)
que aceita `multiAgent` / lista de prompts em paralelo.

`isolation: 'worktree'` é **opt-in por agent**. Default = `undefined` →
sub-agents compartilham o CWD do parent. **Risco real hoje**:
- Race em `FileWrite` se dois agents editam o mesmo arquivo (não há lock
  no `FileWriteTool`).
- Estado global do processo (memória `team/stdin-readable-wedge.md`
  documenta um sintoma análogo: listener `readable` ficando surdo).
- Bash `cd` em um agent vaza para os outros (mesmo `process.cwd()`).

Mas: 99% dos agents built-in (`explore`, `plan`, `code-review`) são
**read-only** ou geram patch para o parent aplicar. O race em FileWrite
só dispara quando o usuário pede explicitamente edição paralela.

---

## 3. Ganhos MEDIDOS

Sistema: btrfs em `/home/viudes/projects`, ext4 em `/`, tmpfs em `/tmp`.

| Operação | Tempo (cache quente) | Tamanho destino |
|---|---|---|
| `git worktree add` (1×) | **0.10 s** | ~250M (sem node_modules) |
| `git worktree add` 4× sequencial | 0.45 s | — |
| `git worktree add` 4× paralelo | **0.11 s** | — |
| `cp --reflink=always -r` (637M tree, mesma FS) | **1.34 s** | 637M reflinked |
| `cp -r` deep copy (mesma btrfs) | 1.31 s | 637M |
| `cp --reflink=always` 4× paralelo | **2.40 s** | 4× 637M |
| `rsync -a --exclude=.git` | 4.93 s | — |
| `cp --reflink=always` para `/tmp` (EXDEV) | falha total | — |

**Achados**:
- `git worktree add` é **13× mais rápido** que `cp --reflink` neste repo,
  porque pula `node_modules`+`dist` (gitignored).
- Reflink **não é grátis**: walk recursivo + 1 ioctl por arquivo regular.
  Sistema gasta ~1.1 s de CPU em `sys` (`stat`/`ioctl`/`mkdir`).
- 4× COW paralelo serializa no kernel (sys = 7s para 2.4s wall) — não
  escala linearmente como o git worktree.
- EXDEV: `/tmp` é tmpfs no Linux moderno → reflink **falha** entre
  `/home/...` e `/tmp/...`. Qualquer destino fora do mesmo block device
  cai para deep copy.

**O ganho prometido (50–100 ms COW vs 100–800 ms worktree) não se
materializa neste repo neste FS.** O worktree do Claudio já é
deliberadamente magro (gitignore esconde `node_modules`/`dist`); COW
copiaria *tudo*, inclusive os 385M de `node_modules`.

---

## 4. Onde COW ganha de verdade

a) **Seedar `node_modules`/`dist` no worktree sem deep copy.** Hoje o
   sub-agent dentro do worktree precisa `bun install` (segundos) ou
   `bun run build` para ter o que rodar. Se o `performPostCreationSetup`
   usasse reflink para clonar `node_modules` (385M) em < 1s, o sub-agent
   ganharia ambiente executável imediatamente. Hoje o usuário tem que
   configurar `worktree.symlinkDirectories: ["node_modules"]` (symlink,
   compartilhado → escritas do agente em `node_modules/.bin` vazam para
   o repo principal). **COW resolveria isso com isolamento real.**

b) **`dist/cli.mjs` + `.claudio/v8cache/`** seedados no worktree fazem
   o `claudiodev` rodar dentro do worktree sem rebuild. Útil para o
   próprio agente lançar `claudiodev` (loop).

c) **Múltiplos sub-agents paralelos com FS isolado**, em repos sem
   gitignore agressivo (mono-repo onde tudo é tracked). Aí o `git
   worktree add` doi (checkout pesado) e COW vira ganho real.

d) **Worktree disposable** para `/skill loop` ou tarefas curtas: criar
   e destruir N vezes por minuto. COW + reflink no APFS é ~ms.

---

## 5. Onde COW NÃO ganha (caso típico Claudio)

a) **Usuário single-thread sem sub-agents paralelos.** É a maioria.
   Worktree atual já é rápido (100 ms); COW seria pior (1.3 s no
   repo claudio em btrfs).

b) **FS sem suporte.** ext4 (sem reflink) é o default na maioria das
   instalações Linux desktop/servidor (Ubuntu, Debian, Fedora < 40).
   Sem reflink, COW degrada para `cp -r` (deep copy) — explicitamente
   pior que `git worktree`. macOS APFS é universal (ganha), mas
   Windows depende de ReFS (NTFS não tem block clone). O sistema do
   usuário tem `/` em ext4 e só `/home/viudes/projects` em btrfs — isso
   significa que qualquer worktree fora desse subvol cai no fallback.

c) **Worktree de longa duração.** O ganho de spawn (1s) se dissipa em
   minutos de uso. COW deixa de ser vantagem.

d) **Repos com `.gitignore` agressivo** (`node_modules`, `dist`, caches).
   `git worktree` já os ignora; COW copia tudo — overhead inverso.

---

## 6. Risco real

1. **Mismatch worktree↔git state.** COW puro não cria ref git. Se o
   sub-agent commitar dentro do clone, o commit fica órfão (não há
   branch). `/review`, `gh pr create`, e o tracking de `originalBranch`/
   `worktreeBranch` em `WorktreeSession` (`worktree.ts:140-154`) param
   de funcionar. Forma híbrida (COW + `git worktree add --no-checkout`)
   é mais complexa do que parece — exige sincronizar duas árvores de
   verdade (clone walk + git index).

2. **EXDEV cross-device.** Confirmado nas medições: reflink entre
   filesystems falha. Em distros onde `/tmp` é tmpfs e o user está em
   `/home` (btrfs/zfs), nenhum destino em `/tmp` funciona. O wrapper
   teria que escolher destino no mesmo mountpoint do source (típico
   `<repo>/.claudio/worktrees-cow/`) — viável, mas mais código.

3. **Hook precedence (hook > COW > builtin).** A linha 757 do
   `worktree.ts` mostra que o hook do usuário já tem prioridade.
   Inserir COW *entre* hook e builtin significa que o usuário que
   configurou `WorktreeCreate` para COW manual perde controle se o
   builtin COW achar que sabe melhor. **Quem testa**: ninguém hoje;
   exigiria matriz `(hook present? × COW capable? × git?)` — 8 combos.

4. **macOS vs Linux paths.** `clonefile(2)` no APFS é 1 syscall, mas o
   API espera path absoluto na mesma volume. Linux `FICLONE` é ioctl
   por arquivo regular, com walk no userspace — diferentes failure
   modes (parcial: alguns arquivos cloned, outros copied; cleanup
   é por-arquivo). `pi-iso` esconde isso em Rust; para fazer em TS
   puro precisa `bun:ffi` ou shell out para `cp --reflink=auto`,
   ambos com gotchas de detecção de capability.

5. **Cleanup de órfãos.** `git worktree prune` já existe (`worktree.ts:
   1172`). Para COW precisa varrer `~/.claudio/worktrees-cow/`
   periodicamente, sem sentinela git para "estes ainda estão vivos".

---

## 7. Hook fallback — já existe

`hasWorktreeCreateHook()` + `executeWorktreeCreateHook()` (`utils/hooks/
events.ts:578-631`, executor especial em `executors.ts:244-378`) **já
permitem ao usuário rolar COW próprio** sem mudar nenhum código Claudio:

```jsonc
// ~/.claudio/settings.json
{
  "hooks": {
    "WorktreeCreate": [{
      "type": "command",
      "command": "cp --reflink=auto -r $CLAUDIO_REPO_ROOT $CLAUDIO_REPO_ROOT/.claudio/cow/$CLAUDIO_SLUG && echo $CLAUDIO_REPO_ROOT/.claudio/cow/$CLAUDIO_SLUG"
    }]
  }
}
```

(Variáveis exatas precisariam ser verificadas em `executors.ts:244-378`;
o stdout do hook é interpretado como path do worktree.)

**Isso muda o cálculo**: o power-user que tem btrfs/APFS e quer COW
já pode tê-lo hoje, com um snippet de doc. Não é necessário Rust crate,
NAPI binding, nem detecção de capability em runtime.

O que falta hoje é só **documentação** (`docs/tech/worktree-cow-hook.md`
explicando o snippet, EXDEV, cleanup) — não código.

---

## 8. Veredito

Para o usuário típico de Claudio:
- Single-thread, FS `/` ext4, repo com `node_modules` gitignored.
- `git worktree` resolve em 100 ms hoje.
- Sub-agents paralelos com `isolation: 'worktree'` é opt-in raro.

Implementar `pi-iso`-style PAL nativo (Rust + NAPI + detecção) em
Claudio é:
- Custo: alto (FFI, matriz de FS, capability probing, cleanup,
  paths macOS/Linux/Windows).
- Ganho mediano: ~zero (worktree atual já é leve, FS típico = ext4).
- Ganho de cauda: real em mono-repos sem gitignore + APFS/btrfs +
  4+ sub-agents paralelos editando — caso power-user.

O hook `WorktreeCreate` **já é a extensibilidade certa**. O que
encaixa em Claudio é:

1. **Doc curta** com snippet de hook COW (btrfs `--reflink=auto`,
   APFS `cp -c`), warnings de EXDEV e cleanup, e teste de matriz
   manual.
2. **Opcional** flag `worktree.symlinkDirectories` (que já existe) ser
   estendida com `worktree.reflinkDirectories: ["node_modules"]` —
   no `performPostCreationSetup`, em vez de symlinkar (que vaza
   escritas), fazer reflink. Isso é ~10 linhas, fallback gracioso
   para deep copy se reflink falhar, e ataca o caso real (b) do §4.

Não vale construir o PAL completo do omp.

**Vale a pena: CONDICIONAL — porque o ganho real é num caso de borda
(power-user, FS COW-capable, mono-repo grande, sub-agents paralelos
com edição) que o hook `WorktreeCreate` existente já cobre. O esforço
proporcional ao valor é doc + uma opção pequena de reflink em
`performPostCreationSetup` para seedar `node_modules`/`dist`, não um
PAL Rust com 8 backends.**
