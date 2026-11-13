import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  AppTestSettings,
  CommonPresetConfig,
  DRAFT_DEPENDENT_KEYS,
  isValuelessFlag,
  ModelDetailVisibilityMode,
  ModelListHotkeys,
  ModelPresetSection,
  ModelTestRunResult,
  SectionTestStatus,
  TestStatusState,
} from '../types/index.js';
import {
  hasModelDraft,
  KNOWN_COMMON_KEYS,
  KNOWN_MODEL_KEYS,
} from './preset-config.js';

export const MODEL_DETAIL_VISIBILITY_MODES: ModelDetailVisibilityMode[] = [
  'names-only',
  'names-and-configs',
  'full',
];

export const DEFAULT_MODEL_LIST_HOTKEYS: ModelListHotkeys = {
  cycleDetailMode: 'i',
  toggleExport: 'x',
  expandAll: 'a',
  mixProfiles: 'v',
  testModel: 't',
  testAll: 'T',
  testChild: 'm',
  deleteSection: 'd',
  filter: '/',
  edit: 'e',
};

export function cycleModelDetailVisibility(
  current?: ModelDetailVisibilityMode
): ModelDetailVisibilityMode {
  const idx = MODEL_DETAIL_VISIBILITY_MODES.indexOf(current ?? 'full');
  const nextIdx = (idx + 1) % MODEL_DETAIL_VISIBILITY_MODES.length;
  return MODEL_DETAIL_VISIBILITY_MODES[nextIdx]!;
}

export function resolveModelListHotkeys(
  custom?: Partial<ModelListHotkeys>
): ModelListHotkeys {
  const resolved: ModelListHotkeys = { ...DEFAULT_MODEL_LIST_HOTKEYS };
  if (!custom) return resolved;
  for (const key of Object.keys(DEFAULT_MODEL_LIST_HOTKEYS) as (keyof ModelListHotkeys)[]) {
    const val = custom[key];
    if (typeof val === 'string' && val.length > 0) {
      resolved[key] = val;
    }
  }
  return resolved;
}

export const DEFAULT_APP_TEST_SETTINGS: AppTestSettings = {
  testCommand: 'llama cli',
  serveCommand: 'llama serve',
  serveHost: '0.0.0.0',
  servePort: 8080,
  defaultPrompt: 'why is the sky blue?',
  maxPredictTokens: 64,
  timeoutSeconds: 120,
  modelDetailVisibility: 'full',
  hotkeys: { ...DEFAULT_MODEL_LIST_HOTKEYS },
};

const DRAFT_DEPENDENT_SET = new Set<string>(DRAFT_DEPENDENT_KEYS);

/**
 * Splits a command string (e.g. `llama cli --no-cnv`) into tokens while respecting quotes.
 */
