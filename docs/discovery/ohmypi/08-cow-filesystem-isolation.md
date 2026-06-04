# 08 — COW filesystem isolation para worktrees

## O que omp faz

`crates/pi-iso/` detecta capability do FS e usa o mais barato disponível:
- macOS APFS → `clonefile()`
- Linux btrfs/zfs → `cp --reflink=always`
- Linux overlayfs → mount overlay
- Windows → projfs ou `rcopy`
- Fallback → cópia recursiva

Resultado: spawn de worker isolado em ms, não em segundos (git worktree precisa checkout completo).

## Por que importa para Claudin

- `EnterWorktreeTool` usa `git worktree add` — cria branch + checkout. Em repo grande (claudin mesmo tem dist/ etc), demora.
- Sub-agents Code/Plan rodando em paralelo se beneficiariam de isolamento real sem custo de checkout.
- Hoje sub-agents compartilham CWD, o que cria race condition em FileWrite.

## Perguntas em aberto

- Detecção de FS capability sem virar Rust (statfs syscall via Bun ffi?)
- Trade-off: COW dá file isolation mas branch git ainda vale para PR workflow.
- Cleanup: APFS clone independente sobrevive ao GC do git, vira lixo? Refcount?
- Permissões: clone preserva quem é dono?
- Combina com `WorktreeCreate` hooks já existentes?

## Referência

- `crates/pi-iso/` (omp)
- `src/tools/EnterWorktreeTool/` (claudin)
- `clonefile(2)` no APFS, `cp --reflink` no coreutils
