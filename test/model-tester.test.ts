import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildModelTestCommandArgs,
  compareTokensPerSecond,
  cycleModelDetailVisibility,
  DEFAULT_APP_TEST_SETTINGS,
  DEFAULT_MODEL_LIST_HOTKEYS,
  getModelAggregateTestStatus,
  getSectionTestStatus,
  getTestStatusColor,
  loadAppTestSettings,
  loadSectionTestStatuses,
  parseTokensPerSecondFromOutput,
  recordCompletedTestStatus,
  recordRunningTestStatus,
  resolveModelListHotkeys,
  saveAppTestSettings,
  saveSectionTestStatuses,
  startBatchModelConfigurationTest,
  startModelConfigurationTest,
} from '../src/core/model-tester.js';
import {
  CommonPresetConfig,
  ModelPresetSection,
  SectionTestStatus,
  VALUELESS_FLAG_MARKER,
} from '../src/types/index.js';

describe('model-tester (llama cli configuration test runner)', () => {
  it('builds llama cli arguments merging [*] common settings, model flags, conditional draft flags, default prompt, and --single-turn', () => {
    const common: CommonPresetConfig = {
      jinja: true,
      temp: 0.7,
      'top-p': 0.9,
      custom: {
        'no-warmup': VALUELESS_FLAG_MARKER,
      },
    };

    const sectionWithDraft: ModelPresetSection = {
      sectionId: 'Qwen3-14B-Q4_K_M',
      model: '/models/qwen3/Qwen3-14B/Q4_K_M/Qwen3-14B-Q4_K_M.gguf',
      'model-draft': '/models/qwen3/Qwen3-14B/Qwen3-14B-mtp-Q8_0.gguf',
      'n-gpu-layers': 99,
      'spec-draft-n-max': 16,
      'spec-type': 'draft-mtp',
      custom: {
        'special': VALUELESS_FLAG_MARKER,
        'lora-scaled': 'adapter.gguf',
      },
    };

    const built = buildModelTestCommandArgs(common, sectionWithDraft, DEFAULT_APP_TEST_SETTINGS);
    expect(built.executable).toBe('llama');
    expect(built.args[0]).toBe('cli');
    expect(built.args).toContain('--jinja');
    expect(built.args).toContain('--no-warmup');
    expect(built.args).not.toContain(VALUELESS_FLAG_MARKER);
    expect(built.args).toContain('--special');
    expect(built.args).toContain('--lora-scaled');
    expect(built.args).toContain('adapter.gguf');
    expect(built.args).toContain('--model');
    expect(built.args).toContain('/models/qwen3/Qwen3-14B/Q4_K_M/Qwen3-14B-Q4_K_M.gguf');
    expect(built.args).toContain('--model-draft');
    expect(built.args).toContain('/models/qwen3/Qwen3-14B/Qwen3-14B-mtp-Q8_0.gguf');
    expect(built.args).toContain('--spec-draft-n-max');
    expect(built.args).toContain('16');
    expect(built.args).toContain('--spec-type');
    expect(built.args).toContain('draft-mtp');
    expect(built.args).toContain('-p');
    expect(built.args).toContain('why is the sky blue?');
    expect(built.args).toContain('--single-turn');
    expect(built.args).toContain('--simple-io');

    // Without model-draft, draft options are omitted
    const sectionWithoutDraft: ModelPresetSection = {
      ...sectionWithDraft,
      'model-draft': undefined,
    };
    const builtNoDraft = buildModelTestCommandArgs(
      common,
      sectionWithoutDraft,
      DEFAULT_APP_TEST_SETTINGS
    );
    expect(builtNoDraft.args).not.toContain('--model-draft');
    expect(builtNoDraft.args).not.toContain('--spec-draft-n-max');
    expect(builtNoDraft.args).not.toContain('--spec-type');
  });

  it('spawns only the specific test child process, captures output, and closes its exact PID immediately on completion or abort', async () => {
    const common: CommonPresetConfig = { custom: {} };
    const section: ModelPresetSection = {
      sectionId: 'Test-Model',
      model: '/tmp/test.gguf',
      custom: {},
    };

    // Use node -e with -- serving as argument separator so node ignores trailing --model / -p flags
    const controller = startModelConfigurationTest(common, section, {
      testCommand: `node -e "console.log('Rayleigh scattering makes the sky blue.', process.argv.slice(1).join(' '))" --`,
      defaultPrompt: 'why is the sky blue?',
      maxPredictTokens: 32,
      timeoutSeconds: 10,
    });

    expect(controller.pid).toBeTypeOf('number');
    const res = await controller.promise;
    expect(res.success).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.combinedOutput).toContain('Rayleigh scattering makes the sky blue.');
    expect(res.combinedOutput).toContain('--model /tmp/test.gguf');
    expect(res.combinedOutput).toContain('why is the sky blue?');
  });

  it('persists custom testCommand, serveHost, servePort, and defaultPrompt in app settings file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-settings-test-'));
    try {
      const presetPath = path.join(tmpDir, 'models-preset.ini');

      const defaults = await loadAppTestSettings(presetPath);
      expect(defaults.serveHost).toBe('0.0.0.0');
      expect(defaults.servePort).toBe(8080);

      await saveAppTestSettings(presetPath, {
        testCommand: 'llama-cli -p "{PROMPT}"',
        serveHost: '127.0.0.1',
        servePort: 9090,
        defaultPrompt: 'Explain quantum entanglement in one sentence.',
        maxPredictTokens: 48,
        timeoutSeconds: 60,
      });

      const loaded = await loadAppTestSettings(presetPath);
      expect(loaded.testCommand).toBe('llama-cli -p "{PROMPT}"');
      expect(loaded.serveHost).toBe('127.0.0.1');
      expect(loaded.servePort).toBe(9090);
      expect(loaded.defaultPrompt).toBe('Explain quantum entanglement in one sentence.');
      expect(loaded.maxPredictTokens).toBe(48);
      expect(loaded.timeoutSeconds).toBe(60);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes per-section and aggregate model test status (gray for not ran, green for passed, red for failed) and runs batch tests sequentially', async () => {
    const common: CommonPresetConfig = { custom: {} };
    const sec1: ModelPresetSection = {
      sectionId: 'Model-A-base',
      model: '/tmp/pass-1.gguf',
      custom: {},
    };
    const sec2: ModelPresetSection = {
      sectionId: 'Model-A-vision',
      model: '/tmp/fail-2.gguf',
      mmproj: '/tmp/mmproj.gguf',
      custom: {},
    };

    const statusMap: Record<string, SectionTestStatus> = {};

    // Initially untested -> gray
    expect(getSectionTestStatus(sec1.sectionId, statusMap)).toBe('untested');
    expect(getModelAggregateTestStatus([sec1, sec2], statusMap)).toBe('untested');
    expect(getTestStatusColor(getModelAggregateTestStatus([sec1, sec2], statusMap))).toBe('gray');

    // Run a batch test where sec1 succeeds (exit 0) and sec2 fails (exit 1)
    const batchCtrl = startBatchModelConfigurationTest(
      common,
      [sec1, sec2],
      {
        testCommand: `node -e "const args = process.argv.slice(1).join(' '); if (args.includes('fail-2.gguf')) { console.error('Failed to load model'); process.exit(1); } console.log('Model loaded OK');" --`,
        defaultPrompt: 'why is the sky blue?',
        maxPredictTokens: 16,
        timeoutSeconds: 10,
      },
      {
        onSectionStart: (sec) => {
          statusMap[sec.sectionId] = { status: 'running' };
        },
        onSectionComplete: (sec, _idx, _total, res) => {
          statusMap[sec.sectionId] = {
            status: res.success ? 'passed' : 'failed',
            lastResult: res,
          };
        },
      }
    );

    const results = await batchCtrl.promise;
    expect(results['Model-A-base'].success).toBe(true);
    expect(results['Model-A-vision'].success).toBe(false);

    // Individual section statuses
    expect(getSectionTestStatus('Model-A-base', statusMap)).toBe('passed');
    expect(getTestStatusColor(getSectionTestStatus('Model-A-base', statusMap))).toBe('green');
    expect(getSectionTestStatus('Model-A-vision', statusMap)).toBe('failed');
    expect(getTestStatusColor(getSectionTestStatus('Model-A-vision', statusMap))).toBe('red');

    // Model aggregate status: red if any config failed, green if all tested configs passed
    expect(getModelAggregateTestStatus([sec1, sec2], statusMap)).toBe('failed');
    expect(getTestStatusColor(getModelAggregateTestStatus([sec1, sec2], statusMap))).toBe('red');

    expect(getModelAggregateTestStatus([sec1], statusMap)).toBe('passed');
    expect(getTestStatusColor(getModelAggregateTestStatus([sec1], statusMap))).toBe('green');
  });

  it('extracts average tokens per second from llama cli output, saves it with test status, and compares against the previous saved average', async () => {
    // 1. Parse classic llama_perf_context_print (ignores prompt eval time, picks generation eval time)
    const classicOutput = [
      'llama_perf_context_print: prompt eval time =     120.40 ms /    18 tokens (    6.69 ms per token,   149.50 tokens per second)',
      'llama_perf_context_print:        eval time =    1234.56 ms /    64 runs   (   19.29 ms per token,    51.84 tokens per second)',
    ].join('\n');
    expect(parseTokensPerSecondFromOutput(classicOutput)).toBeCloseTo(51.84, 2);

    // 2. Parse modern llama-cli summary bar (plain and with ANSI escape sequences / carriage returns)
    const modernOutput = '[ Prompt: 215.4 t/s | Generation: 68.75 t/s ]';
    expect(parseTokensPerSecondFromOutput(modernOutput)).toBeCloseTo(68.75, 2);

    const ansiOutput = '\r\x1b[90m[ Prompt: \x1b[1m215.4\x1b[0m\x1b[90m t/s | Generation: \x1b[1;32m74.20\x1b[0m\x1b[90m t/s ]\x1b[0m\r\n';
    expect(parseTokensPerSecondFromOutput(ansiOutput)).toBeCloseTo(74.2, 2);

    const msPerTokOutput = 'common_perf_print: eval time = 800.00 ms / 40 runs ( 20.00 ms per token)';
    expect(parseTokensPerSecondFromOutput(msPerTokOutput)).toBeCloseTo(50.0, 2);

    const decodedOutput = 'decoded 64 tokens in 1.28 s, speed: 50.00 t/s';
    expect(parseTokensPerSecondFromOutput(decodedOutput)).toBeCloseTo(50.0, 2);

    // 3. First test run records baseline avgTokensPerSec
    const common: CommonPresetConfig = { custom: {} };
    const section: ModelPresetSection = {
      sectionId: 'Qwen3-8B-Q4_K_M',
      model: '/tmp/qwen3.gguf',
      custom: {},
    };

    const run1Ctrl = startModelConfigurationTest(common, section, {
      testCommand: `node -e "console.log('eval time = 1000 ms / 50 runs (20.0 ms per token, 50.00 tokens per second)')" --`,
      defaultPrompt: 'why is the sky blue?',
      maxPredictTokens: 32,
      timeoutSeconds: 10,
    });
    const run1Res = await run1Ctrl.promise;
    expect(run1Res.avgTokensPerSec).toBeCloseTo(50.0, 2);

    let statusEntry = recordCompletedTestStatus(undefined, run1Res);
    expect(statusEntry.avgTokensPerSec).toBeCloseTo(50.0, 2);
    expect(statusEntry.previousAvgTokensPerSec).toBeUndefined();

    const cmpBaseline = compareTokensPerSecond(
      statusEntry.avgTokensPerSec,
      statusEntry.previousAvgTokensPerSec
    );
    expect(cmpBaseline.direction).toBe('none');
    expect(cmpBaseline.formattedCurrent).toBe('50.00 t/s');

    // 4. Second test run is faster (65.00 t/s) -> shifts 50.00 t/s to previousAvgTokensPerSec and marks 'better'
    statusEntry = recordRunningTestStatus(statusEntry);
    expect(statusEntry.avgTokensPerSec).toBeCloseTo(50.0, 2);

    const run2Ctrl = startModelConfigurationTest(common, section, {
      testCommand: `node -e "console.log('eval time = 1000 ms / 65 runs (15.38 ms per token, 65.00 tokens per second)')" --`,
      defaultPrompt: 'why is the sky blue?',
      maxPredictTokens: 32,
      timeoutSeconds: 10,
    });
    const run2Res = await run2Ctrl.promise;
    statusEntry = recordCompletedTestStatus(statusEntry, run2Res);

    expect(statusEntry.avgTokensPerSec).toBeCloseTo(65.0, 2);
    expect(statusEntry.previousAvgTokensPerSec).toBeCloseTo(50.0, 2);

    const cmpBetter = compareTokensPerSecond(
      statusEntry.avgTokensPerSec,
      statusEntry.previousAvgTokensPerSec
    );
    expect(cmpBetter.direction).toBe('better');
    expect(cmpBetter.deltaTps).toBeCloseTo(15.0, 2);
    expect(cmpBetter.deltaPercent).toBeCloseTo(30.0, 1);
    expect(cmpBetter.formattedDetailedComparison).toContain('BETTER');

    // 5. Third test run is slower (45.50 t/s) -> shifts 65.00 t/s to previousAvgTokensPerSec and marks 'worse'
    statusEntry = recordRunningTestStatus(statusEntry);
    const run3Ctrl = startModelConfigurationTest(common, section, {
      testCommand: `node -e "console.log('[ Prompt: 180.0 t/s | Generation: 45.50 t/s ]')" --`,
      defaultPrompt: 'why is the sky blue?',
      maxPredictTokens: 32,
      timeoutSeconds: 10,
    });
    const run3Res = await run3Ctrl.promise;
    statusEntry = recordCompletedTestStatus(statusEntry, run3Res);

    expect(statusEntry.avgTokensPerSec).toBeCloseTo(45.5, 2);
    expect(statusEntry.previousAvgTokensPerSec).toBeCloseTo(65.0, 2);

    const cmpWorse = compareTokensPerSecond(
      statusEntry.avgTokensPerSec,
      statusEntry.previousAvgTokensPerSec
    );
    expect(cmpWorse.direction).toBe('worse');
    expect(cmpWorse.deltaTps).toBeCloseTo(-19.5, 2);
    expect(cmpWorse.formattedDetailedComparison).toContain('WORSE');

    // 6. Verify persistence of avgTokensPerSec and previousAvgTokensPerSec to disk
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-tps-test-'));
    try {
      const presetPath = path.join(tmpDir, 'models-preset.ini');
      await saveSectionTestStatuses(presetPath, {
        [section.sectionId]: statusEntry,
      });
      const loaded = await loadSectionTestStatuses(presetPath);
      expect(loaded[section.sectionId].avgTokensPerSec).toBeCloseTo(45.5, 2);
      expect(loaded[section.sectionId].previousAvgTokensPerSec).toBeCloseTo(65.0, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    // 7. Fallback measurement when llama-cli --single-turn suppresses LOG_INF timing lines and only streams text
    const noTimingCtrl = startModelConfigurationTest(common, section, {
      testCommand: `node -e "console.error('load_tensors: done'); setTimeout(() => { process.stdout.write('The sky '); setTimeout(() => { process.stdout.write('appears blue '); setTimeout(() => { process.stdout.write('due to Rayleigh scattering.'); }, 25); }, 25); }, 20);" --`,
      defaultPrompt: 'why is the sky blue?',
      maxPredictTokens: 32,
      timeoutSeconds: 10,
    });
    const noTimingRes = await noTimingCtrl.promise;
    expect(noTimingRes.success).toBe(true);
    expect(noTimingRes.avgTokensPerSec).toBeDefined();
    expect(noTimingRes.avgTokensPerSec!).toBeGreaterThan(0);
    expect(noTimingRes.combinedOutput).toContain('[Measured avg generation speed:');
  });

  it('cycles model detail visibility modes and persists visibility mode + configurable hotkeys', async () => {
    expect(DEFAULT_MODEL_LIST_HOTKEYS.cycleDetailMode).toBe('i');
    expect(cycleModelDetailVisibility('names-only')).toBe('names-and-configs');
    expect(cycleModelDetailVisibility('names-and-configs')).toBe('full');
    expect(cycleModelDetailVisibility('full')).toBe('names-only');

    const resolved = resolveModelListHotkeys({ cycleDetailMode: 'v', toggleExport: 'e' });
    expect(resolved.cycleDetailMode).toBe('v');
    expect(resolved.toggleExport).toBe('e');
    expect(resolved.testModel).toBe('t');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-visibility-settings-test-'));
    try {
      const presetPath = path.join(tmpDir, 'preset.ini');
      await saveAppTestSettings(presetPath, {
        ...DEFAULT_APP_TEST_SETTINGS,
        modelDetailVisibility: 'names-and-configs',
        hotkeys: {
          ...DEFAULT_MODEL_LIST_HOTKEYS,
          cycleDetailMode: 'o',
        },
      });

      const loaded = await loadAppTestSettings(presetPath);
      expect(loaded.modelDetailVisibility).toBe('names-and-configs');
      expect(loaded.hotkeys?.cycleDetailMode).toBe('o');
      expect(loaded.hotkeys?.toggleExport).toBe('x');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