export function splitCommandTokens(commandStr: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoteChar: '"' | "'" | null = null;

  for (let i = 0; i < commandStr.length; i++) {
    const ch = commandStr[i];
    if (quoteChar) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Formats a single key-value option from the preset into CLI arguments for `llama cli`.
 * - Boolean `true` for valueless flags (`jinja`, `no-mmap`, `mlock`) emits `--<key>`.
 * - Boolean `false` for valueless flags is omitted (unless it's `flash-attn`, which accepts `on`/`off` or `true`/`false`).
 * - Other scalars emit `["--<key>", "<value>"]`.
 */
function formatCliFlag(key: string, val: string | number | boolean): string[] {
  const normalizedKey = key.replace(/^--+/, '');
  // `alias` is a llama-server routing property, not a llama-cli flag
  if (normalizedKey === 'alias') {
    return [];
  }

  // Straight-forward / valueless toggle flag: pass `--<key>` (or `-<key>` if 1 char) without any value
  if (isValuelessFlag(val) && normalizedKey !== 'flash-attn') {
    const prefix = normalizedKey.length === 1 ? '-' : '--';
    return [`${prefix}${normalizedKey}`];
  }

  if (typeof val === 'boolean') {
    if (normalizedKey === 'flash-attn') {
      return ['--flash-attn', val ? 'on' : 'off'];
    }
    if (val === true) {
      return [`--${normalizedKey}`];
    }
    return [];
  }

  const strVal = String(val).trim();
  if (strVal === '') return [];

  if (strVal.toLowerCase() === 'true' && ['jinja', 'no-mmap', 'mlock'].includes(normalizedKey)) {
    return [`--${normalizedKey}`];
  }
  if (strVal.toLowerCase() === 'false' && ['jinja', 'no-mmap', 'mlock'].includes(normalizedKey)) {
    return [];
  }
  if (normalizedKey === 'flash-attn' && (strVal.toLowerCase() === 'true' || strVal.toLowerCase() === 'false')) {
    return ['--flash-attn', strVal.toLowerCase() === 'true' ? 'on' : 'off'];
  }

  return [`--${normalizedKey}`, strVal];
}

/**
 * Builds the exact executable and argument array to test a `ModelPresetSection` merged with
 * the `[*]` `CommonPresetConfig` and the user's `AppTestSettings`.
 *
 * Ensures single-turn non-interactive execution so `llama cli` exits as soon as the response
 * or error is returned.
 */
export function buildModelTestCommandArgs(
  common: CommonPresetConfig,
  section: ModelPresetSection,
  settings: AppTestSettings
): { executable: string; args: string[]; displayCommand: string } {
  const rawTokens = splitCommandTokens(settings.testCommand.trim() || 'llama cli');
  const executable = rawTokens[0] || 'llama';
  const baseSubArgs = rawTokens.slice(1);

  const mergedFlags = new Map<string, string | number | boolean>();

  // 1. Apply common [*] settings first
  for (const k of KNOWN_COMMON_KEYS) {
    const val = common[k as keyof CommonPresetConfig];
    if (val !== undefined && val !== '') {
      mergedFlags.set(k, val as string | number | boolean);
    }
  }
  for (const [customK, customV] of Object.entries(common.custom)) {
    if (customK.trim() && customV !== undefined && customV !== '') {
      mergedFlags.set(customK.trim().replace(/^--+/, ''), customV);
    }
  }

  // 2. Override with per-model section settings
  const draftActive = hasModelDraft(section);
  for (const k of KNOWN_MODEL_KEYS) {
    if (!draftActive && (k === 'model-draft' || DRAFT_DEPENDENT_SET.has(k))) {
      continue;
    }
    const val = section[k as keyof ModelPresetSection];
    if (val !== undefined && val !== '') {
      mergedFlags.set(k, val as string | number | boolean);
    }
  }
  for (const [customK, customV] of Object.entries(section.custom)) {
    const cleanK = customK.trim().replace(/^--+/, '');
    if (!cleanK || customV === undefined || customV === '') continue;
    if (!draftActive && (cleanK === 'model-draft' || DRAFT_DEPENDENT_SET.has(cleanK))) {
      continue;
    }
    mergedFlags.set(cleanK, customV);
  }

  const args: string[] = [];
  let promptInjected = false;

  for (const token of baseSubArgs) {
    if (token.includes('{PROMPT}') || token.includes('$PROMPT')) {
      args.push(
        token
          .replace(/\{PROMPT\}/g, settings.defaultPrompt)
          .replace(/\$PROMPT/g, settings.defaultPrompt)
      );
      promptInjected = true;
    } else {
      args.push(token);
    }
  }

  // Emit merged model & common flags
  for (const [k, v] of mergedFlags.entries()) {
    args.push(...formatCliFlag(k, v));
  }

  // Append `-p <prompt>` if not already provided via placeholder in testCommand
  if (!promptInjected && !args.includes('-p') && !args.includes('--prompt')) {
    args.push('-p', settings.defaultPrompt);
  }

  // Bound the prediction length for the test if not explicitly set by user flags
  if (
    settings.maxPredictTokens > 0 &&
    !mergedFlags.has('n-predict') &&
    !mergedFlags.has('n') &&
    !args.includes('-n') &&
    !args.includes('--n-predict')
  ) {
    args.push('-n', String(settings.maxPredictTokens));
  }

  // Ensure single-turn non-interactive mode so llama-cli exits immediately after generating the answer
  if (
    !args.includes('--single-turn') &&
    !args.includes('--no-cnv') &&
    !mergedFlags.has('single-turn') &&
    !mergedFlags.has('no-cnv')
  ) {
    args.push('--single-turn');
  }

  // Ensure simple-io mode so llama-cli disables readline/fancy terminal controls and flushes piped stdout/stderr
  if (
    !args.includes('--simple-io') &&
    !mergedFlags.has('simple-io')
  ) {
    args.push('--simple-io');
  }

  const displayParts = [executable, ...args].map((part) =>
    /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part
  );

  return {
    executable,
    args,
    displayCommand: displayParts.join(' '),
  };
}

/**
 * Terminates ONLY the specific spawned ChildProcess by its exact PID (`child.kill(...)`).
 * Never uses `pkill` or `killall` by name, guaranteeing no other `llama` processes on the system are affected.
 */
export function terminateSpecificChildProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  try {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already exited
        }
      }
    }, 1500);
    killTimer.unref();
  } catch {
    // Process already exited
  }
}

