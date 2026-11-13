export type GgufModelRole = 'model' | 'mmproj' | 'mtp';

export interface ShardInfo {
  index: number;      // 1-based shard index (e.g., 1 in 00001-of-00003)
  total: number;      // Total shards (e.g., 3)
  baseFilename: string; // Filename without the -00001-of-00003 suffix
}

export interface GgufHeaderMetadata {
  version?: number;
  tensorCount?: bigint;
  kvCount?: bigint;
  architecture?: string;
  name?: string;
  basename?: string;
  finetune?: string;
  sizeLabel?: string;
  fileType?: number;
  quantizationVersion?: number;
  expertCount?: number;
  expertUsedCount?: number;
  rawKv: Record<string, string | number | boolean | bigint>;
}

export interface ScannedGgufFile {
  filePath: string;
  fileName: string;
  fileSize: number;
  role: GgufModelRole;
  family: string;       // e.g., 'llama', 'qwen2', 'gemma3'
  modelName: string;    // Normalized model base name, e.g., 'Qwen2.5-VL-7B-Instruct'
  quantization: string; // Normalized quant label, e.g., 'Q4_K_M', 'BF16', 'F16'
  isMoe?: boolean;      // True if Mixture-of-Experts (MoE) model
  shard?: ShardInfo;
  headerParsed: boolean;
  metadata: GgufHeaderMetadata;
}

export interface QuantizedModelVariant {
  id: string;                   // Unique preset section identifier, e.g., 'Qwen2.5-VL-7B-Instruct-Q4_K_M'
  family: string;
  modelName: string;
  quantization: string;
  primaryFile: ScannedGgufFile; // Shard 1 (or the single file) used as `model = ...`
  allShardFiles: ScannedGgufFile[]; // All shards belonging to this quantization variant
}

export interface ModelGroup {
  family: string;
  modelName: string;
  variants: QuantizedModelVariant[];
  mmprojFiles: ScannedGgufFile[]; // Paired multimodal projector files (shared at modelName level)
  mtpFiles: ScannedGgufFile[];    // Paired draft / MTP files (shared at modelName level)
}

export interface ScanResult {
  rootDir: string;
  files: ScannedGgufFile[];
  groups: ModelGroup[];
  orphanAuxFiles: ScannedGgufFile[]; // mmproj or mtp files that couldn't be confidently paired
}

export type MoveActionStatus = 'pending' | 'already-organized' | 'conflict' | 'moved' | 'error';

export interface FileMoveOperation {
  sourcePath: string;
  destinationPath: string;
  role: GgufModelRole;
  family: string;
  modelName: string;
  quantization?: string;
  status: MoveActionStatus;
  errorMessage?: string;
}

export interface OrganizationPlan {
  rootDir: string;
  operations: FileMoveOperation[];
  orphanFiles: ScannedGgufFile[];
  conflicts: FileMoveOperation[];
}

export interface OrganizationResult {
  movedCount: number;
  skippedCount: number;
  removedDirsCount: number;
  errors: Array<{ operation: FileMoveOperation; error: string }>;
}

/**
 * Sentinel value stored in `custom[key]` when a custom flag is a valueless toggle/switch
 * that is passed straight-forward (e.g., `--no-webui` or `no-mmap` without `= value`).
 */
export const VALUELESS_FLAG_MARKER = '__TOGGLE_FLAG__';

/**
 * Checks whether a custom flag value represents a valueless toggle flag.
 */
export function isValuelessFlag(val: unknown): boolean {
  if (val === VALUELESS_FLAG_MARKER || val === true) return true;
  if (typeof val === 'string' && val.toLowerCase() === 'true') return true;
  return false;
}

/**
 * Draft-specific keys that are ONLY valid when `model-draft` is present.
 */
export const DRAFT_DEPENDENT_KEYS = [
  'cache-type-k-draft',
  'cache-type-v-draft',
  'n-gpu-layers-draft',
  'spec-draft-n-max',
  'spec-draft-p-min',
  'spec-type',
] as const;

export type DraftDependentKey = (typeof DRAFT_DEPENDENT_KEYS)[number];

/**
 * Well-known configuration keys for [*] common section and per-model sections.
 */
export interface CommonPresetConfig {
  jinja?: boolean | string;
  device?: string;
  'split-mode'?: string;
  reasoning?: string;
  parallel?: number | string;
  'n-gpu-layers'?: number | string;
  'ctx-size'?: number | string;
  'batch-size'?: number | string;
  'ubatch-size'?: number | string;
  'flash-attn'?: boolean | string;
  temp?: number | string;
  'top-p'?: number | string;
  'top-k'?: number | string;
  'min-p'?: number | string;
  'repeat-penalty'?: number | string;
  'presence-penalty'?: number | string;
  'frequency-penalty'?: number | string;
  'cache-type-k'?: string;
  'cache-type-v'?: string;
  'chat-template'?: string;
  'reasoning-format'?: string;
  'system-prompt'?: string;
  custom: Record<string, string>;
}

