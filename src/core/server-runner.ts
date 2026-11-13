import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { splitCommandTokens } from './model-tester.js';

export type ServerStatusState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type ServerLogVerbosity = 'minimal' | 'all';

export const DEFAULT_MAX_SERVER_LOG_LINES = 200;
export const MAX_SINGLE_LOG_LINE_LENGTH = 500;
export const DEFAULT_SERVE_HOST = '0.0.0.0';
export const DEFAULT_SERVE_PORT = 8080;

export interface LlamaServeCommandSpec {
  command: string;
  args: string[];
  displayCommand: string;
}

export interface ServerStateSnapshot {
  status: ServerStatusState;
  pid?: number;
  listeningUrl?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
  startedAt?: number;
}

export interface StartLlamaServeOptions {
  presetPath: string;
  serveCommand?: string;
  serveHost?: string;
  servePort?: number;
  verbosity?: ServerLogVerbosity;
  maxLogLines?: number;
  onStateChange?: (snapshot: ServerStateSnapshot) => void;
  onLogLine?: (line: string) => void;
}

export interface RunningLlamaServeController {
  readonly pid: number | undefined;
  readonly commandSpec: LlamaServeCommandSpec;
  stop: () => Promise<void>;
  killImmediate: () => void;
}

/**
 * Builds the `llama serve --models-preset <presetPath> --host <host> --port <port>` command and argument list.
 */
export function buildLlamaServeCommandArgs(
  presetPath: string,
  serveCommand = 'llama serve',
  serveHost = DEFAULT_SERVE_HOST,
  servePort = DEFAULT_SERVE_PORT
): LlamaServeCommandSpec {
  const tokens = splitCommandTokens(serveCommand.trim() || 'llama serve');
  const command = tokens[0] ?? 'llama';
  const baseArgs = tokens.slice(1);
  const resolvedPreset = path.resolve(presetPath);
  const args = [...baseArgs, '--models-preset', resolvedPreset];

  const hasHostFlag = baseArgs.some((a) => a === '--host' || a.startsWith('--host='));
  const hasPortFlag = baseArgs.some((a) => a === '--port' || a.startsWith('--port='));

  if (!hasHostFlag) {
    const normalizedHost = serveHost.trim() || DEFAULT_SERVE_HOST;
    args.push('--host', normalizedHost);
  }

  if (!hasPortFlag) {
    const normalizedPort =
      typeof servePort === 'number' &&
      Number.isInteger(servePort) &&
      servePort >= 1 &&
      servePort <= 65535
        ? servePort
        : DEFAULT_SERVE_PORT;
    args.push('--port', String(normalizedPort));
  }

  const quotedArgs = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return {
    command,
    args,
    displayCommand: `${command} ${quotedArgs.join(' ')}`,
  };
}

const NOISY_MINIMAL_PATTERNS: RegExp[] = [
  /^llama_model_loader:\s*-\s*(kv|type)\b/i,
  /^llm_load_(tensors|vocab|print_meta):/i,
  /^load_tensors:/i,
  /^ggml_.*(buffer|backend|init|alloc)/i,
  /^print_info:/i,
  /^common_init_from_params:/i,
  /^system_info:/i,
  /^\.+$/,
];

const IMPORTANT_MINIMAL_PATTERNS: RegExp[] = [
  /\b(error|err|warn|warning|fatal|fail|failed|oom|out of memory|exception|invalid|cannot|unable)\b/i,
  /\b(listening|http server|server is listening|starting|started|stopping|stopped|loaded|ready|shutdown)\b/i,
  /https?:\/\/[^\s]+/i,
  /\b(GET|POST|PUT|DELETE)\s+\//,
  /\b(slot|model|preset)\b/i,
];

/**
 * Determines whether a normalized server log line should be kept under the active verbosity mode.
 */
export function shouldIncludeServerLogLine(
  line: string,
  verbosity: ServerLogVerbosity = 'minimal'
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (verbosity === 'all') return true;

  for (const important of IMPORTANT_MINIMAL_PATTERNS) {
    if (important.test(trimmed)) return true;
  }
  for (const noisy of NOISY_MINIMAL_PATTERNS) {
    if (noisy.test(trimmed)) return false;
  }
  return true;
}

/**
 * Normalizes a raw chunk of stdout/stderr into bounded, truncated lines and appends them
 * to a fixed-capacity ring buffer so memory usage remains O(1).
 */