export interface RunningTestController {
  pid?: number;
  commandLine: string;
  abort: () => void;
  promise: Promise<ModelTestRunResult>;
}

/**
 * Spawns the configured `llama cli` command to test a model configuration, streaming output chunks
 * via `onOutput` and ensuring the exact spawned PID is closed immediately once finished, failed, or aborted.
 */
export function startModelConfigurationTest(
  common: CommonPresetConfig,
  section: ModelPresetSection,
  settings: AppTestSettings,
  onOutput?: (combinedOutput: string) => void
): RunningTestController {
  const { executable, args, displayCommand } = buildModelTestCommandArgs(
    common,
    section,
    settings
  );

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let combinedOutput = '';
  let abortedByUser = false;
  let timedOut = false;
  let firstStdoutAt: number | null = null;
  let lastStdoutAt: number | null = null;
  let lastStderrBeforeStdoutAt: number | null = null;
  let lastStderrAt: number | null = null;
  let stdoutChunkCount = 0;
  const stdoutChunkTimes: number[] = [];

  // Close stdin immediately (`stdio: ['ignore', 'pipe', 'pipe']`) so interactive prompts in llama-cli hit EOF and exit immediately after responding
  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const appendOutput = (chunk: Buffer, isErr: boolean) => {
    const now = Date.now();
    const text = chunk.toString('utf8');
    if (isErr) {
      stderr += text;
      if (text.trim().length > 0) {
        lastStderrAt = now;
        if (firstStdoutAt === null) {
          lastStderrBeforeStdoutAt = now;
        }
      }
    } else {
      stdout += text;
      if (text.length > 0) {
        if (firstStdoutAt === null) {
          firstStdoutAt = now;
        }
        lastStdoutAt = now;
        stdoutChunkCount += 1;
        stdoutChunkTimes.push(now);
      }
    }
    combinedOutput += text;
    onOutput?.(combinedOutput);
  };

  child.stdout?.on('data', (chunk: Buffer) => appendOutput(chunk, false));
  child.stderr?.on('data', (chunk: Buffer) => appendOutput(chunk, true));

  const timeoutMs = Math.max(5, settings.timeoutSeconds) * 1000;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminateSpecificChildProcess(child);
  }, timeoutMs);

  const promise = new Promise<ModelTestRunResult>((resolve) => {
    let settled = false;
    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null, errText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      // Ensure this specific child process is closed
      terminateSpecificChildProcess(child);

      if (errText) {
        stderr += (stderr ? '\n' : '') + errText;
        combinedOutput += (combinedOutput ? '\n' : '') + errText;
      }

      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const success = !abortedByUser && !timedOut && exitCode === 0;
      let avgTokensPerSec = parseTokensPerSecondFromOutput(combinedOutput);

      if (avgTokensPerSec === undefined && success) {
        avgTokensPerSec = computeFallbackTokensPerSecond({
          stdout,
          combinedOutput,
          defaultPrompt: settings.defaultPrompt,
          maxPredictTokens: settings.maxPredictTokens,
          startTime,
          endTime,
          firstStdoutAt,
          lastStdoutAt,
          lastStderrBeforeStdoutAt,
          lastStderrAt,
          stdoutChunkCount,
          stdoutChunkTimes,
        });
        if (avgTokensPerSec !== undefined) {
          const speedNote = `\n[Measured avg generation speed: ${avgTokensPerSec.toFixed(2)} t/s]`;
          combinedOutput += speedNote;
          onOutput?.(combinedOutput);
        }
      }

      resolve({
        success,
        exitCode,
        signal,
        pid: child.pid,
        commandLine: displayCommand,
        stdout,
        stderr,
        combinedOutput,
        durationMs,
        avgTokensPerSec,
        abortedByUser,
        timedOut,
      });
    };

    child.on('error', (err) => {
      finalize(1, null, `Failed to spawn "${executable}": ${err.message}`);
    });

    child.on('close', (code, signal) => {
      finalize(code, signal);
    });
  });

  return {
    pid: child.pid,
    commandLine: displayCommand,
    abort: () => {
      abortedByUser = true;
      terminateSpecificChildProcess(child);
    },
    promise,
  };
}

/**
 * Strips ANSI terminal escape codes and normalizes carriage returns (`\r`) to newlines (`\n`).
 */
