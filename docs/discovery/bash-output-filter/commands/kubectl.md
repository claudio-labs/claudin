# Command: kubectl get / describe / logs

**Match pattern:** `^kubectl\s+(get|describe|logs|top)\b`
**Família:** k8s
**Tier:** 1.5 (uso ops/SRE)
**Estratégia provável:** **hybrid** — `get` força `-o json` + parse (rtk-style), `describe`/`logs` declarativo
**Status:** **NOT analyzed** (kubectl não instalado local)
**Estimated reduction:** **~50-70%** estimado

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado. Estruturas típicas:

### `kubectl get pods` (padrão tabular)

```
NAME                                READY   STATUS    RESTARTS   AGE
api-deployment-7b8f9d-abc12        1/1     Running   0          2d
api-deployment-7b8f9d-def34        1/1     Running   2 (3h ago) 2d
worker-statefulset-0                1/1     Running   0          5d
worker-statefulset-1                1/1     Running   0          5d
postgres-deployment-9c8d7e-xyz98   0/1     Pending   0          5m
```

### `kubectl get pods -A` (all namespaces, ~10-50KB típico)

100+ linhas em cluster médio.

### `kubectl describe pod <name>` (3-15KB)

```
Name:             api-deployment-7b8f9d-abc12
Namespace:        production
Priority:         0
Service Account:  default
Node:             node-3/10.0.1.42
Start Time:       Tue, 04 May 2026 14:22:05 +0000
Labels:           app=api
                  pod-template-hash=7b8f9d
Annotations:      kubectl.kubernetes.io/restartedAt: 2026-05-04T14:22:00Z
Status:           Running
IP:               10.244.3.15
IPs:
  IP:           10.244.3.15
Controlled By:  ReplicaSet/api-deployment-7b8f9d
Containers:
  api:
    Container ID:   containerd://abc123def456...
    Image:          ghcr.io/myorg/api:v1.2.3
    Image ID:       ghcr.io/myorg/api@sha256:abcd1234...
    Port:           8080/TCP
    Host Port:      0/TCP
    State:          Running
      Started:      Tue, 04 May 2026 14:22:10 +0000
    Ready:          True
    Restart Count:  0
    Limits:
      cpu:     500m
      memory:  512Mi
    Requests:
      cpu:        100m
      memory:     128Mi
    Environment:
      DATABASE_URL: <redacted>
      ...
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-xyz (ro)
Volumes:
  kube-api-access-xyz:
    Type:                    Projected
    ...
QoS Class:                   Burstable
Node-Selectors:              <none>
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
Events:
  Type    Reason     Age    From               Message
  ----    ------     ----   ----               -------
  Normal  Scheduled  5m22s  default-scheduler  Successfully assigned production/api-deployment-7b8f9d-abc12 to node-3
  Normal  Pulling    5m21s  kubelet            Pulling image "ghcr.io/myorg/api:v1.2.3"
  Normal  Pulled     5m18s  kubelet            Successfully pulled image (3.21s)
  Normal  Created    5m18s  kubelet            Created container api
  Normal  Started    5m17s  kubelet            Started container api
```

### `kubectl logs <pod>` (variável: 100B-MBs)

Geralmente timestamps + log lines. Se pod tem múltiplos containers, prefixo `<container>:`.

---

## Sinal vs ruído

### `kubectl get` — pouco ruído

**Sinal (manter):** todas as colunas — name, status, age, restart count
**Ruído menor:**
- AGE relativo (`2d`, `3h`) — varia entre rodadas
- Restart count com `(3h ago)` — útil saber RECENT, mas timestamp varia

### `kubectl describe` — MUITO ruído

**Sinal:**
- Status, Phase, IP
- Containers (name, image, state, ready, restart count)
- Resources (limits, requests)
- Events recentes (especialmente Warnings/Errors)

**Ruído:**
- Timestamps absolutos (`Tue, 04 May 2026 14:22:05 +0000`)
- Container ID full (`containerd://abc123def456789012345...`) — 64+ char hash
- Image ID full (`ghcr.io/...@sha256:abcd1234...`) — pode ter ambos `Image:` e `Image ID:` redundantes
- Tolerations defaults (que apareem em todos os pods do cluster)
- Volumes default (kube-api-access)
- ServiceAccount `default`
- Annotations sistema (`kubectl.kubernetes.io/...`)
- Events com timestamps `5m22s` (varia)

### `kubectl logs` — depende do app

- Timestamps redundantes se `--timestamps` (já implícito ao pod)
- Container prefix se single-container

---

## Estratégia proposta

### `kubectl get` — Opção A: rewrite com `-o wide` ou `-o custom-columns`

Mais simples: deixar passar, é tabular já. Strip de AGE varia mas é só 2-5 chars.

```jsonc
{
  "name": "kubectl-get",
  "matchCommand": "^kubectl\\s+get\\b",
  "matchCommandReject": "-o\\s+(json|yaml|name)|--output=(json|yaml|name)",
  "stripAnsi": true,
  "maxLines": 100
}
```

**Estimativa:** ~10% redução (cap no 100 linhas).

### `kubectl get` — Opção B: rewrite forçar `-o json` + parse + reformat (rtk-style)

