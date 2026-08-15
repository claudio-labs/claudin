# Command: mvn (Maven)

**Match pattern:** `^mvn\s+(compile|package|clean|install|test|verify|deploy)\b`
**Família:** java build
**Tier:** 1.5
**Estratégia provável:** declarative (strip `[INFO]` noise — Maven é notoriamente verboso)
**Status:** **NOT analyzed** (mvn não instalado local)
**Estimated reduction:** **~80-90%** (Maven é caso clássico de "muito INFO, pouca info")

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado. Maven tem reputação de ser **um dos outputs mais verbosos do mundo dev**.

### `mvn package` típico (~10-50KB)

```
[INFO] Scanning for projects...
[INFO]
[INFO] -----------------------< com.example:myapp >-----------------------
[INFO] Building myapp 1.0-SNAPSHOT
[INFO] --------------------------------[ jar ]---------------------------------
[INFO] Downloading from central: https://repo.maven.apache.org/maven2/...
[INFO] Downloaded from central: https://repo.maven.apache.org/maven2/... (1.2 MB at 234 kB/s)
[INFO] Downloading from central: ...
... (50+ download lines em build cold)
[INFO]
[INFO] --- maven-resources-plugin:3.3.1:resources (default-resources) @ myapp ---
[INFO] Copying 1 resource from src/main/resources to target/classes
[INFO]
[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ myapp ---
[INFO] Changes detected - recompiling the module! :source
[INFO] Compiling 47 source files with javac [debug parameters release 17]
... (mais blocos `--- plugin:version:goal ---`)
[INFO]
[INFO] --- maven-jar-plugin:3.3.0:jar (default-jar) @ myapp ---
[INFO] Building jar: /path/to/target/myapp-1.0-SNAPSHOT.jar
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  4.123 s
[INFO] Finished at: 2026-05-05T14:30:00Z
[INFO] ------------------------------------------------------------------------
```

### `mvn package` com erro de compilação

```
[INFO] ...
[ERROR] /src/main/java/Main.java:[10,5] cannot find symbol
[ERROR]   symbol:   method foo()
[ERROR]   location: class Main
[INFO] BUILD FAILURE
[INFO] Total time:  2.543 s
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project myapp: Compilation failure
[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.
[ERROR] Re-run Maven with -X switch to enable full debug logging.
```

### `mvn test` em projeto com 50 testes

Output do Surefire plugin: `Tests run: 50, Failures: 0, Errors: 0, Skipped: 0`. Cada test class gera sua própria linha de "Tests run".

---

## Sinal vs ruído

**Sinal (manter):**
- `BUILD SUCCESS` / `BUILD FAILURE` — resultado primário
- `[ERROR]` blocks com path + linha
- Errors com stack pointers (`Failed to execute goal ...`)
- `Tests run: X, Failures: Y` summary
- `Total time: X` — útil pra diagnóstico de performance

**Ruído (massa):**
- `[INFO] Scanning for projects...`
- `[INFO] -----------< ... >-----------` (separadores ASCII art)
- `[INFO] --- plugin:version:goal ---` headers de fase do plugin (centenas em build complexo)
- `[INFO] Downloading/Downloaded from <repo>: ...`
- `[INFO] Progress (1): 234 kB / 1.2 MB`
- `[INFO]` linhas vazias (Maven adiciona spacing com `[INFO]`)
- Banners de jar building / resource copying

---

## Estratégia proposta

### Pipeline declarativo (espelha rtk + augments)