export function stripAnsiCodes(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Extracts the average generation tokens per second (`t/s` or `tokens per second`) from `llama cli` output.
 * Supports:
 * - Standard `llama_perf_context_print` / `common_perf_print`:
 *   `eval time = 1234.56 ms / 64 runs ( 19.29 ms per token, 51.84 tokens per second)`
 * - Modern `llama-cli` summary bar (with or without ANSI color sequences):
 *   `[ Prompt: 128.5 t/s | Generation: 45.2 t/s ]`
 * - `eval time = <ms> ms / <runs> (runs|tokens)` or `<ms> ms per token` when `tokens per second` is omitted
 * - `decoded <N> tokens in <S> s, speed: <T> t/s`
 * - Generic `<number> tokens per second` / `tokens/sec` / `tok/s` / `tokens/s` / `t/s` / `tps` lines.
 */
export function parseTokensPerSecondFromOutput(output: string): number | undefined {
  if (!output) return undefined;

  const clean = stripAnsiCodes(output).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parseNum = (raw: string): number | undefined => {
    const val = Number(raw.replace(',', '.'));
    return Number.isFinite(val) && val > 0 ? val : undefined;
  };
  const unitPattern = '(?:tokens?\\s+per\\s+second|tokens?\\/sec|tokens?\\/s|tok\\/sec|tok\\/s|t\\/sec|t\\/s|tps)';

  // 1. Prioritize non-prompt `eval time = ...` lines
  const lines = clean.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/(?:common_perf_print|llama_perf_context_print|eval\s+time\s*=)/i.test(line) && !/prompt\s+eval\s+time/i.test(line)) {
      if (/eval\s+time\s*=/i.test(line)) {
        const m = line.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unitPattern}`, 'i'));
        if (m) {
          const val = parseNum(m[1]);
          if (val !== undefined) return val;
        }
        // Fallback if only `ms per token` is shown on the eval time line
        const msPerTok = line.match(/(\d+(?:[.,]\d+)?)\s*ms\s*(?:per|\/)\s*(?:token|run)/i);
        if (msPerTok) {
          const ms = parseNum(msPerTok[1]);
          if (ms !== undefined && ms > 0) return Number((1000 / ms).toFixed(2));
        }
        // Fallback if `eval time = <ms> ms / <runs> runs` is shown
        const evalRuns = line.match(/eval\s+time\s*=\s*(\d+(?:[.,]\d+)?)\s*ms\s*\/\s*(\d+)\s*(?:runs|tokens)/i);
        if (evalRuns) {
          const totalMs = parseNum(evalRuns[1]);
          const runs = Number(evalRuns[2]);
          if (totalMs !== undefined && totalMs > 0 && Number.isFinite(runs) && runs > 0) {
            return Number(((runs * 1000) / totalMs).toFixed(2));
          }
        }
      }
    }
  }

  // 2. Check for `Generation: <num> t/s` (modern llama-cli status bar)
  const genMatches = Array.from(
    clean.matchAll(new RegExp(`Generation\\s*:\\s*(\\d+(?:[.,]\\d+)?)\\s*${unitPattern}`, 'gi'))
  );
  if (genMatches.length > 0) {
    const lastGen = genMatches[genMatches.length - 1];
    const val = parseNum(lastGen[1]);
    if (val !== undefined) return val;
  }

  // 3. Check for `decoded <N> tokens in <S> s, speed: <T> t/s`
  const decodedMatch = clean.match(
    new RegExp(`decoded\\s+\\d+\\s+tokens\\s+in\\s+\\d+(?:[.,]\\d+)?\\s*s,\\s*speed:\\s*(\\d+(?:[.,]\\d+)?)\\s*${unitPattern}`, 'i')
  );
  if (decodedMatch) {
    const val = parseNum(decodedMatch[1]);
    if (val !== undefined) return val;
  }

  // 4. Fallback: take the last non-prompt `<num> (tokens per second|tokens/s|tok/s|t/s)` match in the output
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/prompt\s+eval\s+time/i.test(line)) continue;
    // If line has `[ Prompt: ... | ... ]` without `Generation:`, skip matching Prompt speed
    const lineWithoutPromptBar = line.replace(/Prompt\s*:\s*\d+(?:[.,]\d+)?\s*[a-z/]+/gi, '');
    const allMatches = Array.from(
      lineWithoutPromptBar.matchAll(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unitPattern}(?![a-z])`, 'gi'))
    );
    if (allMatches.length > 0) {
      const last = allMatches[allMatches.length - 1];
      const val = parseNum(last[1]);
      if (val !== undefined) return val;
    }
  }

  return undefined;
}

/**
 * Fallback speed estimator when `llama cli` runs in `--single-turn` conversation mode
 * with `LOG_INF` timings suppressed (or in a non-TTY pipe where the interactive `[ Generation: ... t/s ]`
 * footer is omitted) and exits cleanly with generated output.
 */