```bash
# rewrite:
kubectl get pods -o json | <parser>
```

Output reformatado:
```
api-deployment-7b8f9d-abc12  1/1 Running 0
api-deployment-7b8f9d-def34  1/1 Running 2(restarted 3h ago)
postgres-deployment-9c8d7e-xyz98  0/1 Pending 0
```

**Estimativa:** ~30-50% redução. Adiciona parser TS. **Adiar pra v2.**

### `kubectl describe` — Opção A: declarativo agressivo

```jsonc
{
  "name": "kubectl-describe",
  "matchCommand": "^kubectl\\s+describe\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^Annotations:.*kubectl\\.kubernetes\\.io/",
    "^Tolerations:\\s+node\\.kubernetes\\.io/(not-ready|unreachable):NoExecute",
    "^\\s+node\\.kubernetes\\.io/(not-ready|unreachable):NoExecute",
    "^Service Account:\\s+default$",
    "^Priority:\\s+0$",
    "^Host Port:\\s+0/TCP$",
    "^Node-Selectors:\\s+<none>$"
  ],
  "replace": [
    { "pattern": "^(\\s*Container ID:\\s+\\S+://)([0-9a-f]{12})[0-9a-f]+$", "replacement": "$1$2..." },
    { "pattern": "^(\\s*Image ID:\\s+\\S+@sha256:)([0-9a-f]{12})[0-9a-f]+$", "replacement": "$1$2..." },
    { "pattern": "^Start Time:\\s+\\w+, \\d+ \\w+ \\d{4} \\d{2}:\\d{2}:\\d{2} [+\\-]\\d{4}$", "replacement": "" }
  ],
  "maxLines": 80
}
```

**Estimativa:** ~50-65% redução em describe típico.

### `kubectl logs` — depende

```jsonc
{
  "name": "kubectl-logs",
  "matchCommand": "^kubectl\\s+logs\\b",
  "matchCommandReject": "-f\\b|--follow",
  "stripAnsi": true,
  "maxLines": 200
}
```

**Estimativa:** ~5-30% redução (logs do app são puro sinal).

---

## Edge cases / NÃO filtrar quando

- [x] `-o json` / `-o yaml` / `-o name` → passthrough (estruturado/já mínimo)
- [x] `--output=json|yaml|name` → idem
- [x] `-f` / `--follow` → streaming, fora de escopo
- [x] `is_error: true` → passthrough (auth fail, conn refused — info crítica)
- [ ] **`--watch` / `-w`** → streaming
- [ ] **`kubectl exec`** — passthrough (output do comando dentro do pod)
- [ ] **`kubectl edit`** — interativo, fora de escopo
- [ ] **`kubectl apply` / `delete`** — output curto, pode ter `match_output` mas baixa prioridade
- [ ] **Multi-cluster** (`--context`) — não afeta filter
- [ ] **CRDs com schema custom** — `kubectl describe <CRD>` pode ter campos não cobertos pelos strip patterns. Degrada graceful.

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois (est.) | Redução |
|---|---|---|---|
| `get pods` 5 pods | ~500 | ~500 (cap não atinge) | 0% |
| `get pods -A` 100 pods | ~10.000 | ~10.000 (`maxLines: 100` cobre) | ~0% |
| `get pods -A` 200 pods | ~20.000 | ~10.000 | ~50% |
| `describe pod` típico | ~5.000 | ~2.000 | ~60% |
| `logs <pod>` ~100 linhas | ~10.000 | ~10.000 (puro sinal) | 0% |
| `logs <pod>` ~10.000 linhas | ~500.000 | ~16.000 (cap 200 lines × 80 chars) | ~97% (mas perde info) |

---

## Open questions

- [ ] **Capturar amostras reais.** Instalar `kind` (kubernetes-in-docker) ou `minikube` localmente.
- [ ] **`get` json rewrite** vale a complexidade? (~30% extra).
- [ ] **Logs cap em 200 lines** é razoável? Em debug de erro real, modelo pode precisar mais. Talvez 500.
- [ ] **`describe` para CRDs** quanto cobre? Precisa testar com Argo, Istio, etc.
- [ ] **`kubectl explain`** — output verboso documentação. Filtrar separado?

---

## Comparativo com rtk

- rtk: `cmds/cloud/container.rs` — implementa nativo!
- rtk **força `-o json`** em `kubectl get pods/services` e parseia (estratégia agressiva).
- **O que copiamos:** decisão de fazer hybrid (declarativo simples na v1, native na v2).
- **O que mudamos:** rtk só cobre `pods`, `services`, `logs`. Estendemos pra `describe`, `top`, e qualquer `get <resource>`.

---

## Findings empíricos

**ZERO empirical findings** — kubectl não instalado.

1. **Volume varia gigantescamente** — get 5 pods = 500B, logs 10k linhas = 500KB.
2. **`describe` é o caso clássico** — infraestrutura system-level (tolerations, volumes, annotations) ocupa metade do output.
3. **rtk forçou `-o json`** — confirma que pra get, parsing nativo é o caminho ideal mas custoso.
4. **Logs são caso de summarizer**, não filter Bash — head/tail genérico do summarizer atual provavelmente serve melhor.
