/**
 * MCP IDE server. Exposes a WebSocket on 127.0.0.1:<ephemeral-port> that the
 * claudio CLI's MCP client connects to via the ws-ide transport.
 *
 * Phase 1: completes the JSON-RPC handshake (initialize + tools/list) so the
 * CLI's status indicator can show a real "connected" state. No tools are
 * advertised yet — selection / openDiff / at-mention land in later phases.
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const vscode = require('vscode');

const {
  writeLockfile,
  deleteLockfile,
  cleanupStaleLockfiles,
} = require('./lockfile');

const AUTH_HEADER = 'x-claude-code-ide-authorization';
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

function generateAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readExtensionVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch (_err) {
    return '0.0.0';
  }
}

class IdeServer {
  constructor(options = {}) {
    this._wss = null;
    this._port = 0;
    this._authToken = null;
    this._connections = new Set();
    this._started = false;
    this._output = options.outputChannel || vscode.window.createOutputChannel('Claudio MCP');
    this._ownsOutputChannel = !options.outputChannel;
    this._extensionVersion = readExtensionVersion();
  }

  log(message) {
    this._output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  get port() {
    return this._port;
  }

  async start() {
    if (this._started) return;

    cleanupStaleLockfiles();

    this._authToken = generateAuthToken();
    this._wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, cb) => {
        const provided = info.req.headers[AUTH_HEADER];
        if (provided !== this._authToken) {
          this.log(`auth rejected: missing/invalid ${AUTH_HEADER}`);
          cb(false, 401, 'Unauthorized');
          return;
        }
        cb(true);
      },
    });

    await new Promise((resolve, reject) => {
      const onListening = () => {
        this._wss.off('error', onError);
        resolve();
      };
      const onError = err => {
        this._wss.off('listening', onListening);
        reject(err);
      };
      this._wss.once('listening', onListening);
      this._wss.once('error', onError);
    });

    const addr = this._wss.address();
    this._port = typeof addr === 'object' && addr ? addr.port : 0;
    if (!this._port) {
      throw new Error('failed to bind ephemeral port');
    }

    this._wss.on('connection', ws => this._handleConnection(ws));
    this._wss.on('error', err => this.log(`server error: ${err.message}`));

    this._writeLockfile();
    this._started = true;
    this.log(`listening on 127.0.0.1:${this._port}`);
  }

  async stop() {
    if (!this._started) return;
    this._started = false;

    for (const ws of this._connections) {
      try {
        ws.close(1001, 'shutting down');
      } catch (_err) {
        // ignore
      }
    }
    this._connections.clear();

    deleteLockfile(this._port);

    if (this._wss) {
      const wss = this._wss;
      await new Promise(resolve => wss.close(() => resolve()));
    }

    this._wss = null;
    this._port = 0;
    this._authToken = null;

    if (this._ownsOutputChannel) {
      this._output.dispose();
    }
  }

  _writeLockfile() {
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    writeLockfile({
      port: this._port,
      authToken: this._authToken,
      ideName: vscode.env.appName || 'VS Code',
      workspaceFolders: folders,
      transport: 'ws',
    });
  }

  _handleConnection(ws) {
    this._connections.add(ws);
    this.log('client connected');

    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_err) {
        this.log(`bad json frame: ${String(raw).slice(0, 200)}`);
        return;
      }
      this._dispatch(ws, msg);
    });

    ws.on('close', () => {
      this._connections.delete(ws);
      this.log('client disconnected');
    });

    ws.on('error', err => {
      this.log(`ws error: ${err && err.message}`);
    });
  }

  _dispatch(ws, msg) {
    if (!msg || typeof msg !== 'object') return;

    const method = msg.method;

    if (method === 'initialize') {
      const requestedVersion = msg.params && typeof msg.params.protocolVersion === 'string'
        ? msg.params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
      this._sendResult(ws, msg.id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'claudio-vscode',
          version: this._extensionVersion,
        },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      // client signaled it finished initializing; nothing to do
      return;
    }

    if (method === 'ide_connected') {
      const pid = msg.params && msg.params.pid;
      this.log(`ide_connected from pid=${pid}`);
      return;
    }

    if (method === 'tools/list') {
      this._sendResult(ws, msg.id, { tools: [] });
      return;
    }

    if (method === 'ping') {
      this._sendResult(ws, msg.id, {});
      return;
    }

    if (typeof msg.id !== 'undefined') {
      this._sendError(ws, msg.id, -32601, `Method not found: ${method}`);
    }
  }

  _sendResult(ws, id, result) {
    const frame = { jsonrpc: '2.0', id, result };
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log(`send result failed: ${err && err.message}`);
    }
  }

  _sendError(ws, id, code, message) {
    const frame = { jsonrpc: '2.0', id, error: { code, message } };
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log(`send error failed: ${err && err.message}`);
    }
  }
}

module.exports = {
  IdeServer,
  AUTH_HEADER,
  DEFAULT_PROTOCOL_VERSION,
};