export function computeFallbackTokensPerSecond(params: {
  stdout: string;
  combinedOutput: string;
  defaultPrompt: string;
  maxPredictTokens: number;
  startTime: number;
  endTime: number;
  firstStdoutAt?: number | null;
  lastStdoutAt?: number | null;
  lastStderrBeforeStdoutAt?: number | null;
  lastStderrAt?: number | null;
  stdoutChunkCount: number;
  stdoutChunkTimes?: number[];
}): number | undefined {
  const cleanStdout = stripAnsiCodes(params.stdout).trim();
  const textToMeasure = cleanStdout || stripAnsiCodes(params.combinedOutput).trim();
  if (!textToMeasure) return undefined;

  // Strip the echoed prompt if `llama-cli` echoed it at the start of stdout
  let generatedText = textToMeasure;
  const promptTrimmed = (params.defaultPrompt || '').trim();
  if (promptTrimmed && generatedText.startsWith(promptTrimmed)) {
    generatedText = generatedText.slice(promptTrimmed.length).trim();
  }
  if (!generatedText) {
    generatedText = textToMeasure;
  }

  // Filter out early startup chunks on stdout (e.g. `Loading model...` banner) that arrived before
  // stderr finished model-loading logs or before a >1000ms model-loading gap
  const rawTimes = params.stdoutChunkTimes ?? [];
  let streamTimes = rawTimes;
  if (params.lastStderrAt != null && rawTimes.length >= 2) {
    const afterStderr = rawTimes.filter((t) => t >= params.lastStderrAt!);
    if (afterStderr.length >= 2) {
      streamTimes = afterStderr;
    }
  }
  if (streamTimes.length >= 3) {
    const firstGap = streamTimes[1] - streamTimes[0];
    const remainingSpan = streamTimes[streamTimes.length - 1] - streamTimes[1];
    const avgRemainingGap = remainingSpan / (streamTimes.length - 2);
    if (firstGap > 1000 && firstGap > avgRemainingGap * 5) {
      streamTimes = streamTimes.slice(1);
    }
  }

  const effectiveChunkCount = streamTimes.length > 0 ? streamTimes.length : params.stdoutChunkCount;

  // Estimate generated token count:
  // If `stdout` streamed token-by-token (many small chunks), `effectiveChunkCount` closely reflects token count.
  // Otherwise estimate from characters/words bounded by `maxPredictTokens`.
  const wordPieces = generatedText.split(/\s+/).filter(Boolean).length;
  const charEstimate = Math.ceil(generatedText.length / 4);
  const textTokenEstimate = Math.max(1, Math.round((wordPieces * 1.3 + charEstimate) / 2));

  let estimatedTokens =
    effectiveChunkCount >= 4
      ? Math.min(effectiveChunkCount, Math.max(textTokenEstimate * 2, 4))
      : textTokenEstimate;

  if (params.maxPredictTokens > 0) {
    estimatedTokens = Math.min(estimatedTokens, params.maxPredictTokens);
  }
  if (estimatedTokens <= 0) return undefined;

  // Determine generation window in milliseconds:
  const effectiveFirstStdout =
    streamTimes.length > 0 ? streamTimes[0] : (params.firstStdoutAt ?? undefined);
  const effectiveLastStdout =
    streamTimes.length > 0
      ? streamTimes[streamTimes.length - 1]
      : (params.lastStdoutAt ?? undefined);
  const stderrRef = params.lastStderrBeforeStdoutAt ?? params.lastStderrAt ?? undefined;

  let genDurationMs = 0;
  if (
    effectiveFirstStdout !== undefined &&
    effectiveLastStdout !== undefined &&
    effectiveLastStdout > effectiveFirstStdout
  ) {
    const genStart =
      stderrRef !== undefined && stderrRef <= effectiveFirstStdout && stderrRef >= effectiveFirstStdout - 500
        ? stderrRef
        : effectiveFirstStdout;
    genDurationMs = effectiveLastStdout - genStart;
    // If all stdout arrived in a single buffered flush (< 15ms), fall back to post-stderr or total duration
    if (genDurationMs < 15) {
      genDurationMs =
        stderrRef !== undefined && params.endTime > stderrRef
          ? params.endTime - stderrRef
          : params.endTime - params.startTime;
    }
  } else if (stderrRef !== undefined && params.endTime > stderrRef) {
    genDurationMs = params.endTime - stderrRef;
  } else {
    genDurationMs = params.endTime - params.startTime;
  }

  if (genDurationMs <= 0) {
    genDurationMs = Math.max(1, params.endTime - params.startTime);
  }

  const tps = (estimatedTokens * 1000) / genDurationMs;
  if (!Number.isFinite(tps) || tps <= 0) return undefined;
  return Number(tps.toFixed(2));
}

