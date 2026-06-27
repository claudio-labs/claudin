# Bash output filter — roadmap (deferred command families)

> Scope: this is the bash-output-filter backlog only. It deliberately does **not**
> recreate the repo-root `ROADMAP.md` (removed in `34ed459a`).

Phase 13 closed the **language-toolchain** gap vs rtk (`../rtk`): gcc/make/pio,
dotnet (build/test/format), composer, rake, mix, swift/xcodebuild, next/biome/
oxlint/turbo/nx, uv/poetry/basedpyright/ty, spring-boot. See
[`phases/README.md`](phases/README.md).

What remains from the rtk catalogue is **non-language** tooling — cloud, sysadmin,
IaC, task-runners, and niche CLIs. Each row below names the rtk source and why it
was deferred. Match patterns and per-command samples are already in rtk, so each is
a self-contained follow-up (same `FilterSpec` recipe as Phase 12/13).

## Cloud / infra (highest value)

| Command | rtk source | Why deferred |
|---|---|---|
| `aws` | `cmds/cloud/aws_cmd.rs` | needs per-subcommand (s3/ec2/…) table parsing; large surface |
| `gcloud` | `filters/gcloud.toml` | verbose progress + table output; straightforward strip |
| `psql` | `cmds/cloud/psql_cmd.rs` | result-set truncation; interactive vs `-c` modes differ |
| `helm` | `filters/helm.toml` | install/upgrade NOTES block is large but signal |
| container build | `cmds/cloud/container.rs` | `docker/podman build` layer spam (Claudin has ps/images/logs, not build) |

## IaC

| Command | rtk source | Why deferred |
|---|---|---|
| `tofu fmt/init/plan/validate` | `filters/tofu-*.toml` | OpenTofu fork of terraform (Claudin has `terraform plan` only) |
| `ansible-playbook` | `filters/ansible-playbook.toml` | per-play recap; PLAY/TASK banners are noise |

## Sysadmin / system

| Command | rtk source | Why deferred |
|---|---|---|
| `systemctl status` | `filters/systemctl-status.toml` | Claudin has `journalctl`, not `systemctl status` |
| `iptables` | `filters/iptables.toml` | rule-table truncation |
| `fail2ban-client` | `filters/fail2ban-client.toml` | status block compaction |
| `brew install/upgrade` | `filters/brew-install.toml` | download/pour spam + already-installed short-circuit |
| `mise` | `filters/mise.toml` | tool-version manager status lines |
| `wc` | `cmds/system/wc_cmd.rs` | trivial; low ROI |
| `env` | `cmds/system/env_cmd.rs` | sort/limit long environments |

## Task runners

| Command | rtk source | Why deferred |
|---|---|---|
| `just` | `filters/just.toml` | recipe-header strip (Justfile) |
| `task` | `filters/task.toml` | go-task header strip (Taskfile) |

## DB / secrets / niche

| Command | rtk source | Why deferred |
|---|---|---|
| `liquibase` | `filters/liquibase.toml` | changelog header/info strip |
| `sops` | `filters/sops.toml` | secrets — handle carefully |
| `skopeo` | `filters/skopeo.toml` | manifest truncation |
| `quarto render` | `filters/quarto-render.toml` | doc-render progress |
| `shopify theme push/pull` | `filters/shopify-theme.toml` | niche |
| `jira` | `filters/jira.toml` | CLI metadata strip |
| `yadm` | `filters/yadm.toml` | git-wrapper; same filtering as git |
| `ollama run` | `filters/ollama.toml` | spinner/cursor-control strip |
| `trunk build` | `filters/trunk-build.toml` | Rust/WASM bundler |

## Out of scope (by design — not a gap)

- `cat` / `read` — Claudin reads files through its own `Read` tool, not via `cat` in Bash.
- rtk's `pipe` / `summary` / `deps` / `local_llm` (`cmds/system/*`) are internal rtk
  helpers, not user commands.
