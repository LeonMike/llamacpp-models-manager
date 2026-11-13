import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendBoundedLogLines,
  buildLlamaServeCommandArgs,
  extractListeningUrl,
  MAX_SINGLE_LOG_LINE_LENGTH,
  ServerStateSnapshot,
  shouldIncludeServerLogLine,
  startLlamaServeProcess,
} from '../src/core/server-runner.js';

describe('server-runner (llama serve process & bounded log manager)', () => {
  it('builds llama serve --models-preset <path> command arguments with default and custom host/port', () => {
    const spec = buildLlamaServeCommandArgs('./presets/my-preset.ini');
    expect(spec.command).toBe('llama');
    expect(spec.args).toEqual([
      'serve',
      '--models-preset',
      path.resolve('./presets/my-preset.ini'),
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
    ]);

    const configuredSpec = buildLlamaServeCommandArgs('/tmp/p.ini', 'llama serve', '127.0.0.1', 9090);
    expect(configuredSpec.command).toBe('llama');
    expect(configuredSpec.args).toEqual([
      'serve',
      '--models-preset',
      path.resolve('/tmp/p.ini'),
      '--host',
      '127.0.0.1',
      '--port',
      '9090',
    ]);

    const customSpec = buildLlamaServeCommandArgs('/tmp/p.ini', 'llama-server --port 8081');
    expect(customSpec.command).toBe('llama-server');
    expect(customSpec.args).toEqual([
      '--port',
      '8081',
      '--models-preset',
      path.resolve('/tmp/p.ini'),
      '--host',
      '0.0.0.0',
    ]);
  });

  it('filters noisy tensor logs in minimal mode and bounds the log ring buffer + line length', () => {
    expect(shouldIncludeServerLogLine('llama_model_loader: - kv   0: general.name = qwen', 'minimal')).toBe(false);
    expect(shouldIncludeServerLogLine('load_tensors: tensor blk.0.attn_q.weight', 'minimal')).toBe(false);
    expect(shouldIncludeServerLogLine('main: server is listening on http://127.0.0.1:8080', 'minimal')).toBe(true);
    expect(shouldIncludeServerLogLine('error: failed to load model', 'minimal')).toBe(true);
    expect(shouldIncludeServerLogLine('load_tensors: tensor blk.0.attn_q.weight', 'all')).toBe(true);

    expect(extractListeningUrl('main: HTTP server listening on http://127.0.0.1:8080 - starting')).toBe(
      'http://127.0.0.1:8080'
    );

    const longLine = `error: ${'x'.repeat(MAX_SINGLE_LOG_LINE_LENGTH + 100)}`;
    const chunk = [
      'load_tensors: noisy line 1',
      'server listening on http://127.0.0.1:8080',
      'POST /v1/chat/completions 200',
      'POST /v1/chat/completions 200',
      'POST /v1/chat/completions 200',
      longLine,
    ].join('\n');

    const bounded = appendBoundedLogLines([], chunk, 'minimal', 3);
    expect(bounded).toHaveLength(3);
    expect(bounded[2]!.length).toBeLessThanOrEqual(MAX_SINGLE_LOG_LINE_LENGTH);
    expect(bounded[2]!.endsWith('… [truncated]')).toBe(true);
  });

  it('starts a child server process, detects running state, and stops only its own PID cleanly', async () => {
    const states: ServerStateSnapshot[] = [];
    const logs: string[] = [];

    const script =
      "console.log('main: server is listening on http://127.0.0.1:8080'); setInterval(() => {}, 1000);";
    const ctrl = startLlamaServeProcess({
      presetPath: '/tmp/test-preset.ini',
      serveCommand: `node -e "${script}" --`,
      onStateChange: (s) => states.push(s),
      onLogLine: (l) => logs.push(l),
    });

    try {
      expect(ctrl.pid).toBeDefined();

      // Wait briefly until the child prints the listening URL and transitions to 'running'
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const check = () => {
          if (states.some((s) => s.status === 'running')) {
            resolve();
          } else if (Date.now() > deadline) {
            reject(new Error(`Timed out waiting for server running state. Logs: ${logs.join(' | ')}`));
          } else {
            setTimeout(check, 20);
          }
        };
        check();
      });

      const runningState = states.find((s) => s.status === 'running');
      expect(runningState?.listeningUrl).toBe('http://127.0.0.1:8080');

      await ctrl.stop();
      expect(states[states.length - 1]?.status).toBe('stopped');
    } finally {
      ctrl.killImmediate();
    }
  });
});