export interface TokensPerSecondComparison {
  currentTps?: number;
  previousTps?: number;
  deltaTps?: number;
  deltaPercent?: number;
  direction: 'better' | 'worse' | 'same' | 'none';
  formattedCurrent: string;
  formattedShortComparison: string;
  formattedDetailedComparison: string;
}

/**
 * Compares the recently measured average tokens/sec (`currentTps`) against the previously saved
 * average (`previousTps`) so the user can immediately identify if the new configuration is better or worse.
 */
export function compareTokensPerSecond(
  currentTps?: number,
  previousTps?: number
): TokensPerSecondComparison {
  if (currentTps === undefined || !Number.isFinite(currentTps)) {
    return {
      currentTps: undefined,
      previousTps,
      direction: 'none',
      formattedCurrent: 'N/A',
      formattedShortComparison:
        previousTps !== undefined ? `(prev: ${previousTps.toFixed(2)} t/s)` : '',
      formattedDetailedComparison:
        previousTps !== undefined
          ? `Previous saved average: ${previousTps.toFixed(2)} t/s`
          : 'No tokens/sec metric recorded',
    };
  }

  const formattedCurrent = `${currentTps.toFixed(2)} t/s`;

  if (previousTps === undefined || !Number.isFinite(previousTps) || previousTps <= 0) {
    return {
      currentTps,
      previousTps: undefined,
      direction: 'none',
      formattedCurrent,
      formattedShortComparison: '(baseline)',
      formattedDetailedComparison: '(First recorded baseline — no previous average)',
    };
  }

  const deltaTps = currentTps - previousTps;
  const deltaPercent = (deltaTps / previousTps) * 100;

  if (Math.abs(deltaTps) < 0.005) {
    return {
      currentTps,
      previousTps,
      deltaTps: 0,
      deltaPercent: 0,
      direction: 'same',
      formattedCurrent,
      formattedShortComparison: `(= prev ${previousTps.toFixed(2)} t/s)`,
      formattedDetailedComparison: `= Same as previous (${previousTps.toFixed(2)} t/s)`,
    };
  }

  if (deltaTps > 0) {
    return {
      currentTps,
      previousTps,
      deltaTps,
      deltaPercent,
      direction: 'better',
      formattedCurrent,
      formattedShortComparison: `(▲ +${deltaTps.toFixed(2)} t/s / +${deltaPercent.toFixed(1)}% vs ${previousTps.toFixed(2)} t/s)`,
      formattedDetailedComparison: `▲ BETTER by +${deltaTps.toFixed(2)} t/s (+${deltaPercent.toFixed(1)}%) vs previous ${previousTps.toFixed(2)} t/s`,
    };
  }

  return {
    currentTps,
    previousTps,
    deltaTps,
    deltaPercent,
    direction: 'worse',
    formattedCurrent,
    formattedShortComparison: `(▼ ${deltaTps.toFixed(2)} t/s / ${deltaPercent.toFixed(1)}% vs ${previousTps.toFixed(2)} t/s)`,
    formattedDetailedComparison: `▼ WORSE by ${deltaTps.toFixed(2)} t/s (${deltaPercent.toFixed(1)}%) vs previous ${previousTps.toFixed(2)} t/s`,
  };
}

/**
 * Transitions a section's `SectionTestStatus` to `'running'` while preserving its existing
 * `avgTokensPerSec` and `previousAvgTokensPerSec` so the baseline is ready to compare when finished.
 */
export function recordRunningTestStatus(
  prevStatus?: SectionTestStatus
): SectionTestStatus {
  return {
    ...prevStatus,
    status: 'running',
    updatedAt: Date.now(),
  };
}

/**
 * Transitions a section's `SectionTestStatus` upon test completion, shifting the previously saved
 * `avgTokensPerSec` into `previousAvgTokensPerSec` and storing the newly measured `avgTokensPerSec`.
 */
export function recordCompletedTestStatus(
  prevStatus: SectionTestStatus | undefined,
  result: ModelTestRunResult
): SectionTestStatus {
  const prevSavedAvg = prevStatus?.avgTokensPerSec;
  const newAvg = result.avgTokensPerSec;

  if (newAvg !== undefined) {
    return {
      status: result.success ? 'passed' : 'failed',
      avgTokensPerSec: newAvg,
      previousAvgTokensPerSec: prevSavedAvg,
      lastResult: result,
      updatedAt: Date.now(),
    };
  }

  return {
    status: result.success ? 'passed' : 'failed',
    avgTokensPerSec: undefined,
    previousAvgTokensPerSec: prevSavedAvg ?? prevStatus?.previousAvgTokensPerSec,
    lastResult: result,
    updatedAt: Date.now(),
  };
}

