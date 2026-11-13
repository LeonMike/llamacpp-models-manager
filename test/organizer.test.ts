import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrganizationPlan, executeOrganizationPlan } from '../src/core/organizer.js';
import { scanModelsDirectory } from '../src/core/scanner.js';
import { writeSyntheticGgufFile } from './helpers/gguf-fixture.js';

describe('scanner and organizer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-org-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scans scattered models, pairs mmproj and mtp files, and organizes them into <family>/<model>/<quant>', async () => {
    // Create an unsorted directory layout
    const unsortedA = path.join(tmpDir, 'downloads', 'qwen');
    const unsortedB = path.join(tmpDir, 'misc_models');
    await fs.mkdir(unsortedA, { recursive: true });
    await fs.mkdir(unsortedB, { recursive: true });

    // 1. Qwen2.5-VL-7B-Instruct Q4_K_M + Q8_0 + shared mmproj + shared mtp
    await writeSyntheticGgufFile(path.join(unsortedA, 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'qwen2' },
      { key: 'general.basename', type: 'string', value: 'Qwen2.5-VL-7B-Instruct' },
      { key: 'general.file_type', type: 'uint32', value: 15 },
    ]);

    await writeSyntheticGgufFile(path.join(unsortedB, 'Qwen2.5-VL-7B-Instruct-Q8_0.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'qwen2' },
      { key: 'general.basename', type: 'string', value: 'Qwen2.5-VL-7B-Instruct' },
      { key: 'general.file_type', type: 'uint32', value: 7 },
    ]);

    await writeSyntheticGgufFile(path.join(unsortedB, 'mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'clip' },
      { key: 'general.file_type', type: 'uint32', value: 1 },
    ]);

    await writeSyntheticGgufFile(path.join(unsortedA, 'Qwen2.5-VL-7B-Instruct-mtp-Q4_K_M.gguf'), [
      { key: 'general.architecture', type: 'string', value: 'qwen2' },
      { key: 'general.basename', type: 'string', value: 'Qwen2.5-VL-7B-Instruct' },
    ]);

    // 2. Multi-part sharded model: Llama-3.1-70B-Instruct (2 shards)
    await writeSyntheticGgufFile(
      path.join(unsortedB, 'Llama-3.1-70B-Instruct-Q4_K_M-00001-of-00002.gguf'),
      [
        { key: 'general.architecture', type: 'string', value: 'llama' },
        { key: 'general.basename', type: 'string', value: 'Llama-3.1-70B-Instruct' },
        { key: 'general.file_type', type: 'uint32', value: 15 },
      ]
    );
    await writeSyntheticGgufFile(
      path.join(unsortedB, 'Llama-3.1-70B-Instruct-Q4_K_M-00002-of-00002.gguf'),
      [
        { key: 'general.architecture', type: 'string', value: 'llama' },
        { key: 'general.basename', type: 'string', value: 'Llama-3.1-70B-Instruct' },
        { key: 'general.file_type', type: 'uint32', value: 15 },
      ]
    );

    // Step 1: Scan
    const scanResult = await scanModelsDirectory(tmpDir);
    expect(scanResult.files).toHaveLength(6);
    expect(scanResult.groups).toHaveLength(2);
    expect(scanResult.orphanAuxFiles).toHaveLength(0);

    const qwenGroup = scanResult.groups.find((g) => g.family === 'qwen2');
    expect(qwenGroup).toBeDefined();
    expect(qwenGroup?.modelName).toBe('Qwen2.5-VL-7B-Instruct');
    expect(qwenGroup?.variants).toHaveLength(2);
    expect(qwenGroup?.mmprojFiles).toHaveLength(1);
    expect(qwenGroup?.mtpFiles).toHaveLength(1);

    const llamaGroup = scanResult.groups.find((g) => g.family === 'llama');
    expect(llamaGroup).toBeDefined();
    expect(llamaGroup?.variants).toHaveLength(1);
    expect(llamaGroup?.variants[0].allShardFiles).toHaveLength(2);
    expect(llamaGroup?.variants[0].primaryFile.fileName).toBe(
      'Llama-3.1-70B-Instruct-Q4_K_M-00001-of-00002.gguf'
    );

    // Step 2: Plan organization (dry-run)
    const plan = await createOrganizationPlan(scanResult);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.operations).toHaveLength(6);
    expect(plan.operations.every((op) => op.status === 'pending')).toBe(true);

    // Step 3: Execute organization
    const result = await executeOrganizationPlan(plan);
    expect(result.movedCount).toBe(6);
    expect(result.errors).toHaveLength(0);

    // Verify organized paths exist at `<root>/<family>/<modelName>/<quantization>/...`
    // and shared mmproj/mtp exist at `<root>/<family>/<modelName>/...`
    const expectedFiles = [
      path.join(tmpDir, 'qwen2', 'Qwen2.5-VL-7B-Instruct', 'Q4_K_M', 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf'),
      path.join(tmpDir, 'qwen2', 'Qwen2.5-VL-7B-Instruct', 'Q8_0', 'Qwen2.5-VL-7B-Instruct-Q8_0.gguf'),
      path.join(tmpDir, 'qwen2', 'Qwen2.5-VL-7B-Instruct', 'mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf'),
      path.join(tmpDir, 'qwen2', 'Qwen2.5-VL-7B-Instruct', 'Qwen2.5-VL-7B-Instruct-mtp-Q4_K_M.gguf'),
      path.join(
        tmpDir,
        'llama',
        'Llama-3.1-70B-Instruct',
        'Q4_K_M',
        'Llama-3.1-70B-Instruct-Q4_K_M-00001-of-00002.gguf'
      ),
      path.join(
        tmpDir,
        'llama',
        'Llama-3.1-70B-Instruct',
        'Q4_K_M',
        'Llama-3.1-70B-Instruct-Q4_K_M-00002-of-00002.gguf'
      ),
    ];

    for (const expected of expectedFiles) {
      const stat = await fs.stat(expected);
      expect(stat.isFile()).toBe(true);
    }

    // Re-scanning and re-planning should mark all 6 files as 'already-organized'
    const rescan = await scanModelsDirectory(tmpDir);
    const secondPlan = await createOrganizationPlan(rescan);
    expect(secondPlan.operations.every((op) => op.status === 'already-organized')).toBe(true);
  });
});

