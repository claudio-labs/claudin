# undici 8 Pool Tuning — Benchmark Report

> Roadmap item 11.5. Baseline gerado em 2026-05-16 contra mock servers locais (h2-capable + h1-only) com latência fixa de 50ms por request. Reprodução: `node --experimental-strip-types scripts/profile/undici-pool-bench.ts`.

## Contexto

`src/utils/proxy.ts:207-245` cria `EnvHttpProxyAgent` sem ajustar `connections`, `keepAliveTimeout`, `pipelining` ou `allowH2`. undici 8 ligou HTTP/2 por padrão. O item 11.5 do roadmap pedia bench antes/depois para decidir se vale tunar o dispatcher por provider.

Resposta curta: **vale para workloads paralelos** (sub-agentes, ferramentas concorrentes, MCP); **não muda nada para single-stream sequencial**.

## Setup

- undici 8.3.0 (`node_modules/undici/package.json`)
- Node 25.x (`--experimental-strip-types`)
- 2 mock servers locais: h2 (ALPN h2 + http/1.1) e h1-only (force fallback)
- TLS self-signed gerado via `openssl` em `scripts/profile/__fixtures__/undici-tls/`
- Instrumentação: `diagnostics_channel` (`undici:client:connected`, `undici:client:sendHeaders`) → tcp connects, h2 negotiations, socket reuse %
- Cenários: `sequential-burst`, `parallel-burst`, `cold-then-warm`, `mixed-providers`
- Matriz: 2 (allowH2) × 4 (connections: 1,6,16,64) × 3 (kat: 4s,30s,60s) × 3 (pipelining: 0,1,10) = 72 configs × 4 cenários × 2 server types = 576 medições
- Default reference: `allowH2=false, connections=1, kat=4000, pipelining=1` (espelha o que `EnvHttpProxyAgent` aplica hoje)

## Resultados principais

### parallel-burst (8 reqs paralelas × 5 rounds)

| Config | p95 (ms) | Δ vs default |
|---|---|---|
| **default** (c=1, p=1, h2=0) | ~403 | baseline |
| c=6, p=1 | ~102 | −75% |
| c=16, p=1 | ~52 | **−87%** |
| c=64, p=1 | ~52 | **−87%** |
| h2=1, c=1, p=10 | ~51 | **−87%** |
| h2=1, c=6, p=10 | ~52 | **−87%** |

**Interpretação:** com `connections=1, pipelining=1` os 8 requests serializam num único socket → 8 × 50ms ≈ 400ms. Qualquer combinação que destrave paralelismo (mais sockets OU pipelining + h2 mux) cai para ~50ms — o mínimo permitido pela latência fixa do mock.

### sequential-burst (50 reqs sequenciais)

Todas as configs ficaram em ~50.6ms p95. Esperado: 1 socket, reuse 100%, nenhum tuning aplicável.

### cold-then-warm

Apenas um outlier marginal: `h2=1, c=6, kat=60s, p=0` regrediu **+12%** (52ms → 58ms). Dentro do ruído de reconnect TLS.

### mixed-providers

Sem regressões cruzadas entre origens h1 e h2 com a mesma config.

## Pontos sutis

1. **HTTP/2 multiplexing substitui pool grande.** `h2=1, c=1, p=10` empata com `c=16` no fanout — provedores h2-only podem ficar com `connections=1`.
2. **`c=6` sozinho não basta** para 8 paralelos: vira 2 rounds serializados (~100ms).
3. **`pipelining` sem h2 contra h1-only** é seguro neste mock (sem regressão), mas a documentação do undici desaconselha em produção (head-of-line blocking + servidores quebrados). Manter `pipelining=1` para h1, `pipelining>1` só com `allowH2=true`.
4. **`keepAliveTimeout` é irrelevante neste bench** (cenário não exercita idle > 4s). Vale para sessões longas reais (REPL parado entre turns) — bench atual não mede isso.
5. **`connections=64`** não bate `connections=16` em nenhum cenário. Memória adicional sem ganho.

## Recomendação para `src/utils/proxy.ts`

Aplicar tuning padrão **só em dispatchers per-provider**, não no global (manter `EnvHttpProxyAgent` global intacto para o ecossistema MCP/Firecrawl):

```ts
// pseudo — proposta, não aplicada ainda
const PROVIDER_POOL_DEFAULTS = {
  connections: 16,
  keepAliveTimeout: 30_000,
  allowH2: true,        // h2-capable origins ganham mux; h1 origins fallback é gratuito
  pipelining: 1,        // h1 nunca pipeline; h2 mux já dá o ganho
}
```

Override per-provider apenas para providers comprovadamente h1-only com fallback custoso (sem evidência ainda — exigiria bench real contra endpoint público).

## Quando rerunar o bench

- Upgrade do undici (qualquer minor)
- Mudança em `src/utils/proxy.ts:getProxyAgent()` ou em `keepAliveDisabled`
- Adição de provider novo com latência ou padrão de uso atípico

```bash
# Full matrix (~5min)
node --experimental-strip-types scripts/profile/undici-pool-bench.ts --json \
  > scripts/profile/baselines/undici-pool.json

# Drift vs baseline salvo
node --experimental-strip-types scripts/profile/undici-pool-bench.ts --compare

# Quick smoke (1 cenário, 5 configs)
node --experimental-strip-types scripts/profile/undici-pool-bench.ts --quick
```

## Limitações conhecidas

- Mock server com latência **fixa** (50ms) → não modela jitter de rede real
- TLS handshake local é mais rápido que internet (~5ms vs 100ms+) → vantagem de keep-alive subestimada
- Apenas Node 25 com undici 8.3 — comportamento em outros runtimes (Bun, Deno) não testado
- Bench mede latência, não throughput nem RSS. Para verificar custo de memória com `connections=64`, ver `scripts/profile/memory-bench.ts`

## Arquivos relacionados

- `scripts/profile/undici-pool-bench.ts` — bench executável
- `scripts/profile/undici-pool-bench.test.ts` — sanity dos hooks de diagnostic channel
- `scripts/profile/baselines/undici-pool.json` — baseline 2026-05-16 (commit pinado)
- `scripts/profile/__fixtures__/undici-tls/` — cert+key self-signed
- `src/utils/proxy.ts` — alvo da mudança (não modificado ainda; aguarda decisão)