/**
 * Returns the test status for a single configuration section (`'untested'` | `'running'` | `'passed'` | `'failed'`).
 */
export function getSectionTestStatus(
  sectionId: string,
  statusMap: Record<string, SectionTestStatus>
): TestStatusState {
  return statusMap[sectionId]?.status ?? 'untested';
}

/**
 * Computes the aggregate test status for a model across all of its configurations:
 * - `'untested'` (gray) if the model has no configurations or none of its configurations have been tested
 * - `'running'` (yellow) if any configuration is currently running a test
 * - `'failed'` (red) if any tested configuration failed on its last run
 * - `'passed'` (green) if at least one configuration passed and none failed
 */
export function getModelAggregateTestStatus(
  sections: ModelPresetSection[],
  statusMap: Record<string, SectionTestStatus>
): TestStatusState {
  if (sections.length === 0) {
    return 'untested';
  }
  const states = sections.map((sec) => getSectionTestStatus(sec.sectionId, statusMap));
  if (states.includes('running')) {
    return 'running';
  }
  if (states.includes('failed')) {
    return 'failed';
  }
  if (states.includes('passed')) {
    return 'passed';
  }
  return 'untested';
}

/**
 * Maps a `TestStatusState` to its display color:
 * - `'untested'` -> `'gray'`
 * - `'running'` -> `'yellow'`
 * - `'passed'` -> `'green'`
 * - `'failed'` -> `'red'`
 */
export function getTestStatusColor(
  status: TestStatusState
): 'gray' | 'yellow' | 'green' | 'red' {
  switch (status) {
    case 'passed':
      return 'green';
    case 'failed':
      return 'red';
    case 'running':
      return 'yellow';
    case 'untested':
    default:
      return 'gray';
  }
}

export interface BatchTestProgressCallbacks {
  onSectionStart?: (
    section: ModelPresetSection,
    index: number,
    total: number,
    commandLine: string,
    pid?: number
  ) => void;
  onSectionOutput?: (
    section: ModelPresetSection,
    index: number,
    total: number,
    combinedOutput: string
  ) => void;
  onSectionComplete?: (
    section: ModelPresetSection,
    index: number,
    total: number,
    result: ModelTestRunResult
  ) => void;
}

export interface RunningBatchTestController {
  abort: () => void;
  promise: Promise<Record<string, ModelTestRunResult>>;
}

/**
 * Runs a batch of model configurations sequentially one after another (used for testing all
 * configurations of a single model or testing all models and configurations).
 * Each process is spawned, awaited, and terminated cleanly by exact PID before the next begins.
 */
export function startBatchModelConfigurationTest(
  common: CommonPresetConfig,
  sections: ModelPresetSection[],
  settings: AppTestSettings,
  callbacks?: BatchTestProgressCallbacks
): RunningBatchTestController {
  let aborted = false;
  let activeController: RunningTestController | null = null;

  const promise = (async (): Promise<Record<string, ModelTestRunResult>> => {
    const results: Record<string, ModelTestRunResult> = {};
    const total = sections.length;

    for (let i = 0; i < total; i++) {
      if (aborted) {
        break;
      }
      const section = sections[i];
      const ctrl = startModelConfigurationTest(common, section, settings, (combined) => {
        callbacks?.onSectionOutput?.(section, i, total, combined);
      });
      activeController = ctrl;
      callbacks?.onSectionStart?.(section, i, total, ctrl.commandLine, ctrl.pid);

      const res = await ctrl.promise;
      activeController = null;
      results[section.sectionId] = res;
      callbacks?.onSectionComplete?.(section, i, total, res);

      if (aborted || res.abortedByUser) {
        break;
      }
    }

    return results;
  })();

  return {
    abort: () => {
      aborted = true;
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
    },
    promise,
  };
}

/**
 * Loads persisted `AppTestSettings` from `<presetPath>.ui-settings.json`, or returns defaults.
 */
