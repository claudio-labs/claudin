#!/usr/bin/env bash
# Capture VERBATIM output from the checkers that are not installed on this host,
# by running each one for real inside its official container.
#
# Why this exists: every parser written from a remembered output format is a
# guess. `deno check` was parsed for `error: TS2551 [ERROR]: …`, a shape Deno
# does not emit — the unit test passed against the invented format and the tool
# degraded on the real one. These captures replace guesses with evidence.
#
# For each checker two runs are recorded:
#   <name>.txt          the command the tool actually issues, injected flags and
#                       all — this is what the parser must handle
#   <name>-noflags.txt  the same command without the injection, to show whether
#                       a flag we add (`-o`, `--offline`, `--no-restore`) is
#                       what broke the run rather than the code under test
#
# Usage: scripts/bench/ab/capture-checker-output.sh [name …]   (default: all)
set -u

OUT="${CAPTURE_DIR:-/tmp/checker-captures}"
mkdir -p "$OUT"

# Container writes land as root otherwise, and the tree is inspected afterwards.
UIDGID="$(id -u):$(id -g)"
DOCKER_RUN=(docker run --rm -u "$UIDGID" -e HOME=/w -w /w)

log() { printf '\n=== %s ===\n' "$1"; }

capture() { # capture <name> <image> <script>
  local name="$1" image="$2" script="$3"
  log "$name  [$image]"
  local work="$OUT/work-$name"
  rm -rf "$work"
  mkdir -p "$work"
  # Pull separately so a network failure is reported as such, not as a checker
  # that emitted nothing.
  if ! docker pull -q "$image" >/dev/null 2>&1; then
    printf 'PULL FAILED: %s\n' "$image" | tee "$OUT/$name.txt"
    return
  fi
  "${DOCKER_RUN[@]}" -v "$work:/w" "$image" bash -c "$script" \
    >"$OUT/$name.raw" 2>&1
  printf 'exit=%s\n' "$?" >>"$OUT/$name.raw"
  # Split the two runs the inner script separates with the sentinel.
  awk -v a="$OUT/$name.txt" -v b="$OUT/$name-noflags.txt" '
    /^@@@NOFLAGS@@@$/ { part=1; next }
    { print > (part ? b : a) }
  ' "$OUT/$name.raw"
  printf '  → %s (%s bytes)\n' "$OUT/$name.txt" "$(wc -c <"$OUT/$name.txt" 2>/dev/null || echo 0)"
}

# The name is always passed, so "no selection" means nothing AFTER the shift.
want() { local n="$1"; shift; [ "$#" -eq 0 ] && return 0; for a in "$@"; do [ "$a" = "$n" ] && return 0; done; return 1; }
SEL=("$@")
sel() { printf '%s\n' ${SEL[@]+"${SEL[@]}"}; }

# ---------------------------------------------------------------- dart
want dart ${SEL[@]+"${SEL[@]}"} && capture dart 'dart:stable' '
mkdir -p bin
cat > pubspec.yaml <<EOF
name: shop
environment:
  sdk: ">=3.0.0 <4.0.0"
EOF
cat > bin/main.dart <<EOF
void main() {
  int n = "not a number";
  print(n);
}
EOF
dart pub get --offline >/dev/null 2>&1
echo "--- dart analyze --format=machine ---"
dart analyze --format=machine
echo "exit=$?"
echo "@@@NOFLAGS@@@"
echo "--- dart analyze ---"
dart analyze
echo "exit=$?"
'

# ---------------------------------------------------------------- dotnet
# Two questions here: the output shape, and whether the injected --no-restore
# breaks a project that was never restored (NETSDK1004).
want dotnet ${SEL[@]+"${SEL[@]}"} && capture dotnet 'mcr.microsoft.com/dotnet/sdk:9.0' '
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
dotnet new console -o app >/dev/null 2>&1
cd app
cat > Program.cs <<EOF
int n = "not a number";
System.Console.WriteLine(n);
EOF
echo "--- dotnet build --no-restore -clp:NoSummary (restored by new) ---"
dotnet build --no-restore -clp:NoSummary
echo "exit=$?"
echo "@@@NOFLAGS@@@"
cd /w
rm -rf fresh && mkdir fresh && cd fresh
cat > fresh.csproj <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
EOF
cat > Program.cs <<EOF
int n = "not a number";
System.Console.WriteLine(n);
EOF
echo "--- NEVER RESTORED: dotnet build --no-restore -clp:NoSummary ---"
dotnet build --no-restore -clp:NoSummary
echo "exit=$?"
echo "--- same project, restore allowed ---"
dotnet build -clp:NoSummary
echo "exit=$?"
'