```jsonc
{
  "name": "mvn",
  "matchCommand": "^mvn\\s+(compile|package|clean|install|test|verify|deploy)\\b",
  "matchCommandReject": "-q\\b|--quiet|-X\\b|-e\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\[INFO\\] -+",
    "^\\[INFO\\] -+<.*>-+",
    "^\\[INFO\\] Building\\s",
    "^\\[INFO\\] Scanning for projects",
    "^\\[INFO\\] Downloading from",
    "^\\[INFO\\] Downloaded from",
    "^\\[INFO\\] Progress \\(",
    "^\\[INFO\\]\\s*$",
    "^\\[INFO\\] --- maven-",
    "^\\[INFO\\] Changes detected",
    "^\\[INFO\\] Copying \\d+ resource",
    "^\\[INFO\\] Compiling \\d+ source files",
    "^\\[INFO\\] Building jar:",
    "^Downloading:",
    "^Downloaded:",
    "^Progress",
    "^\\s*$"
  ],
  "matchOutput": [
    {
      "pattern": "\\[INFO\\] BUILD SUCCESS",
      "message": "✓ mvn: BUILD SUCCESS",
      "unless": "(?i)\\b(error|warning)\\b|FAILURES?:"
    }
  ],
  "maxLines": 50
}
```

**Saída esperada (build sucesso):**

```
✓ mvn: BUILD SUCCESS
```

**Saída esperada (build com erro):**

```
[ERROR] /src/main/java/Main.java:[10,5] cannot find symbol
[ERROR]   symbol:   method foo()
[ERROR]   location: class Main
[INFO] BUILD FAILURE
[INFO] Total time:  2.543 s
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile
```

---

## Edge cases / NÃO filtrar quando

- [x] `-q` / `--quiet` → passthrough (já reduzido)
- [x] `-X` (debug) → passthrough (user pediu detalhe)
- [x] `-e` (errors verbose) → passthrough
- [x] `is_error: true` → passthrough? **Decisão:** filtrar mesmo assim, errors são preservados pelo strip pattern. Igual a `pytest`/`vitest`.
- [ ] **`mvn dependency:tree`** — output diferente, filter separado se necessário
- [ ] **`mvn versions:display-dependency-updates`** — outputs longos com colunas, filter separado
- [ ] **Multi-module project** — output 10× maior. Mesmo filter cobre, só mais material.
- [ ] **`mvn release:prepare`** — operação destrutiva, talvez não filtrar pra dar visibilidade total
- [ ] **Surefire test output** com testes que escrevem stdout — preservar (model precisa do output do teste)
- [ ] **`[WARNING]`** linhas — preservar (não cobrimos `\\[WARNING\\]` no strip)

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois (est.) | Redução |
|---|---|---|---|
| Build success cold (downloads) | ~50.000 | ~30 (`match_output`) | **99%** |
| Build success warm | ~10.000 | ~30 | **99%** |
| Build com 1 erro | ~12.000 | ~600 (errors preservados) | ~95% |
| `mvn test` 100 testes ok | ~30.000 | ~50 | **99%** |
| `mvn test` com 5 falhas | ~40.000 | ~3.000 | ~92% |

**Achado esperado:** Maven tem o **maior potencial de ROI** entre os 4 que estamos analisando. ~99% no caso comum "build ok".

---

## Open questions

- [ ] **Capturar amostras reais.** Instalar maven temporário ou usar projeto Spring Boot demo.
- [ ] **`mvnw` (wrapper)** — match pattern adicionar `^(mvn|mvnw|\\./mvnw)\\b`
- [ ] **`maven-shade-plugin`** com warnings sobre overlap — preservar?
- [ ] **Configurar `MAVEN_OPTS=-Dorg.slf4j.simpleLogger.defaultLogLevel=warn`?** Reduz INFO globalmente. Mas modifica env do user.

---

## Comparativo com rtk

- rtk: `filters/mvn-build.toml` — bem similar à nossa proposta.
- **O que copiamos:** todos os strip patterns de `[INFO]`.
- **O que adicionamos:**
  - `match_output` para BUILD SUCCESS (rtk usa só `on_empty` que dispara se output ficar vazio)
  - Cobertura para mais goals (`test`, `verify`, `deploy`) — rtk só `compile|package|clean|install`
  - `--- maven-X-plugin` headers (ruído maior em builds complexos)

---

## Findings empíricos

**ZERO empirical findings** — mvn não instalado.

1. **Maven é candidato perfeito pra `match_output`** — caso "BUILD SUCCESS" é dominante.
2. **`[INFO]` é o prefixo mais ruidoso de qualquer build tool conhecido.**
3. **Multi-module projects** podem multiplicar o tamanho por 10×; capturar amostra desse cenário.
