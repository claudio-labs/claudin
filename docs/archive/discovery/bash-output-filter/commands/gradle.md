# Command: gradle / gradlew / ./gradlew

**Match pattern:** `^(gradle|gradlew|\./gradlew?)\b`
**Família:** java/kotlin build
**Tier:** 1.5
**Estratégia provável:** declarative (strip task UP-TO-DATE + daemon banners)
**Status:** **NOT analyzed** (gradle não instalado local)
**Estimated reduction:** **~70-85%** (similar ao mvn mas Gradle é menos verboso por padrão)

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado. Gradle é menos verboso que Maven por design (sem `[INFO]` em todo lugar) mas tem outros tipos de noise.

### `gradlew build` típico (~3-15KB)

```
Starting a Gradle Daemon (subsequent builds will be faster)

> Configuring project :app
> Resolving dependencies of configuration ':app:compileClasspath'

> Task :app:compileJava UP-TO-DATE
> Task :app:processResources UP-TO-DATE
> Task :app:classes UP-TO-DATE
> Task :app:compileKotlin UP-TO-DATE
> Task :app:compileTestJava NO-SOURCE
> Task :app:processTestResources NO-SOURCE
> Task :app:testClasses UP-TO-DATE
> Task :app:test FROM-CACHE
> Task :app:check
> Task :app:assemble
> Task :app:build

BUILD SUCCESSFUL in 8s
7 actionable tasks: 1 executed, 6 up-to-date
```

### `gradlew test` com falhas

```
> Task :app:compileJava
> Task :app:test FAILED

UserServiceTest > shouldAuthenticateUser FAILED
    java.lang.AssertionError: expected:<true> but was:<false>
        at UserServiceTest.shouldAuthenticateUser(UserServiceTest.java:42)

3 tests completed, 1 failed

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:test'.
> There were failing tests. See the report at: file:///path/to/report/index.html

* Try:
> Run with --stacktrace option to get the stack trace.
> Run with --info or --debug option to get more log output.
> Run with --scan to get full insights.

* Get more help at https://help.gradle.org

BUILD FAILED in 12s
3 actionable tasks: 3 executed
```

### `gradlew dependencies` (não trivial — output massivo, ~50KB+)

Não tratamos aqui (caso edge).

---

## Sinal vs ruído

**Sinal (manter):**
- `BUILD SUCCESSFUL in Ns` / `BUILD FAILED in Ns`
- `> Task :foo:bar FAILED`
- Test failures com stack traces
- `FAILURE: Build failed with an exception.` block + `* What went wrong:`
- Tasks que **não** são UP-TO-DATE/NO-SOURCE/FROM-CACHE — alguma coisa rodou
- Linha de `N actionable tasks: X executed, Y up-to-date`

**Ruído alto:**
- `Starting a Gradle Daemon (subsequent builds will be faster)` — banner
- `Daemon will be stopped at the end of the build...` — banner
- `> Configuring project :foo`
- `> Resolving dependencies of configuration '...'`
- `> Transform <jar>` — transform tasks (incremental compilation infra)
- **`> Task :foo:bar UP-TO-DATE`** — em build incremental, **dominante**
- `> Task :foo:bar NO-SOURCE` — task sem fontes pra processar
- `> Task :foo:bar FROM-CACHE` — task pulled do build cache
- `Downloading https://...` — primeira execução
- `<-------------> X% (Y/Z tasks complete)` — progress lines
- Linhas em branco entre blocks

---

## Estratégia proposta

### Pipeline declarativo (espelha rtk + augments)

