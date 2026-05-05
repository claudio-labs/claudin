# Command: terraform plan / apply / state list

**Match pattern:** `^(terraform|tofu|tf)\s+(plan|apply|state\s+list)\b`
**Família:** iac
**Tier:** 1.5 (uso ops/SRE; pode subir conforme telemetria)
**Estratégia provável:** declarative (strip refreshing state + state lock)
**Status:** **NOT analyzed** (terraform não instalado local; análise baseada em rtk + conhecimento)
**Estimated reduction:** **~30-40%** (rtk filtro é bem conservador)

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado localmente. Estrutura típica:

### `terraform plan` — sem mudanças (~500 bytes)

```
Acquiring state lock. This may take a few moments...
Refreshing state... [id=vpc-abc123]
Refreshing state... [id=sg-456def]
Refreshing state... [id=i-789ghi]
... (1 linha por recurso, pode ter 100+)
Releasing state lock. This may take a few moments...

No changes. Your infrastructure matches the configuration.
```

### `terraform plan` — com mudanças (~5-30KB)

```
Acquiring state lock. This may take a few moments...
Refreshing state... [id=vpc-abc123]
Refreshing state... [id=sg-456def]
... (50+ Refreshing lines)
Releasing state lock. ...

Terraform used the selected providers to generate the following execution plan.
Resource actions are indicated with the following symbols:
  + create
  ~ update in-place
  - destroy

Terraform will perform the following actions:

  # aws_instance.web will be created
  + resource "aws_instance" "web" {
      + ami                         = "ami-0c55b159cbfafe1f0"
      + instance_type               = "t3.micro"
      + tags                        = {
          + "Environment" = "prod"
          + "Name"        = "webserver"
        }
    }

  # aws_security_group.web_sg will be updated in-place
  ~ resource "aws_security_group" "web_sg" {
      ~ ingress = [
          ~ {
              + cidr_blocks = ["0.0.0.0/0"]
              ...
            },
        ]
    }

Plan: 1 to add, 1 to change, 0 to destroy.
```

### `terraform apply` — após plan

```
... (mesmo plan output) ...
Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

aws_instance.web: Creating...
aws_instance.web: Still creating... [10s elapsed]
aws_instance.web: Still creating... [20s elapsed]
aws_instance.web: Creation complete after 23s [id=i-abc123]

Apply complete! Resources: 1 added, 1 changed, 0 destroyed.
```

---

## Sinal vs ruído

**Sinal (manter — quase tudo):**
- Action symbols (`+ create`, `~ update`, `- destroy`)
- Resource type + name (`# aws_instance.web will be created`)
- Diff de atributos (`+ ami = "..."`, `~ ingress`)
- Sumário final (`Plan: X to add, Y to change, Z to destroy`)
- `Apply complete! Resources: ...`

**Ruído puro:**
- `Acquiring state lock. This may take a few moments...`
- `Releasing state lock. ...`
- `Refreshing state... [id=...]` — **MASSIVO em projeto grande** (1 linha por recurso)
- Linhas em branco entre recursos
- `# .* unchanged` (se user não passou `-out` filtrando)

**Ambíguo (durante apply):**
- `Still creating... [10s elapsed]` repete N vezes — colapsar para 1 linha "still creating (Ns)"
- `Creating...` / `Creation complete after Ns` — manter ambos? Provavelmente só o "complete"

---

## Estratégia proposta

### Pipeline declarativo (espelha rtk + augments)

```jsonc
{
  "name": "terraform",
  "matchCommand": "^(terraform|tofu|tf)\\s+(plan|apply|state\\s+list|destroy)\\b",
  "matchCommandReject": "-json|-no-color\\s+-json",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^Refreshing state\\.\\.\\.",
    "^Acquiring state lock",
    "^Releasing state lock",
    "^\\s*$",
    "^\\s*#.*unchanged\\s*$"
  ],
  "replace": [
    { "pattern": "^(.+?): Still (creating|destroying|modifying)\\.\\.\\.\\s+\\[\\d+s elapsed\\]$", "replacement": "" }
  ],
  "matchOutput": [
    {
      "pattern": "No changes\\. Your infrastructure matches the configuration\\.",
      "message": "✓ terraform plan: no changes",
      "unless": "(?i)\\b(error|warning)\\b"
    }
  ],
  "maxLines": 200
}
```