export interface ModelPresetSection {
  sectionId: string; // [<sectionId>]
  model: string;
  mmproj?: string;
  alias?: string;

  // Hardware & Memory
  device?: string;
  'split-mode'?: string;
  parallel?: number | string;
  'n-gpu-layers'?: number | string;
  'n-cpu-moe'?: number | string;
  'ctx-size'?: number | string;
  'batch-size'?: number | string;
  'ubatch-size'?: number | string;
  'flash-attn'?: boolean | string;
  'tensor-split'?: string;
  'cache-type-k'?: string;
  'cache-type-v'?: string;
  'no-mmap'?: boolean | string;
  mlock?: boolean | string;

  // Sampling & Generation
  temp?: number | string;
  'top-p'?: number | string;
  'top-k'?: number | string;
  'min-p'?: number | string;
  'repeat-penalty'?: number | string;
  'presence-penalty'?: number | string;
  'frequency-penalty'?: number | string;
  seed?: number | string;

  // Chat & Templates
  'chat-template'?: string;
  jinja?: boolean | string;
  reasoning?: string;
  'reasoning-format'?: string;
  'system-prompt'?: string;

  // Draft / MTP (Conditional: draft options only emitted if `model-draft` is set)
  'model-draft'?: string;
  'cache-type-k-draft'?: string;
  'cache-type-v-draft'?: string;
  'n-gpu-layers-draft'?: number | string;
  'spec-draft-n-max'?: number | string;
  'spec-draft-p-min'?: number | string;
  'spec-type'?: string;

  // Arbitrary custom key-value flags
  custom: Record<string, string>;
}

export interface PresetConfigDocument {
  common: CommonPresetConfig;
  models: Record<string, ModelPresetSection>;
  disabledSectionIds?: string[];
}

/**
 * Represents a possible combination of a base quantized model with/without Vision (`mmproj`)
 * and with/without Speculative Draft / MTP (`model-draft`).
 */
export interface ModelCombinationSlot {
  key: 'base' | 'vision' | 'mtp' | 'vision+mtp';
  label: string;
  shortBadge: string;
  useMmproj: boolean;
  useMtp: boolean;
  defaultSectionId: string;
  mmprojPath?: string;
  mtpPath?: string;
}

/**
 * Summarizes a scanned base quantized model variant and all its available/active
 * preset configurations (e.g., Base only, +Vision, +MTP, +Vision+MTP, or custom profiles).
 */
export interface ModelCatalogEntry {
  variantId: string;
  family: string;
  modelName: string;
  quantization: string;
  modelPath: string;
  isMoe?: boolean;
  availableMmprojFiles: ScannedGgufFile[];
  availableMtpFiles: ScannedGgufFile[];
  primaryMmprojPath?: string;
  primaryMtpPath?: string;
}

export type ModelDetailVisibilityMode = 'names-only' | 'names-and-configs' | 'full';

export interface ModelListHotkeys {
  cycleDetailMode: string;
  toggleExport: string;
  expandAll: string;
  mixProfiles: string;
  testModel: string;
  testAll: string;
  testChild: string;
  deleteSection: string;
  filter: string;
  edit: string;
}

/**
 * Application-level settings for testing model configurations with `llama cli`
 * and UI display/hotkey preferences.
 */
export interface AppTestSettings {
  /**
   * Command to execute (default: `"llama cli"`).
   * May optionally include `{PROMPT}` placeholder; otherwise `-p <defaultPrompt>` is appended.
   */
  testCommand: string;
  /**
   * Default prompt used when testing a model configuration (default: `"why is the sky blue?"`).
   */
  defaultPrompt: string;
  /**
   * Maximum tokens to generate during a quick configuration test so the response finishes quickly (default: `64`).
   */
  maxPredictTokens: number;
  /**
   * Timeout in seconds before aborting the test process (default: `120`).
   */
  timeoutSeconds: number;
  /**
   * Command to execute when starting the server (default: `"llama serve"`).
   */
  serveCommand?: string;
  /**
   * Visibility mode for model header details in Models Config view.
   */
  modelDetailVisibility?: ModelDetailVisibilityMode;
  /**
   * Configurable hotkeys for the Models Config view.
   */
  hotkeys?: Partial<ModelListHotkeys>;
}

export interface ModelTestRunResult {
  success: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid?: number;
  commandLine: string;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  durationMs: number;
  avgTokensPerSec?: number;
  abortedByUser?: boolean;
  timedOut?: boolean;
}

export type TestStatusState = 'untested' | 'running' | 'passed' | 'failed';

export interface SectionTestStatus {
  status: TestStatusState;
  avgTokensPerSec?: number;
  previousAvgTokensPerSec?: number;
  lastResult?: ModelTestRunResult;
  updatedAt?: number;
}


