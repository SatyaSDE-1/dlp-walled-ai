import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendStatus } from '../shared/types';

export interface BackendOptions {
  /** Repository root: the directory that contains the `dlp` package. Used as the child's cwd. */
  root: string;
  /** Interpreter to use. Default: $WALLED_PYTHON, then <root>/.venv, then python3 / python on PATH. */
  pythonPath?: string;
  /** Extra arguments for `python -m dlp.server` (tests pass --auto-answer). */
  args?: string[];
  /** Give up after this many crash-restarts inside `restartWindowMs`. */
  maxRestarts?: number;
  restartWindowMs?: number;
  readyTimeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

export function resolvePython(root: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.WALLED_PYTHON) return process.env.WALLED_PYTHON;
  const venv =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Runs `python -m dlp.server` as a managed child process and speaks newline-delimited JSON with it over
 * stdin/stdout (a private pipe - no network port). See dlp/server.py for the protocol.
 *
 * Lifecycle: start() -> 'ready' handshake -> call()s -> stop(). If the child crashes it is restarted with
 * back-off; in-flight calls are rejected (never silently dropped). Emits 'status' (BackendStatus).
 */
export class PythonBackend extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuf = '';
  private stderrTail: string[] = [];
  private stopping = false;
  private crashTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private current: BackendStatus = { state: 'starting', restarts: 0 };

  constructor(private readonly opts: BackendOptions) {
    super();
  }

  get status(): BackendStatus {
    return this.current;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn the child and resolve once it has completed the handshake and answered a ping. */
  async start(): Promise<void> {
    this.stopping = false;
    await this.spawnChild();
  }

  /**
   * Send a request and await its response.
   * `timeoutMs: 0` disables the timeout - used for operations that wait on a person (confirmation dialog).
   */
  call<T = unknown>(op: string, payload: object = {}, timeoutMs = 15_000): Promise<T> {
    const child = this.child;
    if (!child || this.current.state !== 'ready') {
      return Promise.reject(new Error(`Python backend is not ready (state: ${this.current.state})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Python backend call '${op}' timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      child.stdin.write(JSON.stringify({ id, op, payload }) + '\n', (err) => {
        if (err) this.settle(id, err);
      });
    });
  }

  /** Graceful stop: ask the child to exit, then make sure it is gone. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) {
      this.setStatus({ state: 'stopped' });
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      child.stdin.write(JSON.stringify({ id: 0, op: 'shutdown' }) + '\n');
      child.stdin.end();
    } catch {
      /* pipe already closed */
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }

  /** Synchronous last resort for `before-quit`: never leave an orphan. */
  killNow(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.child?.kill('SIGKILL');
  }

  // ------------------------------------------------------------------ internals
  private setStatus(patch: Partial<BackendStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit('status', this.current);
  }

  private spawnChild(): Promise<void> {
    const { root } = this.opts;
    const python = resolvePython(root, this.opts.pythonPath);
    this.stdoutBuf = '';
    this.stderrTail = [];
    this.setStatus({ state: this.current.restarts ? 'restarting' : 'starting', detail: undefined });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(err);
      };

      const child = spawn(python, ['-u', '-m', 'dlp.server', ...(this.opts.args ?? [])], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;

      const readyTimer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`Python backend did not become ready within ${this.opts.readyTimeoutMs ?? 20000} ms`));
      }, this.opts.readyTimeoutMs ?? 20_000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuf += chunk;
        let nl: number;
        while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
          const line = this.stdoutBuf.slice(0, nl).trim();
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (line) this.onLine(line, () => {
            if (settled) return;
            settled = true;
            clearTimeout(readyTimer);
            // Handshake done: confirm the request/response path works end to end before declaring ready.
            this.current = { ...this.current, state: 'ready' };
            this.call<{ version: string }>('ping')
              .then((r) => {
                this.setStatus({ state: 'ready', version: r.version });
                resolve();
              })
              .catch(reject);
          });
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 40) this.stderrTail.shift();
          if (process.env.WALLED_E2E !== '1') console.error(`[python] ${line}`);
        }
      });

      child.on('error', (err) => {
        // e.g. ENOENT: interpreter not found
        this.setStatus({ state: 'failed', detail: `Could not start '${python}': ${err.message}` });
        fail(new Error(`Could not start '${python}': ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        const reason = `Python backend exited (${signal ?? `code ${code}`})`;
        this.rejectAllPending(new Error(reason));
        fail(new Error(`${reason}. ${this.stderrTail.slice(-5).join(' | ')}`));
        if (this.stopping) {
          this.setStatus({ state: 'stopped' });
          return;
        }
        this.onCrash(reason);
      });
    });
  }

  private onLine(line: string, onReady: () => void): void {
    let msg: { event?: string; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[python] non-protocol stdout ignored: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.event === 'ready') return onReady();
    if (typeof msg.id !== 'number') return;
    if (msg.ok) this.settle(msg.id, undefined, msg.result);
    else this.settle(msg.id, new Error(`${msg.error?.code ?? 'error'}: ${msg.error?.message ?? 'unknown error'}`));
  }

  private settle(id: number, err?: Error, value?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (err) entry.reject(err);
    else entry.resolve(value);
  }

  private rejectAllPending(err: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, err);
  }

  private onCrash(reason: string): void {
    const now = Date.now();
    const window = this.opts.restartWindowMs ?? 60_000;
    this.crashTimes = this.crashTimes.filter((t) => now - t < window);
    this.crashTimes.push(now);
    if (this.crashTimes.length > (this.opts.maxRestarts ?? 5)) {
      this.setStatus({ state: 'failed', detail: `${reason}; giving up after repeated crashes` });
      return;
    }
    const delay = Math.min(250 * 2 ** (this.crashTimes.length - 1), 4000);
    this.setStatus({ state: 'restarting', detail: reason, restarts: this.current.restarts + 1 });
    this.restartTimer = setTimeout(() => {
      this.spawnChild().catch((err: Error) => {
        // spawnChild's own exit handler schedules the next attempt; just record why this one failed.
        this.setStatus({ detail: err.message });
      });
    }, delay);
  }
}