**Saída esperada (plan com mudanças):**

```
Terraform used the selected providers to generate the following execution plan.
Resource actions are indicated with the following symbols:
  + create
  ~ update in-place
  - destroy

Terraform will perform the following actions:
  # aws_instance.web will be created
  + resource "aws_instance" "web" {
      + ami           = "ami-..."
      ...
    }
  # aws_security_group.web_sg will be updated in-place
  ~ resource "aws_security_group" "web_sg" {
      ...
    }
Plan: 1 to add, 1 to change, 0 to destroy.
```

### Estratégia agressiva: forçar `-out` + leitura

```bash
# Em vez de:
terraform plan
# Rodar:
terraform plan -out=/tmp/tf.plan && terraform show -no-color /tmp/tf.plan
```

`terraform show` é menos verboso que plan default. **Adiar pra v2** — invasivo demais.

### Estratégia ainda mais agressiva: forçar `-json`

```bash
terraform plan -json | jq -r '<filter>'
```

JSON output é estruturado mas **muito verboso por design**. Não recomendado.

---

## Edge cases / NÃO filtrar quando

- [x] `-json` flag → passthrough (estruturado, ferramenta automatizando deve usar)
- [x] `-no-color -json` → passthrough
- [x] `is_error: true` → passthrough (errors críticos)
- [ ] **Apply em curso com prompt interativo** — não chega no BashTool de forma significativa (interatividade quebra pipe)
- [ ] **Output com erros de plan** (`Error:` block) — preservar inteiro; nosso filtro padrão preserva
- [ ] **`terraform destroy`** — output similar a apply, mesmo filtro funciona
- [ ] **`terraform state list`** — só nomes, passthrough (já compacto)
- [ ] **`terraform output`** — passthrough
- [ ] **Recursos com 100+ atributos** — diff individual longo; preservar (é o conteúdo real)
- [ ] **Provider warnings** (`Warning: ...`) — preservar; regex de unless não estamos usando aqui mas vale considerar

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois (est.) | Redução |
|---|---|---|---|
| Plan no-changes (50 recursos refresh) | ~3.000 | ~80 (`match_output`) | **97%** |
| Plan com 5 mudanças (200 recursos refresh) | ~15.000 | ~5.000 | ~67% |
| Plan com 50 mudanças | ~80.000 | ~50.000 | ~37% |
| Apply em curso (10 recursos sendo criados) | ~10.000 | ~3.000 | ~70% |

**Achado esperado:** ROI **muito** alto no caso "no changes" (que é dominante em CI/CD). Mais modesto quando há mudanças reais (são puro sinal).

---

## Open questions

- [ ] **Capturar amostras reais.** Instalar terraform local ou usar projeto público (ex: terraform-aws-modules) pra `init && plan` num backend local.
- [ ] **`tofu` (OpenTofu fork)** — output identical to terraform; same filter cobre.
- [ ] **`terragrunt`** — wrapper que adiciona seus próprios banners. Precisa filter próprio?
- [ ] **`-target=...`** focuses scope — não muda strategy.
- [ ] Quão bem o filter trata **multi-workspace** outputs (`terraform workspace list` — fora de escopo? Diff outputs)?

---

## Comparativo com rtk

- rtk: `filters/terraform-plan.toml` — declarativo, exatamente como nossa proposta. Strip dos mesmos lines (Refreshing, Acquiring, Releasing, `unchanged`).
- **O que copiamos:** strip de state lock + Refreshing + unchanged.
- **O que mudamos:**
  - Adicionamos `Still creating... [Ns elapsed]` (apply-time noise, rtk não cobre)
  - `match_output` para no-changes (rtk usa `on_empty` mas só dispara se output ficar vazio)
- rtk só cobre `plan`; estendemos pra `apply`, `destroy`, `state list`.

---

## Findings empíricos

**ZERO empirical findings** — terraform não instalado.

1. **rtk filter é conservador** — strip simples, max 80 linhas. Nossa proposta adiciona `match_output` para o caso comum "no changes" (97% redução).
2. **Maior win esperado é apply em curso** com `Still creating... [Ns elapsed]` — é o tipo de noise que mais varia entre runs, mata cache.
3. **Plan com mudanças é majoritariamente sinal** — modelo precisa do diff. Não tentar comprimir.