export async function loadAppTestSettings(presetPath: string): Promise<AppTestSettings> {
  const settingsPath = getAppSettingsFilePath(presetPath);
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppTestSettings>;
    return {
      testCommand:
        typeof parsed.testCommand === 'string' && parsed.testCommand.trim()
          ? parsed.testCommand.trim()
          : DEFAULT_APP_TEST_SETTINGS.testCommand,
      serveCommand:
        typeof parsed.serveCommand === 'string' && parsed.serveCommand.trim()
          ? parsed.serveCommand.trim()
          : DEFAULT_APP_TEST_SETTINGS.serveCommand,
      serveHost:
        typeof parsed.serveHost === 'string' && parsed.serveHost.trim()
          ? parsed.serveHost.trim()
          : DEFAULT_APP_TEST_SETTINGS.serveHost,
      servePort:
        typeof parsed.servePort === 'number' &&
        Number.isInteger(parsed.servePort) &&
        parsed.servePort >= 1 &&
        parsed.servePort <= 65535
          ? parsed.servePort
          : DEFAULT_APP_TEST_SETTINGS.servePort,
      defaultPrompt:
        typeof parsed.defaultPrompt === 'string' && parsed.defaultPrompt.trim()
          ? parsed.defaultPrompt
          : DEFAULT_APP_TEST_SETTINGS.defaultPrompt,
      maxPredictTokens:
        typeof parsed.maxPredictTokens === 'number' && parsed.maxPredictTokens > 0
          ? parsed.maxPredictTokens
          : DEFAULT_APP_TEST_SETTINGS.maxPredictTokens,
      timeoutSeconds:
        typeof parsed.timeoutSeconds === 'number' && parsed.timeoutSeconds >= 5
          ? parsed.timeoutSeconds
          : DEFAULT_APP_TEST_SETTINGS.timeoutSeconds,
      modelDetailVisibility:
        parsed.modelDetailVisibility &&
        MODEL_DETAIL_VISIBILITY_MODES.includes(parsed.modelDetailVisibility)
          ? parsed.modelDetailVisibility
          : DEFAULT_APP_TEST_SETTINGS.modelDetailVisibility,
      hotkeys: resolveModelListHotkeys(parsed.hotkeys),
    };
  } catch {
    return {
      ...DEFAULT_APP_TEST_SETTINGS,
      hotkeys: { ...DEFAULT_MODEL_LIST_HOTKEYS },
    };
  }
}

/**
 * Saves `AppTestSettings` alongside the preset file (`<presetPath>.ui-settings.json`),
 * preserving any persisted `testStatuses`.
 */
export async function saveAppTestSettings(
  presetPath: string,
  settings: AppTestSettings
): Promise<void> {
  const settingsPath = getAppSettingsFilePath(presetPath);
  let existingData: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existingData = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File does not exist yet
  }
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const payload = {
    ...existingData,
    ...settings,
  };
  await fs.writeFile(settingsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/**
 * Loads persisted per-section test statuses (`passed` / `failed`) from `<presetPath>.ui-settings.json`.
 */
export async function loadSectionTestStatuses(
  presetPath: string
): Promise<Record<string, SectionTestStatus>> {
  const settingsPath = getAppSettingsFilePath(presetPath);
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      testStatuses?: Record<string, SectionTestStatus>;
    };
    if (!parsed.testStatuses || typeof parsed.testStatuses !== 'object') {
      return {};
    }
    const result: Record<string, SectionTestStatus> = {};
    for (const [secId, entry] of Object.entries(parsed.testStatuses)) {
      if (entry && (entry.status === 'passed' || entry.status === 'failed')) {
        result[secId] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Persists per-section test statuses (`passed` / `failed`) to `<presetPath>.ui-settings.json`
 * so the green/red status marks remain available across sessions.
 */
export async function saveSectionTestStatuses(
  presetPath: string,
  statuses: Record<string, SectionTestStatus>
): Promise<void> {
  const settingsPath = getAppSettingsFilePath(presetPath);
  let existingData: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existingData = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File does not exist yet
  }

  const persistedStatuses: Record<string, SectionTestStatus> = {};
  for (const [secId, entry] of Object.entries(statuses)) {
    if (entry && (entry.status === 'passed' || entry.status === 'failed')) {
      persistedStatuses[secId] = entry;
    }
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const payload = {
    ...existingData,
    testStatuses: persistedStatuses,
  };
  await fs.writeFile(settingsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/**
 * Loads persisted disabled section IDs from `<presetPath>.ui-settings.json`.
 */
export async function loadDisabledSectionIds(presetPath: string): Promise<string[]> {
  const settingsPath = getAppSettingsFilePath(presetPath);
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { disabledSectionIds?: unknown };
    if (Array.isArray(parsed.disabledSectionIds)) {
      return parsed.disabledSectionIds.filter((id): id is string => typeof id === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Persists disabled section IDs to `<presetPath>.ui-settings.json`.
 */
export async function saveDisabledSectionIds(
  presetPath: string,
  disabledSectionIds: string[]
): Promise<void> {
  const settingsPath = getAppSettingsFilePath(presetPath);
  let existingData: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existingData = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File does not exist yet
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const payload = {
    ...existingData,
    disabledSectionIds,
  };
  await fs.writeFile(settingsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export function getAppSettingsFilePath(presetPath: string): string {
  const resolved = path.resolve(presetPath);
  return `${resolved}.ui-settings.json`;
}

