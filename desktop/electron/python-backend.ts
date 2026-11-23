import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { BackendStatus } from '../shared/types';

const PROTOCOL_VERSION = 1;
const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const INSPECTION_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const KILL_TIMEOUT_MS = 1_000;
const MAX_RESPONSE_LENGTH = 1024 * 1024;
const MAX_PENDING_REQUESTS = 4;

export interface BackendOptions {
  /** Directory that contains the dlp package. Used as the child's working directory. */
  root: string;
  /** A stale Electron preload and a differently configured backend must never share approvals. */
  marker: string;
  /** Explicit bundled interpreter; development defaults to WALLED_PYTHON, .venv or system Python. */
  pythonPath?: string;
  /** Extra arguments for python -m dlp.server. */
  args?: string[];
  maxRestarts?: number;
  restartWindowMs?: number;
  readyTimeoutMs?: number;
}

interface BackendError {
  code: string;
  message: string;
}

type Decision = { allow: true; error?: never } | { allow: false; error?: BackendError };

interface BackendResults {
  ping: { pong: true; version: string; marker: string; protocol: number };
  init_script: { script: string };
  prompt: Decision;
  file: Decision;
  request: Decision;
  shutdown: Record<string, never>;
}

type Operation = keyof BackendResults;

interface Pending {
  op: Operation;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface BackendProcess {
  child: ChildProcessWithoutNullStreams;
  firstId: number;
  pending: Map<number, Pending>;
  exited: Promise<void>;
  onReady?: (version: string) => void;
  rejectReady(error: Error): void;
  failure?: Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackendError(value: unknown): value is BackendError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function validResult(op: Operation, value: Record<string, unknown>): boolean {
  switch (op) {
    case 'ping':
      return value.pong === true && value.protocol === PROTOCOL_VERSION
        && typeof value.version === 'string' && value.version.length > 0
        && typeof value.marker === 'string';
    case 'init_script':
      return typeof value.script === 'string' && value.script.length > 0;
    case 'prompt':
    case 'file':
    case 'request':
      return typeof value.allow === 'boolean'
        && (value.error === undefined || (value.allow === false && isBackendError(value.error)));
    case 'shutdown':
      return Object.keys(value).length === 0;
  }
}

export function resolvePython(root: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.WALLED_PYTHON) return process.env.WALLED_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Owns the Python server and its private newline-delimited JSON connection. */
export class PythonBackend extends EventEmitter {
  private active?: BackendProcess;
  private nextId = 1;
  private startup?: Promise<void>;
  private stopping = false;
  private shutdown?: Promise<BackendResults['shutdown']>;
  private crashTimes: number[] = [];
  private restartTimer?: NodeJS.Timeout;
  private current: BackendStatus = { state: 'starting', restarts: 0 };

  constructor(private readonly opts: BackendOptions) {
    super();
  }

  get status(): BackendStatus {
    return this.current;
  }

  get pid(): number | undefined {
    return this.active?.child.pid;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Python backend is shutting down'));
    if (this.startup) return this.startup;
    if (this.active || this.restartTimer) {
      return this.current.state === 'ready' ? Promise.resolve()
        : Promise.reject(new Error('Python backend is restarting'));
    }

    this.startup = this.spawnChild().finally(() => { this.startup = undefined; });
    return this.startup;
  }

  /** Zero uses the default deadline. Only validated replies produce inspection decisions. */
  async call<Op extends Operation>(op: Op, payload: object = {}, timeoutMs = 0): Promise<BackendResults[Op]> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2 ** 31 - 1) {
      throw new RangeError('Invalid Python backend request timeout');
    }
    if (op === 'shutdown') {
      return this.beginShutdown(timeoutMs || SHUTDOWN_TIMEOUT_MS) as Promise<BackendResults[Op]>;
    }

    const backend = this.active;
    if (this.stopping || !backend || backend.failure || this.current.state !== 'ready') {
      throw new Error(`Python backend is not ready (state: ${this.current.state})`);
    }
    if (backend.pending.size >= MAX_PENDING_REQUESTS) throw new Error('Python backend is busy');
    const inspection = op === 'prompt' || op === 'file' || op === 'request';
    return this.send(backend, op, payload, timeoutMs || (inspection ? INSPECTION_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
  }

  /** Stop accepting work and give Python time to exit before forcing termination. */
  async stop(): Promise<void> {
    try {
      await this.beginShutdown(SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      console.warn('[python] Graceful shutdown failed:', error);
    }
  }

  private setStatus(patch: Partial<BackendStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit('status', this.current);
  }

  private async spawnChild(): Promise<void> {
    const { root } = this.opts;
    let child: ChildProcessWithoutNullStreams;
    try {
      const python = resolvePython(root, this.opts.pythonPath);
      // Keep signed resources read-only and prevent system or user Python dependencies from shadowing the bundle.
      const flags = this.opts.pythonPath ? ['-B', '-E', '-s', '-X', 'utf8'] : [];
      child = spawn(python, [...flags, '-u', '-m', 'dlp.server', ...(this.opts.args ?? [])], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      const failure = new Error(`Could not start Python backend: ${String(error)}`);
      this.onCrash(failure);
      throw failure;
    }

    let onReady!: (version: string) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => {
      onReady = resolve;
      rejectReady = reject;
    });
    let signalExit!: () => void;
    const exited = new Promise<void>((resolve) => { signalExit = resolve; });
    const backend: BackendProcess = { child, firstId: this.nextId, pending: new Map(), onReady, rejectReady, exited };
    this.active = backend;

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.active !== backend) return;
      this.active = undefined;
      signalExit();
      if (this.stopping) {
        this.setStatus({ state: 'stopped', version: undefined, detail: undefined });
        return;
      }
      backend.failure ??= new Error(`Python backend exited (${signal ?? `code ${code}`})`);
      this.rejectWork(backend, backend.failure);
      this.onCrash(backend.failure);
    };
    child.once('exit', onExit);
    child.once('close', onExit); // A failed spawn can reach close without emitting exit.

    const onTransportError = (error: Error) => {
      this.fail(backend, new Error(`Python backend connection failed: ${error.message}`));
    };
    child.on('error', onTransportError);
    child.stdin.on('error', onTransportError);
    child.stdout.on('error', onTransportError);
    this.readResponses(backend);

    const logs = createInterface({ input: child.stderr, terminal: false, crlfDelay: Infinity });
    logs.on('line', (line) => { if (line.trim()) console.error(`[python] ${line}`); });
    logs.on('error', (error) => console.warn('[python] Could not read backend logs:', error.message));

    const startupTimeout = this.opts.readyTimeoutMs ?? STARTUP_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.fail(backend, new Error(`Python backend handshake timed out after ${startupTimeout} ms`));
    }, startupTimeout);
    this.setStatus({ state: this.current.restarts ? 'restarting' : 'starting', version: undefined, detail: undefined });
    try {
      const version = await ready;
      if (this.stopping || backend.failure) throw backend.failure ?? new Error('Python backend is shutting down');
      const ping = await this.send(backend, 'ping', {}, startupTimeout);
      if (this.stopping || backend.failure) throw backend.failure ?? new Error('Python backend is shutting down');
      if (ping.version !== version) throw new Error('Python backend reported inconsistent versions during startup');
      if (ping.marker !== this.opts.marker) throw new Error('Python and Electron DLP markers differ. Rebuild Electron.');
      this.setStatus({ state: 'ready', version, detail: undefined });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.stopping) this.fail(backend, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  private readResponses(backend: BackendProcess): void {
    const stream = backend.child.stdout;
    let remainder = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      if (backend.failure) return;
      const received = remainder + chunk;
      let start = 0;
      let newline = received.indexOf('\n');
      while (newline !== -1 && !backend.failure) {
        if (newline - start > MAX_RESPONSE_LENGTH) {
          this.fail(backend, new Error('Python backend response exceeded the protocol size limit'));
          return;
        }
        this.onLine(backend, received.slice(start, newline));
        start = newline + 1;
        newline = received.indexOf('\n', start);
      }
      remainder = backend.failure ? '' : received.slice(start);
      if (remainder.length > MAX_RESPONSE_LENGTH) {
        this.fail(backend, new Error('Python backend response exceeded the protocol size limit'));
        remainder = '';
      }
    });
    stream.once('end', () => {
      if (backend.failure) return;
      if (remainder.length) {
        this.fail(backend, new Error('Python backend closed stdout mid-response'));
      } else if (this.stopping) {
        this.rejectWork(backend, new Error('Python backend exited before acknowledging shutdown'));
      } else {
        this.fail(backend, new Error('Python backend exited or closed its protocol stream'));
      }
    });
  }

  private onLine(backend: BackendProcess, line: string): void {
    const malformed = () => this.fail(backend, new Error('Python backend sent a malformed protocol response'));
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      malformed();
      return;
    }
    if (!isRecord(message)) return malformed();

    if ('event' in message) {
      const onReady = backend.onReady;
      if (message.event !== 'ready' || !onReady || message.protocol !== PROTOCOL_VERSION
        || typeof message.version !== 'string' || !message.version
        || typeof message.pid !== 'number' || message.pid !== backend.child.pid) {
        return malformed();
      }
      backend.onReady = undefined;
      onReady(message.version);
      return;
    }

    const { id, ok, result, error } = message;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < backend.firstId || id >= this.nextId) {
      return malformed();
    }
    if (ok === false && result === undefined && isBackendError(error)) {
      this.settle(backend, id, new Error(`${error.code}: ${error.message}`));
      return;
    }
    if (ok !== true || error !== undefined || !isRecord(result)) return malformed();

    const pending = backend.pending.get(id);
    if (!pending) return; // A timed-out or completed request cannot be resolved again.
    if (!validResult(pending.op, result)) return malformed();
    this.settle(backend, id, undefined, result);
  }

  private async send<Op extends Operation>(
    backend: BackendProcess, op: Op, payload: object, timeoutMs: number,
  ): Promise<BackendResults[Op]> {
    if (backend.failure) throw backend.failure;
    if (!Number.isSafeInteger(this.nextId)) throw new Error('Python backend request IDs exhausted');
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, payload }) + '\n';
    return new Promise<BackendResults[Op]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Python backend call '${op}' timed out after ${timeoutMs} ms`);
        if (op === 'shutdown') {
          this.settle(backend, id, error);
        } else {
          // Discard queued work and dismiss any dialog that no longer has a live request.
          this.fail(backend, error);
        }
      }, timeoutMs);
      backend.pending.set(id, { op, timer, resolve: (value) => resolve(value as BackendResults[Op]), reject });
      try {
        if (op === 'shutdown') {
          backend.child.stdin.end(line);
        } else {
          backend.child.stdin.write(line, (error) => {
            if (error) this.fail(backend, new Error(`Could not write to Python backend: ${error.message}`));
          });
        }
      } catch (error) {
        this.fail(backend, new Error(`Could not write to Python backend: ${String(error)}`));
      }
    });
  }

  private settle(backend: BackendProcess, id: number, error?: Error, value?: unknown): void {
    const pending = backend.pending.get(id);
    if (!pending) return;
    backend.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private rejectWork(backend: BackendProcess, error: Error): void {
    backend.rejectReady(error);
    for (const id of backend.pending.keys()) this.settle(backend, id, error);
  }

  private fail(backend: BackendProcess, failure: Error): void {
    if (backend.failure) return;
    backend.failure = failure;
    this.rejectWork(backend, failure);
    if (this.active !== backend) return;
    if (!this.stopping) this.setStatus({ state: 'restarting', version: undefined, detail: failure.message });
    // EOF gives Python a chance to dismiss native dialogs even when the protocol is unusable.
    backend.child.stdin.destroy();
    const killTimer = setTimeout(() => {
      if (this.active === backend) this.kill(backend);
    }, SHUTDOWN_TIMEOUT_MS);
    void backend.exited.then(() => clearTimeout(killTimer));
  }

  private kill(backend: BackendProcess): void {
    try {
      backend.child.kill('SIGKILL');
    } catch (error) {
      console.error('[python] Could not terminate backend:', error);
    }
  }

  private beginShutdown(timeoutMs: number): Promise<BackendResults['shutdown']> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.shutdown = Promise.resolve().then(() => this.stopChild(Math.min(timeoutMs, SHUTDOWN_TIMEOUT_MS)));
    return this.shutdown;
  }

  private async stopChild(timeoutMs: number): Promise<BackendResults['shutdown']> {
    const backend = this.active;
    if (!backend) {
      this.setStatus({ state: 'stopped', version: undefined, detail: undefined });
      return {};
    }

    this.rejectWork(backend, new Error('Python backend is shutting down'));
    const reply = this.send(backend, 'shutdown', {}, timeoutMs);
    const killTimer = setTimeout(() => {
      if (this.active !== backend) return;
      console.warn('[python] Shutdown grace period expired, terminating backend');
      this.kill(backend);
    }, timeoutMs);
    let exitTimer: NodeJS.Timeout | undefined;
    const exit = Promise.race([
      backend.exited,
      new Promise<never>((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('Python backend did not exit')), timeoutMs + KILL_TIMEOUT_MS);
      }),
    ]);
    try {
      const [response, termination] = await Promise.allSettled([reply, exit]);
      if (termination.status === 'rejected') throw termination.reason;
      if (response.status === 'rejected') throw response.reason;
      return response.value;
    } finally {
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
    }
  }

  private onCrash(failure: Error): void {
    console.error('[python]', failure.message);
    const now = Date.now();
    const window = this.opts.restartWindowMs ?? 60_000;
    this.crashTimes = this.crashTimes.filter((time) => now - time < window);
    this.crashTimes.push(now);
    if (this.crashTimes.length > (this.opts.maxRestarts ?? 5)) {
      this.setStatus({ state: 'failed', version: undefined, detail: `${failure.message}; restart limit reached` });
      return;
    }

    const delay = Math.min(250 * 2 ** (this.crashTimes.length - 1), 4000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch(() => {}); // Process failures are logged and handled by onCrash.
    }, delay);
    this.setStatus({ state: 'restarting', version: undefined, detail: failure.message, restarts: this.current.restarts + 1 });
  }
}
