/**
 * IDE lockfile helpers for the claudio MCP server.
 *
 * Lockfile format (~/.claudio/ide/<port>.lock) matches what the claudio CLI
 * client expects to read in src/utils/ide.ts:346-388.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getClaudioConfigHomeDir() {
  const override = process.env.CLAUDIO_CONFIG_DIR;
  if (override && override.trim()) {
    return override;
  }
  return path.join(os.homedir(), '.claudio');
}

function getIdeLockfilesDir() {
  return path.join(getClaudioConfigHomeDir(), 'ide');
}

function ensureIdeLockfilesDir() {
  const dir = getIdeLockfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLockfilePath(port) {
  return path.join(getIdeLockfilesDir(), `${port}.lock`);
}

function writeLockfile({ port, authToken, ideName, workspaceFolders, transport }) {
  ensureIdeLockfilesDir();
  const payload = {
    workspaceFolders: Array.isArray(workspaceFolders) ? workspaceFolders : [],
    pid: process.pid,
    ideName: ideName || 'VS Code',
    transport: transport === 'sse' ? 'sse' : 'ws',
    runningInWindows: process.platform === 'win32',
    authToken,
  };
  fs.writeFileSync(getLockfilePath(port), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function deleteLockfile(port) {
  try {
    fs.unlinkSync(getLockfilePath(port));
  } catch (_err) {
    // already gone — fine
  }
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user
    return err && err.code === 'EPERM';
  }
}

function cleanupStaleLockfiles() {
  const dir = getIdeLockfilesDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return; // dir doesn't exist yet — nothing to clean
  }
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const full = path.join(dir, name);
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (_err) {
      // unreadable / not JSON — treat as stale
    }
    const pid = data && typeof data.pid === 'number' ? data.pid : null;
    if (!isProcessAlive(pid)) {
      try {
        fs.unlinkSync(full);
      } catch (_err) {
        // vanished underneath us — fine
      }
    }
  }
}

module.exports = {
  getClaudioConfigHomeDir,
  getIdeLockfilesDir,
  ensureIdeLockfilesDir,
  getLockfilePath,
  writeLockfile,
  deleteLockfile,
  isProcessAlive,
  cleanupStaleLockfiles,
};