export function appendBoundedLogLines(
  existing: string[],
  rawChunk: string,
  verbosity: ServerLogVerbosity = 'minimal',
  maxLines = DEFAULT_MAX_SERVER_LOG_LINES
): string[] {
  const rawLines = rawChunk.split('\n');
  const next = [...existing];

  for (const rawLine of rawLines) {
    // Handle carriage-return progress overwrites by keeping only the final segment
    const segments = rawLine.split('\r');
    const finalSeg = (segments[segments.length - 1] ?? '').trimEnd();
    if (!shouldIncludeServerLogLine(finalSeg, verbosity)) {
      continue;
    }
    const boundedLine =
      finalSeg.length > MAX_SINGLE_LOG_LINE_LENGTH
        ? `${finalSeg.slice(0, MAX_SINGLE_LOG_LINE_LENGTH - 14)}… [truncated]`
        : finalSeg;
    next.push(boundedLine);
  }

  if (next.length > maxLines) {
    return next.slice(next.length - maxLines);
  }
  return next;
}

/**
 * Extracts an HTTP(S) listening URL from a `llama serve` log line if present.
 */
export function extractListeningUrl(line: string): string | undefined {
  const match = line.match(/https?:\/\/[^\s,)]+/i);
  return match ? match[0] : undefined;
}

/**
 * Spawns an isolated `llama serve --models-preset <presetPath>` child process and tracks
 * only its exact `ChildProcess` / PID for clean start/stop lifecycle management.
 */
export function startLlamaServeProcess(
  options: StartLlamaServeOptions
): RunningLlamaServeController {
  const spec = buildLlamaServeCommandArgs(
    options.presetPath,
    options.serveCommand,
    options.serveHost,
    options.servePort
  );
  const startedAt = Date.now();
  let currentStatus: ServerStatusState = 'starting';
  let listeningUrl: string | undefined;
  let stopRequested = false;
  let settled = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let resolveStop: (() => void) | null = null;

  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.onStateChange?.({
      status: 'error',
      errorMessage: msg,
      startedAt,
    });
    return {
      pid: undefined,
      commandSpec: spec,
      stop: async () => {},
      killImmediate: () => {},
    };
  }

  const pid = child.pid;
  options.onStateChange?.({
    status: 'starting',
    pid,
    startedAt,
  });

  const emitChunk = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = text.split('\n');
    for (const rawLine of lines) {
      const segments = rawLine.split('\r');
      const finalSeg = (segments[segments.length - 1] ?? '').trimEnd();
      if (!finalSeg.trim()) continue;

      const foundUrl = extractListeningUrl(finalSeg);
      if (foundUrl && !listeningUrl) {
        listeningUrl = foundUrl;
        if (currentStatus === 'starting' && !stopRequested) {
          currentStatus = 'running';
          options.onStateChange?.({
            status: 'running',
            pid,
            listeningUrl,
            startedAt,
          });
        }
      } else if (
        currentStatus === 'starting' &&
        !stopRequested &&
        /\b(listening|http server|ready)\b/i.test(finalSeg)
      ) {
        currentStatus = 'running';
        options.onStateChange?.({
          status: 'running',
          pid,
          listeningUrl,
          startedAt,
        });
      }

      options.onLogLine?.(finalSeg);
    }
  };

  child.stdout?.on('data', emitChunk);
  child.stderr?.on('data', emitChunk);

  const finalize = (exitCode: number | null, signal: NodeJS.Signals | null, errMsg?: string) => {
    if (settled) return;
    settled = true;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }

    const nextStatus: ServerStatusState =
      stopRequested || exitCode === 0 ? 'stopped' : 'error';
    currentStatus = nextStatus;

    options.onStateChange?.({
      status: nextStatus,
      pid,
      listeningUrl,
      exitCode,
      signal,
      errorMessage: errMsg,
      startedAt,
    });

    if (resolveStop) {
      resolveStop();
      resolveStop = null;
    }
  };

  child.on('error', (err) => {
    finalize(null, null, err.message);
  });

  child.on('close', (code, signal) => {
    finalize(code, signal);
  });

  const stop = (): Promise<void> => {
    if (settled) return Promise.resolve();
    stopRequested = true;
    currentStatus = 'stopping';
    options.onStateChange?.({
      status: 'stopping',
      pid,
      listeningUrl,
      startedAt,
    });

    return new Promise<void>((resolve) => {
      resolveStop = resolve;
      try {
        child.kill('SIGTERM');
      } catch {
        finalize(null, null);
        return;
      }

      forceKillTimer = setTimeout(() => {
        if (!settled) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited
          }
        }
      }, 3000);
    });
  };

  const killImmediate = () => {
    if (settled) return;
    stopRequested = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore
    }
  };

  return {
    pid,
    commandSpec: spec,
    stop,
    killImmediate,
  };
}

