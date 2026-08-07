# Command: curl

**Match pattern:** `^curl\b`
**Família:** network
**Tier:** 1.5 (frequência alta em debug de API)
**Estratégia provável:** declarative agressivo (strip TLS handshake noise)
**Status:** analyzed (real data)
**Estimated reduction:** **~50-80%** com `-v`

---

## Saída crua representativa (REAL: `curl -v https://httpbin.org/get`, 2.076 bytes truncados a head -50)

```
* Host httpbin.org:443 was resolved.
* IPv6: (none)
* IPv4: 44.199.179.5, 54.225.113.51, 3.91.112.114, 52.73.30.72, 98.83.84.78, 54.198.84.224
*   Trying 44.199.179.5:443...
* ALPN: curl offers h2,http/1.1
} [5 bytes data]
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
} [1566 bytes data]
* SSL Trust Anchors:
*   CAfile: /etc/ssl/certs/ca-certificates.crt
{ [5 bytes data]
* TLSv1.3 (IN), TLS handshake, Server hello (2):
{ [104 bytes data]
* TLSv1.2 (IN), TLS handshake, Certificate (11):
{ [3795 bytes data]
* TLSv1.2 (IN), TLS handshake, Server key exchange (12):
{ [333 bytes data]
... (TLS handshake continua por ~30 linhas)
> GET /get HTTP/2
> Host: httpbin.org
> User-Agent: curl/X.Y
> Accept: */*
< HTTP/2 200
< date: Tue, 05 May 2026 14:33:07 GMT
< content-type: application/json
... (response headers)
{ "args": {}, ... }    ← finalmente o body
```

**Insight:** ~30+ linhas de TLS handshake noise, ~10 linhas de request/response headers, ~5 linhas de body útil.

---

## Sinal vs ruído

**Sinal (manter):**
- `> METHOD path HTTP/x` — request line
- `> Header: value` — request headers (selecionados)
- `< HTTP/x STATUS` — response status
- `< Content-Type:` etc — response headers chave
- Body do response

**Ruído alto (com `-v`):**
- **TLS handshake** (linhas começando com `* TLSv1.x`, `} [N bytes data]`, `{ [N bytes data]`)
- `* Trying IP:port...`
- `* ALPN: curl offers ...`
- `* Connection #0 to host ... left intact`
- `* IPv4:` (lista de resolved IPs)
- `* SSL Trust Anchors:` / `* CAfile: ...`

---

## Estratégia proposta

```jsonc
{
  "name": "curl",
  "matchCommand": "^curl\\b",
  "matchCommandReject": "-s\\b|--silent|-I\\b|--head",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\*\\s+TLS",
    "^\\*\\s+SSL",
    "^[}{]\\s+\\[\\d+\\s+bytes\\s+data\\]\\s*$",
    "^\\*\\s+IPv[46]:",
    "^\\*\\s+Trying\\s",
    "^\\*\\s+ALPN:",
    "^\\*\\s+Connection #",
    "^\\*\\s+CAfile:",
    "^\\*\\s+CApath:",
    "^\\*\\s+Host\\s.*was\\s+resolved\\."
  ],
  "maxLines": 100
}
```

Saída esperada (de 2.076 bytes pra ~600 bytes → ~70%):

```
* Server certificate: ...
> GET /get HTTP/2
> Host: httpbin.org
> User-Agent: curl/X.Y
> Accept: */*
< HTTP/2 200
< date: Tue, 05 May 2026 14:33:07 GMT
< content-type: application/json
{ "args": {}, ... }
```

---

## Edge cases

- [x] `-s` / `--silent` → passthrough (já sem -v noise)
- [x] `-I` / `--head` → passthrough (só headers)
- [ ] **`-X POST` com `-d`** — body upload visible em `-v`. Preservar (modelo precisa).
- [ ] **`--trace`** ou `--trace-ascii` — output ainda mais verboso. Filter strip não cobre completamente.
- [ ] **HTTP/1.1 vs HTTP/2 vs HTTP/3** — formatos diferentes, mesma estratégia geral
- [ ] **Redirect chain (`-L`)** — múltiplos `> GET` e `< HTTP/2 302` blocks. Preservar todos (model precisa do trace).
- [ ] **Body binário** — pode quebrar parsing visual; passthrough preferível
- [ ] **`is_error: true`** (4xx/5xx) — preservar inteiro (modelo precisa do erro)

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **`curl -v` truncado head -50 (REAL)** | **2.076** | ~600 | **~71%** |
| `curl -v` GET completo | ~3.500 | ~700 | ~80% |
| `curl -v` POST com upload | ~5.000 | ~1.500 | ~70% |
| `curl` sem -v (silent) | ~500 | ~500 | 0% |
| `curl -I` | ~500 | ~500 | 0% |

---

## Comparativo com rtk

- rtk: `cmds/cloud/curl_cmd.rs` — implementa filtro nativo.
- **Confirma valor da feature.**

---

## Findings empíricos

1. **TLS handshake é 50%+ do output em `curl -v`.** Strip vale muito.
2. **`{ [N bytes data]` markers** são puro noise (TLS frame sizes).
3. **rtk cobre via cmds/cloud/curl_cmd.rs** — confirma frequência de uso.
4. **HTTP debugging** é caso real importante — agente debug API usa `curl -v` muito.
