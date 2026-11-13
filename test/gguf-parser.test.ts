import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectModelFamily,
  detectModelRole,
  detectMoeModel,
  detectQuantization,
  inspectGgufFile,
  parseShardInfo,
  readGgufHeader,
} from '../src/core/gguf-parser.js';
import { writeSyntheticGgufFile } from './helpers/gguf-fixture.js';

describe('gguf-parser', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-gguf-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads binary GGUF v3 header metadata including arrays and general.* keys', async () => {
    const filePath = path.join(tmpDir, 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf');
    await writeSyntheticGgufFile(filePath, [
      { key: 'general.architecture', type: 'string', value: 'qwen2vl' },
      { key: 'general.basename', type: 'string', value: 'Qwen2.5-VL-7B-Instruct' },
      { key: 'general.name', type: 'string', value: 'Qwen2.5 VL 7B Instruct' },
      { key: 'general.size_label', type: 'string', value: '7B' },
      { key: 'general.file_type', type: 'uint32', value: 15 }, // 15 -> Q4_K_M
      { key: 'tokenizer.ggml.tokens', type: 'string_array', value: ['<unk>', '<s>', '</s>'] },
      { key: 'general.quantization_version', type: 'uint32', value: 2 },
    ]);

    const header = await readGgufHeader(filePath);
    expect(header).not.toBeNull();
    expect(header?.version).toBe(3);
    expect(header?.architecture).toBe('qwen2vl');
    expect(header?.basename).toBe('Qwen2.5-VL-7B-Instruct');
    expect(header?.fileType).toBe(15);
    expect(header?.quantizationVersion).toBe(2);
  });

  it('returns null when reading a non-GGUF file and falls back to filename heuristics', async () => {
    const fakeFile = path.join(tmpDir, 'Llama-3.3-70B-Instruct-Q8_0.gguf');
    await fs.writeFile(fakeFile, 'NOT_A_GGUF_HEADER_AT_ALL');

    const header = await readGgufHeader(fakeFile);
    expect(header).toBeNull();

    const inspected = await inspectGgufFile(fakeFile);
    expect(inspected.headerParsed).toBe(false);
    expect(inspected.role).toBe('model');
    expect(inspected.family).toBe('llama');
    expect(inspected.modelName).toBe('Llama-3.3-70B-Instruct');
    expect(inspected.quantization).toBe('Q8_0');
  });

  it('detects mmproj files from both CLIP header architecture and filename', async () => {
    const clipFile = path.join(tmpDir, 'vision-encoder-f16.gguf');
    await writeSyntheticGgufFile(clipFile, [
      { key: 'general.architecture', type: 'string', value: 'clip' },
      { key: 'clip.has_vision_encoder', type: 'bool', value: true },
      { key: 'general.file_type', type: 'uint32', value: 1 }, // F16
    ]);

    const inspectedClip = await inspectGgufFile(clipFile);
    expect(inspectedClip.role).toBe('mmproj');
    expect(inspectedClip.quantization).toBe('F16');

    expect(detectModelRole('mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf', null)).toBe('mmproj');
  });

  it('detects mtp / draft models from filename and header', async () => {
    const mtpFile = path.join(tmpDir, 'DeepSeek-V3-mtp-Q4_K_M.gguf');
    await writeSyntheticGgufFile(mtpFile, [
      { key: 'general.architecture', type: 'string', value: 'deepseek2' },
      { key: 'general.basename', type: 'string', value: 'DeepSeek-V3' },
      { key: 'general.file_type', type: 'uint32', value: 15 },
    ]);

    const inspectedMtp = await inspectGgufFile(mtpFile);
    expect(inspectedMtp.role).toBe('mtp');
    expect(inspectedMtp.family).toBe('deepseek2');
    expect(inspectedMtp.modelName).toBe('DeepSeek-V3');
    expect(inspectedMtp.quantization).toBe('Q4_K_M');
  });

  it('parses multi-part shard filenames accurately', () => {
    const shard = parseShardInfo('Llama-3.1-405B-Q4_K_M-00001-of-00005.gguf');
    expect(shard).toEqual({
      baseFilename: 'Llama-3.1-405B-Q4_K_M.gguf',
      index: 1,
      total: 5,
    });

    expect(detectQuantization('Llama-3.1-405B-Q4_K_M-00001-of-00005.gguf', null)).toBe('Q4_K_M');
    expect(detectModelFamily('Gemma-3-27B-it-BF16.gguf', null)).toBe('gemma3');
  });

  it('detects Mixture-of-Experts (MoE) models via GGUF expert_count header or filename heuristics', async () => {
    const moeFile = path.join(tmpDir, 'Qwen3-30B-A3B-Q4_K_M.gguf');
    await writeSyntheticGgufFile(moeFile, [
      { key: 'general.architecture', type: 'string', value: 'qwen3moe' },
      { key: 'general.basename', type: 'string', value: 'Qwen3-30B-A3B' },
      { key: 'qwen3moe.expert_count', type: 'uint32', value: 128 },
      { key: 'qwen3moe.expert_used_count', type: 'uint32', value: 8 },
      { key: 'general.file_type', type: 'uint32', value: 15 },
    ]);

    const inspected = await inspectGgufFile(moeFile);
    expect(inspected.isMoe).toBe(true);
    expect(inspected.metadata.expertCount).toBe(128);
    expect(inspected.metadata.expertUsedCount).toBe(8);

    // Filename heuristics when header is not present
    expect(detectMoeModel('Mixtral-8x7B-Instruct-v0.1-Q4_K_M.gguf', null)).toBe(true);
    expect(detectMoeModel('Qwen3-30B-A3B-Q8_0.gguf', null)).toBe(true);
    expect(detectMoeModel('Llama-3.1-8B-Instruct-Q4_K_M.gguf', null)).toBe(false);
  });
});

