// Real captured command output for the php filters (composer).
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

// source: ../rtk/src/filters/composer-install.toml [[tests.composer-install]]
export const COMPOSER_NOTHING = `Loading composer repositories with package information
Updating dependencies
Lock file operations: 0 installs, 0 updates, 0 removals
Nothing to install, update or remove
Generating autoload files
`;

// source: ../rtk/src/filters/composer-install.toml [[tests.composer-install]]
export const COMPOSER_INSTALL = `Loading composer repositories with package information
Updating dependencies
  - Downloading symfony/console (v6.4.0)
  - Installing symfony/console (v6.4.0): Extracting archive
  - Downloading psr/log (3.0.0)
  - Installing psr/log (3.0.0): Extracting archive
Writing lock file
Generating autoload files
`;

// source: getcomposer.org canonical dependency-resolution failure format
// (the "Your requirements could not be resolved" / "Problem N" block composer
// prints on an unsatisfiable constraint).
export const COMPOSER_ERR = `Loading composer repositories with package information
Updating dependencies
Your requirements could not be resolved to an installable set of packages.

  Problem 1
    - Root composer.json requires php >=8.2 but your php version (8.1.0) does not satisfy that requirement.
`;
