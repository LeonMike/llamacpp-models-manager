import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  GgufHeaderMetadata,
  GgufModelRole,
  ScannedGgufFile,
  ShardInfo,
} from '../types/index.js';

const GGUF_MAGIC = 0x46554747; // "GGUF" in little-endian ('G', 'G', 'U', 'F')
const MAX_HEADER_BYTES = 2 * 1024 * 1024; // Read up to 2MB max for header metadata
const INITIAL_READ_BYTES = 128 * 1024; // 128KB initial chunk
const MAX_ARRAY_SKIP_ELEMENTS = 10000; // Avoid parsing giant tokenizer arrays if not needed

enum GgufValueType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

/**
 * Standard llama.cpp GGUF `general.file_type` integer to quantization name mapping.
 */
export const GGUF_FILE_TYPE_MAP: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  33: 'Q4_0_4_4',
  34: 'Q4_0_4_8',
  35: 'Q4_0_8_8',
  36: 'TQ1_0',
  37: 'TQ2_0',
};

class BufferReader {
  private offset = 0;

  constructor(private buf: Buffer) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  ensure(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new RangeError('NEED_MORE_BYTES');
    }
  }

  readUInt8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt8(): number {
    this.ensure(1);
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUInt16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt16(): number {
    this.ensure(2);
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readUInt32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readInt32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readFloat32(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readInt64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readFloat64(): number {
    this.ensure(8);
    const v = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }

  readBool(): boolean {
    return this.readUInt8() !== 0;
  }

  readString(): string {
    const lenBig = this.readUInt64();
    const len = Number(lenBig);
    if (len < 0 || len > MAX_HEADER_BYTES) {
      throw new Error(`Invalid GGUF string length: ${len}`);
    }
    this.ensure(len);
    const str = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return str;
  }

  skipString(): void {
    const lenBig = this.readUInt64();
    const len = Number(lenBig);
    if (len < 0 || len > MAX_HEADER_BYTES * 8) {
      throw new Error(`Invalid GGUF string length: ${len}`);
    }
    this.ensure(len);
    this.offset += len;
  }

  readValue(type: GgufValueType, skipLargeValues = false): string | number | boolean | bigint | undefined {
    switch (type) {
      case GgufValueType.UINT8:
        return this.readUInt8();
      case GgufValueType.INT8:
        return this.readInt8();
      case GgufValueType.UINT16:
        return this.readUInt16();
      case GgufValueType.INT16:
        return this.readInt16();
      case GgufValueType.UINT32:
        return this.readUInt32();
      case GgufValueType.INT32:
        return this.readInt32();
      case GgufValueType.FLOAT32:
        return this.readFloat32();
      case GgufValueType.BOOL:
        return this.readBool();
      case GgufValueType.STRING:
        if (skipLargeValues) {
          this.skipString();
          return undefined;
        }
        return this.readString();
      case GgufValueType.UINT64:
        return this.readUInt64();
      case GgufValueType.INT64:
        return this.readInt64();
      case GgufValueType.FLOAT64:
        return this.readFloat64();
      case GgufValueType.ARRAY: {
        const elemType = this.readUInt32() as GgufValueType;
        const count = Number(this.readUInt64());
        if (count < 0 || count > MAX_ARRAY_SKIP_ELEMENTS * 100) {
          throw new Error(`Array too large to skip: ${count}`);
        }
        const fixedSize = getFixedTypeSize(elemType);
        if (fixedSize !== null) {
          this.ensure(fixedSize * count);
          this.offset += fixedSize * count;
        } else {
          for (let i = 0; i < count; i++) {
            this.readValue(elemType, true);
          }
        }
        return undefined;
      }
      default:
        throw new Error(`Unsupported GGUF value type: ${type}`);
    }
  }
}

function getFixedTypeSize(type: GgufValueType): number | null {
  switch (type) {
    case GgufValueType.UINT8:
    case GgufValueType.INT8:
    case GgufValueType.BOOL:
      return 1;
    case GgufValueType.UINT16:
    case GgufValueType.INT16:
      return 2;
    case GgufValueType.UINT32:
    case GgufValueType.INT32:
    case GgufValueType.FLOAT32:
      return 4;
    case GgufValueType.UINT64:
    case GgufValueType.INT64:
    case GgufValueType.FLOAT64:
      return 8;
    default:
      return null;
  }
}

const INTERESTING_KEYS = new Set([
  'general.architecture',
  'general.name',
  'general.basename',
  'general.finetune',
  'general.size_label',
  'general.file_type',
  'general.quantization_version',
  'general.type',
  'clip.has_vision_encoder',
  'clip.has_text_encoder',
  'clip.projector_type',
]);

/**
 * Reads the binary GGUF header from disk, extracting general.* metadata keys
 * without reading tensor buffers.
 */
export async function readGgufHeader(filePath: string): Promise<GgufHeaderMetadata | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (stat.size < 24) {
      return null;
    }

    let readSize = Math.min(stat.size, INITIAL_READ_BYTES);
    let buffer = Buffer.allocUnsafe(readSize);
    await handle.read(buffer, 0, readSize, 0);

    const magic = buffer.readUInt32LE(0);
    if (magic !== GGUF_MAGIC) {
      return null;
    }

    const version = buffer.readUInt32LE(4);
    if (version < 2 || version > 3) {
      return null;
    }

    const tensorCount = buffer.readBigUInt64LE(8);
    const kvCount = buffer.readBigUInt64LE(16);

    const rawKv: Record<string, string | number | boolean | bigint> = {};
    let reader = new BufferReader(buffer.subarray(24));
    const maxKvs = Math.min(Number(kvCount), 512);

    for (let i = 0; i < maxKvs; i++) {
      const savedOffset = reader.position;
      try {
        const key = reader.readString();
        const valType = reader.readUInt32() as GgufValueType;
        const isInteresting =
          INTERESTING_KEYS.has(key) ||
          key.startsWith('general.') ||
          key.startsWith('clip.') ||
          key.endsWith('.expert_count') ||
          key.endsWith('.expert_used_count') ||
          key.includes('mtp') ||
          key.includes('draft');

        const value = reader.readValue(valType, !isInteresting);
        if (isInteresting && value !== undefined) {
          rawKv[key] = value;
        }
      } catch (err) {
        if (err instanceof RangeError && err.message === 'NEED_MORE_BYTES') {
          if (readSize >= Math.min(stat.size, MAX_HEADER_BYTES)) {
            // Reached our cap (e.g. hit huge tokenizer array); return what we already extracted
            break;
          }
          readSize = Math.min(stat.size, Math.min(readSize * 4, MAX_HEADER_BYTES));
          buffer = Buffer.allocUnsafe(readSize);
          await handle.read(buffer, 0, readSize, 0);
          reader = new BufferReader(buffer.subarray(24 + savedOffset));
          i--; // Retry current KV pair
          continue;
        }
        // Any other parse error (e.g. giant tokenizer array): stop reading further KVs and keep extracted general.* keys
        break;
      }
    }

    let expertCount: number | undefined;
    let expertUsedCount: number | undefined;
    for (const [k, v] of Object.entries(rawKv)) {
      if (k.endsWith('.expert_count') && typeof v === 'number') {
        expertCount = v;
      } else if (k.endsWith('.expert_used_count') && typeof v === 'number') {
        expertUsedCount = v;
      }
    }

    return {
      version,
      tensorCount,
      kvCount,
      architecture: typeof rawKv['general.architecture'] === 'string' ? rawKv['general.architecture'] : undefined,
      name: typeof rawKv['general.name'] === 'string' ? rawKv['general.name'] : undefined,
      basename: typeof rawKv['general.basename'] === 'string' ? rawKv['general.basename'] : undefined,
      finetune: typeof rawKv['general.finetune'] === 'string' ? rawKv['general.finetune'] : undefined,
      sizeLabel: typeof rawKv['general.size_label'] === 'string' ? rawKv['general.size_label'] : undefined,
      fileType: typeof rawKv['general.file_type'] === 'number' ? rawKv['general.file_type'] : undefined,
      quantizationVersion:
        typeof rawKv['general.quantization_version'] === 'number'
          ? rawKv['general.quantization_version']
          : undefined,
      expertCount,
      expertUsedCount,
      rawKv,
    };
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

/**
 * Extracts multi-part shard info if filename matches `*-00001-of-00003.gguf`.
 */
export function parseShardInfo(fileName: string): ShardInfo | undefined {
  const match = fileName.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!match) {
    return undefined;
  }
  return {
    baseFilename: `${match[1]}.gguf`,
    index: parseInt(match[2], 10),
    total: parseInt(match[3], 10),
  };
}

const QUANT_REGEX =
  /(?:^|[-_.])((?:I?Q[1-8](?:_[01KMSXL]+)*|BF16|F16|F32|FP16|FP32|TQ[12]_0)(?:[-_](?:S|M|L|XS|XXS|NL|4_4|4_8|8_8))?)(?=$|[-_.])/i;

/**
 * Extracts quantization string from filename or GGUF `general.file_type`.
 */
export function detectQuantization(fileName: string, metadata: GgufHeaderMetadata | null): string {
  // Strip shard suffix before matching quantization
  const shard = parseShardInfo(fileName);
  const cleanName = (shard ? shard.baseFilename : fileName).replace(/\.gguf$/i, '');

  const match = cleanName.match(QUANT_REGEX);
  if (match && match[1]) {
    const q = match[1].toUpperCase().replace(/-/g, '_');
    if (q === 'FP16') return 'F16';
    if (q === 'FP32') return 'F32';
    return q;
  }

  if (metadata?.fileType !== undefined && GGUF_FILE_TYPE_MAP[metadata.fileType]) {
    return GGUF_FILE_TYPE_MAP[metadata.fileType];
  }

  return 'UNKNOWN';
}

/**
 * Classifies whether a GGUF file is a main `model`, a multimodal projector (`mmproj`),
 * or a Multi-Token Prediction / speculative draft model (`mtp`).
 */
export function detectModelRole(fileName: string, metadata: GgufHeaderMetadata | null): GgufModelRole {
  const lowerName = fileName.toLowerCase();

  // Check mmproj indicators
  if (
    metadata?.architecture === 'clip' ||
    metadata?.rawKv['clip.has_vision_encoder'] === true ||
    metadata?.rawKv['clip.projector_type'] !== undefined ||
    /(?:^|[-_.])(mmproj|projector)(?:$|[-_.])/i.test(lowerName)
  ) {
    return 'mmproj';
  }

  // Check MTP / Draft indicators
  if (
    /(?:^|[-_.])(mtp|draft|eagle)(?:$|[-_.])/i.test(lowerName) ||
    metadata?.rawKv['general.type'] === 'draft' ||
    metadata?.rawKv['general.type'] === 'mtp'
  ) {
    return 'mtp';
  }

  return 'model';
}

const KNOWN_FAMILIES: Array<{ pattern: RegExp; family: string }> = [
  { pattern: /qwen3/i, family: 'qwen3' },
  { pattern: /qwen2\.?5/i, family: 'qwen2' },
  { pattern: /qwen2/i, family: 'qwen2' },
  { pattern: /qwen/i, family: 'qwen' },
  { pattern: /llama[-_.]?4/i, family: 'llama4' },
  { pattern: /llama[-_.]?3/i, family: 'llama' },
  { pattern: /llama/i, family: 'llama' },
  { pattern: /gemma[-_.]?3/i, family: 'gemma3' },
  { pattern: /gemma[-_.]?2/i, family: 'gemma2' },
  { pattern: /gemma/i, family: 'gemma' },
  { pattern: /deepseek/i, family: 'deepseek' },
  { pattern: /mistral|mixtral|ministral|pixtral/i, family: 'mistral' },
  { pattern: /phi[-_.]?[34]/i, family: 'phi3' },
  { pattern: /phi/i, family: 'phi' },
  { pattern: /command[-_.]?r/i, family: 'command-r' },
  { pattern: /yi/i, family: 'yi' },
  { pattern: /starcoder/i, family: 'starcoder2' },
  { pattern: /internlm/i, family: 'internlm2' },
  { pattern: /glm/i, family: 'chatglm' },
  { pattern: /smollm/i, family: 'smollm' },
  { pattern: /nemotron/i, family: 'nemotron' },
];

/**
 * Determines the model family/architecture folder name.
 */
export function detectModelFamily(fileName: string, metadata: GgufHeaderMetadata | null): string {
  const arch = metadata?.architecture?.trim().toLowerCase();
  if (arch && arch !== 'clip' && arch !== 'unknown') {
    return sanitizePathSegment(arch);
  }

  const candidateText = [metadata?.basename, metadata?.name, fileName].filter(Boolean).join(' ');
  for (const { pattern, family } of KNOWN_FAMILIES) {
    if (pattern.test(candidateText)) {
      return family;
    }
  }

  return 'other';
}

/**
 * Derives a clean, canonical model name without quantization, role prefixes (`mmproj-`, `mtp-`), or shard suffixes.
 */
export function deriveCleanModelName(
  fileName: string,
  role: GgufModelRole,
  quantization: string,
  metadata: GgufHeaderMetadata | null
): string {
  // Prefer `general.basename` if available and not a generic 'mmproj' label
  if (role === 'model' && metadata?.basename && metadata.basename.trim().length > 1) {
    return sanitizePathSegment( stripQuantAndRoleTokens(metadata.basename.trim(), quantization) );
  }

  const shard = parseShardInfo(fileName);
  const baseFile = (shard ? shard.baseFilename : fileName).replace(/\.gguf$/i, '');

  const cleaned = stripQuantAndRoleTokens(baseFile, quantization);
  if (cleaned.length > 0) {
    return sanitizePathSegment(cleaned);
  }

  if (metadata?.name && metadata.name.trim().length > 1) {
    return sanitizePathSegment(stripQuantAndRoleTokens(metadata.name.trim(), quantization));
  }

  return sanitizePathSegment(baseFile || 'Unknown-Model');
}

export function stripQuantAndRoleTokens(raw: string, quantization: string): string {
  let s = raw;

  // Strip common role prefixes/suffixes (mmproj, mtp, draft)
  s = s.replace(/^(?:mmproj|projector|mtp|draft)[-_.]*/i, '');
  s = s.replace(/[-_.]*(?:mmproj|projector|mtp|draft)(?=$|[-_.])/gi, '');

  // Strip explicit quantization token if known
  if (quantization && quantization !== 'UNKNOWN') {
    const escapedQuant = quantization.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[-_]');
    const quantPattern = new RegExp(`(?:^|[-_.])${escapedQuant}(?=$|[-_.])`, 'ig');
    s = s.replace(quantPattern, '');
  }

  // Also strip any trailing standard quant token (e.g., -F16, -BF16, -Q4_K_M, -f32)
  s = s.replace(
    /[-_.](?:I?Q[1-8](?:[-_][01KMSXL]+)*|BF16|F16|F32|FP16|FP32|TQ[12]_0)(?:[-_](?:S|M|L|XS|XXS|NL))?$/i,
    ''
  );

  // Clean up leading/trailing separators and "-gguf" suffix
  s = s.replace(/[-_.]*gguf$/i, '');
  s = s.replace(/^[-_.]+|[-_.]+$/g, '');

  return s || raw;
}

export function sanitizePathSegment(segment: string): string {
  return segment
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Detects whether a GGUF model is a Mixture-of-Experts (MoE) architecture
 * using GGUF header metadata (`*.expert_count > 1` or architecture suffix `moe`)
 * and filename/model-name patterns (`Mixtral`, `A3B`, `8x7B`, `-MoE`, etc.).
 */
export function detectMoeModel(fileName: string, metadata: GgufHeaderMetadata | null): boolean {
  if (metadata?.expertCount !== undefined && metadata.expertCount > 1) {
    return true;
  }

  if (metadata?.rawKv) {
    for (const [k, v] of Object.entries(metadata.rawKv)) {
      if (k.endsWith('.expert_count') && typeof v === 'number' && v > 1) {
        return true;
      }
    }
  }

  const arch = metadata?.architecture?.toLowerCase() ?? '';
  if (arch.includes('moe') || arch === 'dbrx' || arch === 'deepseek2' || arch === 'arctic') {
    return true;
  }

  const combinedText = [
    fileName,
    metadata?.basename,
    metadata?.name,
    metadata?.sizeLabel,
  ]
    .filter(Boolean)
    .join(' ');

  // Match MoE indicators: explicit "moe", "mixtral", "dbrx", "qwen*-a*b" (e.g. Qwen3-30B-A3B), "8x7B" / "16x14B"
  if (
    /(?:^|[-_.\s])(moe|mixtral|dbrx|jamba|arctic|olmoe|phimoe|granitemoe)(?:$|[-_.\s])/i.test(
      combinedText
    ) ||
    /\b\d+x\d+(?:\.\d+)?b\b/i.test(combinedText) ||
    /\b\d+b[-_.]a\d+(?:\.\d+)?b\b/i.test(combinedText)
  ) {
    return true;
  }

  return false;
}

/**
 * Inspects a single `.gguf` file on disk and returns its parsed `ScannedGgufFile` descriptor.
 */
export async function inspectGgufFile(filePath: string): Promise<ScannedGgufFile> {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const stat = await fs.stat(resolvedPath);
  const metadata = await readGgufHeader(resolvedPath);

  const headerParsed = metadata !== null;
  const effectiveMetadata: GgufHeaderMetadata = metadata ?? { rawKv: {} };

  const shard = parseShardInfo(fileName);
  const role = detectModelRole(fileName, metadata);
  const quantization = detectQuantization(fileName, metadata);
  const family = detectModelFamily(fileName, metadata);
  const modelName = deriveCleanModelName(fileName, role, quantization, metadata);
  const isMoe = role === 'model' ? detectMoeModel(fileName, metadata) : false;

  return {
    filePath: resolvedPath,
    fileName,
    fileSize: stat.size,
    role,
    family,
    modelName,
    quantization,
    isMoe,
    shard,
    headerParsed,
    metadata: effectiveMetadata,
  };
}

