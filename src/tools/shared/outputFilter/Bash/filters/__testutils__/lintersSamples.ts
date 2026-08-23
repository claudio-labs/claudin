// Real captured command output for the linters filters (uv / poetry / basedpyright / ty).
//
// NOT synthetic. Each const is verbatim output of the named tool, with a
// `// source:` pointer so the origin is auditable:
//   - rtk  → ../rtk/src/filters/<cmd>.toml `[[tests.X]]` (real captures the
//            rtk project shipped) or ../rtk/src/cmds/<lang>/<cmd>.rs.
//   - web  → CI logs / GitHub issues / docs (URL in the comment).
//
// Convention per command: an `*_OK` (success / up-to-date — exercises the
// short-circuit) and an `*_ERR` (failure / diagnostics — proves the
// `unless: HAS_ERROR` guard preserves the failure).
//
// NOT a `.test` file — pure data.

// source: ../rtk/src/filters/uv-sync.toml [[tests.uv-sync]] "audited short-circuit"
export const UV_OK = `Resolved 42 packages in 123ms
Audited 42 packages in 0.05ms
`;

// source: ../rtk/src/filters/uv-sync.toml [[tests.uv-sync]] "install strips downloads"
export const UV_INSTALL = `  Downloading requests-2.31.0-py3-none-any.whl (62.6 kB)
  Using cached certifi-2023.11.17-py3-none-any.whl (162 kB)
  Preparing packages...
Installed 5 packages in 23ms
 + certifi==2023.11.17
 + charset-normalizer==3.3.2
 + idna==3.6
 + requests==2.31.0
 + urllib3==2.1.0
`;

// source: ../rtk/src/filters/poetry-install.toml [[tests.poetry-install]] "up to date"
export const POETRY_OK = `Installing dependencies from lock file

No dependencies to install or update
`;

// source: ../rtk/src/filters/poetry-install.toml [[tests.poetry-install]] "install strips"
export const POETRY_INSTALL = `Installing dependencies from lock file

  - Downloading requests-2.31.0-py3-none-any.whl (62.6 kB)
  - Installing certifi (2023.11.17)
  - Installing charset-normalizer (3.3.2)
  - Installing idna (3.6)
  - Installing urllib3 (2.1.0)
  - Installing requests (2.31.0)

Writing lock file
`;

// source: ../rtk/src/filters/basedpyright.toml [[tests.basedpyright]]
export const BASEDPYRIGHT_ERR = `basedpyright 1.22.0
Searching for source files
Found 42 source files

/home/user/app/main.py
  /home/user/app/main.py:10:5 - error: "foo" is not defined (reportUndefinedVariable)
  /home/user/app/main.py:25:1 - error: Type "str" is not assignable to type "int" (reportAssignmentType)

/home/user/app/utils.py
  /home/user/app/utils.py:8:9 - warning: Variable "x" is not accessed (reportUnusedVariable)

3 errors, 1 warning, 0 informations
`;

// source: ../rtk/src/filters/basedpyright.toml [[tests.basedpyright]] "clean output"
export const BASEDPYRIGHT_CLEAN = `basedpyright 1.22.0
Searching for source files
Found 10 source files

0 errors, 0 warnings, 0 informations
`;

// source: ../rtk/src/filters/ty.toml [[tests.ty]]
export const TY_ERR = `ty 0.1.0
Checking 15 files

error[unresolved-reference]: Name \`foo\` used when not defined
  --> app/main.py:10:5
   |
10 |     foo()
   |     ^^^
   |

warning[unused-variable]: Variable \`x\` is not used
  --> app/utils.py:8:9
   |
 8 |     x = 42
   |     ^
   |

Found 1 error, 1 warning
`;

// source: ../rtk/src/filters/ty.toml [[tests.ty]] "clean output"
export const TY_CLEAN = `ty 0.1.0
Checking 10 files

All checks passed!
`;
