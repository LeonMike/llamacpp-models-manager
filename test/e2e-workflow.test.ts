import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrganizationPlan, executeOrganizationPlan } from '../src/core/organizer.js';
import {
  loadPresetFile,
  savePresetFile,
  serializePresetIni,
  syncPresetWithScan,
} from '../src/core/preset-config.js';
import { scanModelsDirectory } from '../src/core/scanner.js';
import { writeSyntheticGgufFile } from './helpers/gguf-fixture.js';

describe('end-to-end scan -> organize -> preset generation workflow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-e2e-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('organizes unsorted models and generates a valid llama serve --models-preset file with conditional draft fields', async () => {
    const rawDir = path.join(tmpDir, 'incoming');
    await fs.mkdir(rawDir, { recursive: true });

    // Model 1: Qwen3-14B with an MTP draft model
    await writeSyntheticGgufFile(path.join(rawDir, 'Qwen3-14B-Q4_K_M.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'qwen3' },
      { key: 'general.basename', type: 'string', value: 'Qwen3-14B' },
      { key: 'general.file_type', type: 'uint32', value: 15 },
    ]);
    await writeSyntheticGgufFile(path.join(rawDir, 'Qwen3-14B-mtp-Q8_0.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'qwen3' },
      { key: 'general.basename', type: 'string', value: 'Qwen3-14B' },
      { key: 'general.file_type', type: 'uint32', value: 7 },
    ]);

    // Model 2: Gemma-3-12B-it with an mmproj vision encoder (NO draft model)
    await writeSyntheticGgufFile(path.join(rawDir, 'gemma-3-12b-it-Q8_0.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'gemma3' },
      { key: 'general.basename', type: 'string', value: 'gemma-3-12b-it' },
      { key: 'general.file_type', type: 'uint32', value: 7 },
    ]);
    await writeSyntheticGgufFile(path.join(rawDir, 'mmproj-gemma-3-12b-it-f16.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'clip' },
      { key: 'general.file_type', type: 'uint32', value: 1 },
    ]);

    // 1. Scan & Organize in-place
    const initialScan = await scanModelsDirectory(tmpDir);
    const plan = await createOrganizationPlan(initialScan);
    const orgRes = await executeOrganizationPlan(plan);
    expect(orgRes.movedCount).toBe(4);
    expect(orgRes.errors).toHaveLength(0);

    // 2. Rescan organized directory and generate preset
    const postScan = await scanModelsDirectory(tmpDir);
    const presetPath = path.join(tmpDir, 'models-preset.ini');
    const doc = syncPresetWithScan(postScan);

    // Configure [*] common settings
    doc.common.jinja = true;
    doc.common['top-p'] = 0.95;
    doc.common['top-k'] = 40;
    doc.common.custom['flash-attn'] = 'auto';

    // Configure draft options on Qwen3-14B-Q4_K_M (which has model-draft)
    const qwenSec = doc.models['Qwen3-14B-Q4_K_M'];
    expect(qwenSec).toBeDefined();
    expect(qwenSec['model-draft']).toBe(
      path.join(tmpDir, 'qwen3', 'Qwen3-14B', 'Qwen3-14B-mtp-Q8_0.gguf')
    );
    qwenSec['cache-type-k-draft'] = 'q8_0';
    qwenSec['cache-type-v-draft'] = 'q8_0';
    qwenSec['n-gpu-layers-draft'] = 99;
    qwenSec['spec-draft-n-max'] = 16;
    qwenSec['spec-draft-p-min'] = 0.8;

    // Verify Gemma-3-12B-it-Q8_0 has mmproj and NO model-draft
    const gemmaSec = doc.models['gemma-3-12b-it-Q8_0'];
    expect(gemmaSec).toBeDefined();
    expect(gemmaSec.mmproj).toBe(
      path.join(tmpDir, 'gemma3', 'gemma-3-12b-it', 'mmproj-gemma-3-12b-it-f16.gguf')
    );
    expect(gemmaSec['model-draft']).toBeUndefined();

    await savePresetFile(presetPath, doc);
    const reloaded = await loadPresetFile(presetPath);
    const serialized = serializePresetIni(reloaded);

    expect(serialized).toContain('[*]');
    expect(serialized).toContain('jinja = true');
    expect(serialized).toContain('spec-draft-n-max = 16');
    expect(serialized).toContain('spec-draft-p-min = 0.8');

    const gemmaSectionText = serialized
      .split('[gemma-3-12b-it-Q8_0]')[1]
      .split('[Qwen3-14B-Q4_K_M]')[0];
    expect(gemmaSectionText).toContain('mmproj =');
    expect(gemmaSectionText).not.toContain('model-draft');
    expect(gemmaSectionText).not.toContain('spec-draft-n-max');
  });
});