```jsonc
{
  "name": "gradle",
  "matchCommand": "^(gradle|gradlew|\\./gradlew?)\\b",
  "matchCommandReject": "-q\\b|--quiet|--info|--debug|--stacktrace|--scan",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\s*$",
    "^> Configuring project ",
    "^> Resolving dependencies",
    "^> Transform ",
    "^Download(ing)?\\s+http",
    "^\\s*<-+>\\s+\\d+%",
    "^> Task :.*UP-TO-DATE$",
    "^> Task :.*NO-SOURCE$",
    "^> Task :.*FROM-CACHE$",
    "^> Task :.*SKIPPED$",
    "^Starting a Gradle Daemon",
    "^Daemon will be stopped",
    "^Welcome to Gradle"
  ],
  "matchOutput": [
    {
      "pattern": "BUILD SUCCESSFUL in [\\dms.]+",
      "message": "✓ gradle: BUILD SUCCESSFUL",
      "unless": "(?i)\\bFAILED\\b|\\bwarning\\b|tests? completed.*failed"
    }
  ],
  "maxLines": 50,
  "truncateLineAt": 200
}
```

**Saída esperada (build incremental ok):**

```
✓ gradle: BUILD SUCCESSFUL
```

**Saída esperada (build com falha de teste):**

```
> Task :app:test FAILED

UserServiceTest > shouldAuthenticateUser FAILED
    java.lang.AssertionError: expected:<true> but was:<false>
        at UserServiceTest.shouldAuthenticateUser(UserServiceTest.java:42)

3 tests completed, 1 failed

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:test'.
> There were failing tests. See the report at: file:///path/to/report/index.html

BUILD FAILED in 12s
3 actionable tasks: 3 executed
```

---

## Edge cases / NÃO filtrar quando

- [x] `-q` / `--quiet` → passthrough
- [x] `--info` / `--debug` / `--stacktrace` → passthrough (user pediu detalhe)
- [x] `--scan` → adiciona URL de build scan; preservar
- [x] `is_error: true` → filtrar mesmo assim (test failures preservados pelos strip patterns)
- [ ] **`gradle dependencies` / `gradle dependencyInsight`** — output muito específico, filter separado
- [ ] **`gradle init`** — interativo, fora de escopo
- [ ] **Gradle parallel mode** (`--parallel`) — output pode ter task lines interleaved out-of-order. Preservar.
- [ ] **`> Task :foo:bar` sem status** — alguma coisa rodou, manter
- [ ] **Test report URL** (`See the report at: file://...`) — manter, model pode querer abrir
- [ ] **Continuous build (`--continuous`)** — streaming, fora de escopo

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois (est.) | Redução |
|---|---|---|---|
| Build incremental tudo UP-TO-DATE | ~3.000 | ~30 (`match_output`) | **99%** |
| Build com 3 tasks executando | ~5.000 | ~150 | ~97% |
| Build com 1 task FAILED | ~6.000 | ~800 (preservados) | ~87% |
| Build cold (downloads + compile) | ~15.000 | ~500 | ~97% |
| Build com 5 testes falhando | ~10.000 | ~3.000 | ~70% |

---

## Open questions

- [ ] **Capturar amostras reais.** Instalar Gradle ou usar projeto Spring Boot demo.
- [ ] **`./gradlew test --rerun-tasks`** força rerun, output similar mas sem UP-TO-DATE. Mesmo filter funciona.
- [ ] **Build com `> Configure project` longo** (em multi-module com 50+ subprojects) — strip regex pega.
- [ ] **`> Task :app:bootRun`** que executa app interativamente — não filtrar (user output).

---

## Comparativo com rtk

- rtk: `filters/gradle.toml` — quase idêntico.
- **O que copiamos:** todos os strip patterns + truncate_lines_at: 150.
- **O que adicionamos:**
  - `match_output` para BUILD SUCCESSFUL (rtk usa `on_empty`)
  - `> Task :.*SKIPPED$` (rtk não cobre; é status válido a strippar)
  - Match pattern cobre `gradle`, `gradlew`, `./gradlew`, `./gradlew.bat` (Windows)
- rtk usa `truncate_lines_at: 150`; usamos 200 pra dar margem em test failure stack traces.

---

## Findings empíricos

**ZERO empirical findings** — gradle não instalado.

1. **Gradle build incremental é dominante em workflow real** — UP-TO-DATE em 80%+ das tasks comum.
2. **rtk filter é praticamente perfeito** — copiar quase verbatim.
3. **BUILD SUCCESSFUL `match_output`** é o win principal.
