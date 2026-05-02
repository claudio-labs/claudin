const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getClaudioConfigHomeDir,
  getIdeLockfilesDir,
  writeLockfile,
  deleteLockfile,
  isProcessAlive,
  cleanupStaleLockfiles,
} = require('./lockfile');

function withTempConfigDir(name, fn) {
  return async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `claudio-lockfile-${name}-`));
    const prev = process.env.CLAUDIO_CONFIG_DIR;
    process.env.CLAUDIO_CONFIG_DIR = tmpRoot;
    try {
      await fn(tmpRoot);
    } finally {
      if (prev === undefined) delete process.env.CLAUDIO_CONFIG_DIR;
      else process.env.CLAUDIO_CONFIG_DIR = prev;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  };
}

test('getClaudioConfigHomeDir respects CLAUDIO_CONFIG_DIR', () => {
  const prev = process.env.CLAUDIO_CONFIG_DIR;
  process.env.CLAUDIO_CONFIG_DIR = '/tmp/claudio-test-override';
  try {
    assert.equal(getClaudioConfigHomeDir(), '/tmp/claudio-test-override');
    assert.equal(getIdeLockfilesDir(), '/tmp/claudio-test-override/ide');
  } finally {
    if (prev === undefined) delete process.env.CLAUDIO_CONFIG_DIR;
    else process.env.CLAUDIO_CONFIG_DIR = prev;
  }
});

test('getClaudioConfigHomeDir falls back to ~/.claudio when env unset', () => {
  const prev = process.env.CLAUDIO_CONFIG_DIR;
  delete process.env.CLAUDIO_CONFIG_DIR;
  try {
    assert.equal(getClaudioConfigHomeDir(), path.join(os.homedir(), '.claudio'));
  } finally {
    if (prev !== undefined) process.env.CLAUDIO_CONFIG_DIR = prev;
  }
});

test(
  'writeLockfile then deleteLockfile is a clean round-trip',
  withTempConfigDir('roundtrip', tmpRoot => {
    const port = 54321;
    const payload = writeLockfile({
      port,
      authToken: 'token-abc',
      ideName: 'Test IDE',
      workspaceFolders: ['/some/path'],
      transport: 'ws',
    });
    const lockPath = path.join(tmpRoot, 'ide', `${port}.lock`);
    assert.ok(fs.existsSync(lockPath), 'lockfile should exist after write');
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.deepEqual(onDisk, payload);
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.transport, 'ws');
    assert.equal(typeof onDisk.runningInWindows, 'boolean');

    deleteLockfile(port);
    assert.ok(!fs.existsSync(lockPath), 'lockfile should be gone after delete');

    // deleteLockfile on a missing file must not throw
    assert.doesNotThrow(() => deleteLockfile(port));
  }),
);

test(
  'writeLockfile defaults transport to ws and creates parent dir',
  withTempConfigDir('defaults', tmpRoot => {
    // ensure ide/ does not exist yet
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'ide')));
    const payload = writeLockfile({ port: 1234, authToken: 't' });
    assert.equal(payload.transport, 'ws');
    assert.equal(payload.ideName, 'VS Code');
    assert.deepEqual(payload.workspaceFolders, []);
    assert.ok(fs.existsSync(path.join(tmpRoot, 'ide', '1234.lock')));
  }),
);

test('isProcessAlive returns true for self, false for impossible pid', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(NaN), false);
  assert.equal(isProcessAlive(undefined), false);
  // pid 999999 is unlikely to exist on a CI runner
  assert.equal(isProcessAlive(999999), false);
});

test(
  'cleanupStaleLockfiles removes dead-PID lockfiles and keeps live ones',
  withTempConfigDir('cleanup', tmpRoot => {
    const ideDir = path.join(tmpRoot, 'ide');
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideDir, '1.lock'),
      JSON.stringify({ pid: 999999, authToken: 'x' }),
    );
    fs.writeFileSync(
      path.join(ideDir, '2.lock'),
      JSON.stringify({ pid: process.pid, authToken: 'y' }),
    );
    fs.writeFileSync(path.join(ideDir, '3.lock'), 'not json');
    fs.writeFileSync(path.join(ideDir, 'README.md'), 'should be ignored');

    cleanupStaleLockfiles();

    assert.ok(!fs.existsSync(path.join(ideDir, '1.lock')), 'dead-pid lockfile removed');
    assert.ok(fs.existsSync(path.join(ideDir, '2.lock')), 'live-pid lockfile kept');
    assert.ok(!fs.existsSync(path.join(ideDir, '3.lock')), 'unparseable lockfile removed');
    assert.ok(fs.existsSync(path.join(ideDir, 'README.md')), 'non-lock files ignored');
  }),
);

test(
  'cleanupStaleLockfiles is a no-op when ide dir does not exist',
  withTempConfigDir('no-dir', _tmpRoot => {
    assert.doesNotThrow(() => cleanupStaleLockfiles());
  }),
);