# ---------------------------------------------------------------- maven
# `-o` is offline. A cold ~/.m2 cannot resolve the compiler plugin offline, so
# this also answers whether the injected flag is safe on a first run.
want maven ${SEL[@]+"${SEL[@]}"} && capture maven 'maven:3.9-eclipse-temurin-17' '
mkdir -p src/main/java
cat > pom.xml <<EOF
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>shop</groupId>
  <artifactId>shop</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
EOF
cat > src/main/java/Main.java <<EOF
public class Main {
  public static void main(String[] args) {
    int n = "not a number";
    System.out.println(n);
  }
}
EOF
echo "--- mvn compile -q -o (cold ~/.m2) ---"
mvn compile -q -o
echo "exit=$?"
echo "@@@NOFLAGS@@@"
echo "--- mvn compile -q (online) ---"
mvn compile -q
echo "exit=$?"
'

# ---------------------------------------------------------------- gradle
want gradle ${SEL[@]+"${SEL[@]}"} && capture gradle 'gradle:8-jdk17' '
mkdir -p src/main/java
cat > build.gradle <<EOF
plugins { id "java" }
EOF
cat > settings.gradle <<EOF
rootProject.name = "shop"
EOF
cat > src/main/java/Main.java <<EOF
public class Main {
  public static void main(String[] args) {
    int n = "not a number";
    System.out.println(n);
  }
}
EOF
echo "--- gradle compileJava --offline ---"
gradle compileJava --offline --console=plain --no-daemon
echo "exit=$?"
echo "@@@NOFLAGS@@@"
echo "--- gradle compileJava ---"
gradle compileJava --console=plain --no-daemon
echo "exit=$?"
'

# ---------------------------------------------------------------- phpstan
want phpstan ${SEL[@]+"${SEL[@]}"} && capture phpstan 'composer:2' '
cat > composer.json <<EOF
{"require-dev":{"phpstan/phpstan":"^2.0"}}
EOF
cat > phpstan.neon <<EOF
parameters:
  level: 5
  paths:
    - src
EOF
mkdir -p src
cat > src/Money.php <<EOF
<?php
class Money {
  public function cents(): int {
    return "not a number";
  }
  public function boom(): void {
    \$this->missingMethod();
  }
}
EOF
composer install -q --no-interaction 2>&1 | tail -3
echo "--- phpstan analyse --error-format=json --no-progress ---"
vendor/bin/phpstan analyse --error-format=json --no-progress
echo "exit=$?"
echo "@@@NOFLAGS@@@"
echo "--- phpstan analyse ---"
vendor/bin/phpstan analyse
echo "exit=$?"
'

# ---------------------------------------------------------------- psalm
want psalm ${SEL[@]+"${SEL[@]}"} && capture psalm 'composer:2' '
cat > composer.json <<EOF
{"require-dev":{"vimeo/psalm":"^6.0"}}
EOF
mkdir -p src
cat > src/Money.php <<EOF
<?php
class Money {
  public function cents(): int {
    return "not a number";
  }
}
EOF
cat > psalm.xml <<EOF
<?xml version="1.0"?>
<psalm errorLevel="3" xmlns="https://getpsalm.org/schema/config">
  <projectFiles><directory name="src" /></projectFiles>
</psalm>
EOF
composer install -q --no-interaction 2>&1 | tail -3
echo "--- psalm --output-format=json --no-progress ---"
vendor/bin/psalm --output-format=json --no-progress
echo "exit=$?"
echo "@@@NOFLAGS@@@"
echo "--- psalm ---"
vendor/bin/psalm
echo "exit=$?"
'

printf '\nCaptures in %s\n' "$OUT"
