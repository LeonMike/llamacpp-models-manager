import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  CommonPresetConfig,
  DRAFT_DEPENDENT_KEYS,
  DraftDependentKey,
  isValuelessFlag,
  ModelCatalogEntry,
  ModelCombinationSlot,
  ModelPresetSection,
  PresetConfigDocument,
  ScanResult,
  VALUELESS_FLAG_MARKER,
} from '../types/index.js';
import { computeTargetFilePath } from './organizer.js';
import { detectMoeModel } from './gguf-parser.js';

export const KNOWN_COMMON_KEYS = [
  'jinja',
  'device',
  'mmproj-device',
  'split-mode',
  'reasoning',
  'parallel',
  'n-gpu-layers',
  'ctx-size',
  'batch-size',
  'ubatch-size',
  'flash-attn',
  'temp',
  'top-p',
  'top-k',
  'min-p',
  'repeat-penalty',
  'presence-penalty',
  'frequency-penalty',
  'cache-type-k',
  'cache-type-v',
  'chat-template',
  'reasoning-format',
  'system-prompt',
] as const;

export const KNOWN_MODEL_KEYS = [
  'model',
  'mmproj',
  'alias',
  'device',
  'mmproj-device',
  'split-mode',
  'parallel',
  'n-gpu-layers',
  'n-cpu-moe',
  'ctx-size',
  'batch-size',
  'ubatch-size',
  'flash-attn',
  'tensor-split',
  'cache-type-k',
  'cache-type-v',
  'no-mmap',
  'mlock',
  'temp',
  'top-p',
  'top-k',
  'min-p',
  'repeat-penalty',
  'presence-penalty',
  'frequency-penalty',
  'seed',
  'chat-template',
  'jinja',
  'reasoning',
  'reasoning-format',
  'system-prompt',
  'model-draft',
  ...DRAFT_DEPENDENT_KEYS,
] as const;

const KNOWN_COMMON_SET = new Set<string>(KNOWN_COMMON_KEYS);
const KNOWN_MODEL_SET = new Set<string>(KNOWN_MODEL_KEYS);
const DRAFT_DEPENDENT_SET = new Set<string>(DRAFT_DEPENDENT_KEYS);

/**
 * Normalize common CLI alias flags (`ngl` -> `n-gpu-layers`, `c` -> `ctx-size`, etc.)
 */
function normalizeFlagKey(rawKey: string): string {
  const k = rawKey.trim().replace(/^--+/, '');
  switch (k) {
    case 'ngl':
      return 'n-gpu-layers';
    case 'ngld':
      return 'n-gpu-layers-draft';
    case 'c':
      return 'ctx-size';
    case 'b':
      return 'batch-size';
    case 'ub':
      return 'ubatch-size';
    case 'fa':
      return 'flash-attn';
    case 'ctk':
      return 'cache-type-k';
    case 'ctv':
      return 'cache-type-v';
    case 'ctkd':
      return 'cache-type-k-draft';
    case 'ctvd':
      return 'cache-type-v-draft';
    case 'md':
      return 'model-draft';
    case 'sm':
      return 'split-mode';
    case 'np':
      return 'parallel';
    case 'dev':
      return 'device';
    case 'ncmoe':
      return 'n-cpu-moe';
    default:
      return k;
  }
}

export function createEmptyPresetDocument(): PresetConfigDocument {
  return {
    common: {
      jinja: true,
      custom: {},
    },
    models: {},
  };
}

/**
 * Checks whether a model section currently has a non-empty `model-draft` configured.
 */
export function hasModelDraft(section: Pick<ModelPresetSection, 'model-draft'>): boolean {
  return typeof section['model-draft'] === 'string' && section['model-draft'].trim().length > 0;
}

/**
 * Checks whether a model section currently has a non-empty `mmproj` configured.
 */
export function hasMmproj(section: Pick<ModelPresetSection, 'mmproj'>): boolean {
  return typeof section.mmproj === 'string' && section.mmproj.trim().length > 0;
}

/**
 * Parses an INI-formatted `llama serve --models-preset` string into a `PresetConfigDocument`.
 * Supports `[*]` (as well as top-level keys before any section) as the common section.
 * Enforces the rule that draft-dependent keys are only retained if `model-draft` is present.
 */
export function parsePresetIni(content: string): PresetConfigDocument {
  const doc = createEmptyPresetDocument();
  doc.common = { custom: {} }; // Start clean when parsing an existing file

  let currentSection = '*';
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (currentSection !== '*' && !doc.models[currentSection]) {
        doc.models[currentSection] = {
          sectionId: currentSection,
          model: '',
          custom: {},
        };
      }
      continue;
    }

    const eqIdx = line.indexOf('=');
    let rawKey: string;
    let rawVal: string;
    let isValuelessLine = false;
    if (eqIdx === -1) {
      rawKey = line;
      rawVal = 'true';
      isValuelessLine = true;
    } else {
      rawKey = line.slice(0, eqIdx).trim();
      rawVal = stripWrappingQuotes(line.slice(eqIdx + 1).trim());
    }

    const key = normalizeFlagKey(rawKey);
    if (!key) continue;

    if (currentSection === '*') {
      assignCommonProperty(doc.common, key, rawVal, isValuelessLine);
    } else {
      const section = doc.models[currentSection];
      assignModelProperty(section, key, rawVal, isValuelessLine);
    }
  }

  // Enforce conditional rule: strip draft-dependent options from any model lacking `model-draft`
  for (const section of Object.values(doc.models)) {
    sanitizeDraftOptions(section);
  }

  return doc;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTypedScalar(value: string): string | number | boolean {
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  return value;
}

function assignCommonProperty(
  common: CommonPresetConfig,
  key: string,
  value: string,
  isValuelessLine = false
): void {
  if (KNOWN_COMMON_SET.has(key)) {
    (common as unknown as Record<string, unknown>)[key] = parseTypedScalar(value);
  } else {
    common.custom[key] = isValuelessLine ? VALUELESS_FLAG_MARKER : value;
  }
}

function assignModelProperty(
  section: ModelPresetSection,
  key: string,
  value: string,
  isValuelessLine = false
): void {
  if (KNOWN_MODEL_SET.has(key)) {
    if (key === 'model' || key === 'mmproj' || key === 'model-draft' || key === 'alias' || key === 'spec-type') {
      (section as unknown as Record<string, unknown>)[key] = value;
    } else {
      (section as unknown as Record<string, unknown>)[key] = parseTypedScalar(value);
    }
  } else {
    section.custom[key] = isValuelessLine ? VALUELESS_FLAG_MARKER : value;
  }
}

/**
 * Removes draft-dependent keys (`cache-type-k-draft`, `cache-type-v-draft`, `n-gpu-layers-draft`,
 * `spec-draft-n-max`, `spec-draft-p-min`) when `model-draft` is not present on the model section.
 */
export function sanitizeDraftOptions(section: ModelPresetSection): ModelPresetSection {
  if (!hasModelDraft(section)) {
    delete section['model-draft'];
    for (const draftKey of DRAFT_DEPENDENT_KEYS) {
      delete section[draftKey];
      delete section.custom[draftKey];
    }
  }
  return section;
}

/**
 * Serializes a `PresetConfigDocument` into a clean INI string for `llama serve --models-preset`.
 * Always emits `[*]` first for common configurations, followed by each `[<model-id>]` section.
 * Strictly omits draft-related keys when a model has no `model-draft`.
 * Optionally excludes disabled section IDs when exporting to the user's preset file.
 */
export function serializePresetIni(
  doc: PresetConfigDocument,
  options: { excludeDisabled?: boolean } = {}
): string {
  const disabledSet = new Set(options.excludeDisabled ? doc.disabledSectionIds ?? [] : []);
  const lines: string[] = [
    '# Generated by llamacpp-ui-manager',
    '# Usage: llama serve --models-preset <this-file>',
    '',
    '[*]',
  ];

  // 1. Emit common [*] keys
  for (const key of KNOWN_COMMON_KEYS) {
    const val = doc.common[key as keyof CommonPresetConfig];
    if (val !== undefined && val !== '') {
      lines.push(`${key} = ${formatIniValue(val as string | number | boolean)}`);
    }
  }

  for (const [customKey, customVal] of Object.entries(doc.common.custom)) {
    const trimmedKey = customKey.trim();
    if (!trimmedKey || customVal === undefined || customVal === '') {
      continue;
    }
    if (isValuelessFlag(customVal)) {
      lines.push(`${trimmedKey} = true`);
    } else {
      lines.push(`${trimmedKey} = ${formatIniValue(customVal)}`);
    }
  }

  lines.push('');

  // 2. Emit per-model sections
  for (const [sectionKey, rawSection] of Object.entries(doc.models)) {
    const sectionId = rawSection.sectionId || sectionKey;
    if (disabledSet.has(sectionId)) {
      continue;
    }
    const draftActive = hasModelDraft(rawSection);

    lines.push(`[${sectionId}]`);

    for (const key of KNOWN_MODEL_KEYS) {
      // CRITICAL RULE: Skip all draft-related keys if `model-draft` is not configured
      if (!draftActive && (key === 'model-draft' || DRAFT_DEPENDENT_SET.has(key))) {
        continue;
      }

      const val = rawSection[key as keyof ModelPresetSection];
      if (val !== undefined && val !== '') {
        lines.push(`${key} = ${formatIniValue(val as string | number | boolean)}`);
      }
    }

    for (const [customKey, customVal] of Object.entries(rawSection.custom)) {
      const trimmedKey = customKey.trim();
      if (!trimmedKey || customVal === undefined || customVal === '') {
        continue;
      }
      if (!draftActive && (trimmedKey === 'model-draft' || DRAFT_DEPENDENT_SET.has(trimmedKey))) {
        continue;
      }
      if (isValuelessFlag(customVal)) {
        lines.push(`${trimmedKey} = true`);
      } else {
        lines.push(`${trimmedKey} = ${formatIniValue(customVal)}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function formatIniValue(val: string | number | boolean): string {
  if (typeof val === 'boolean' || typeof val === 'number') {
    return String(val);
  }
  const str = String(val);
  // Quote strings that contain spaces or comment characters if not already quoted
  if (/[\s#;]/.test(str) && !str.startsWith('"')) {
    return `"${str}"`;
  }
  return str;
}

/**
 * Builds a catalog of all scanned quantized base models along with their available
 * paired `mmproj` (vision) and `mtp` (`model-draft`) files.
 */
export function buildModelCatalog(
  scanResult: ScanResult,
  options: { useOrganizedPaths?: boolean } = {}
): ModelCatalogEntry[] {
  const useOrganized = options.useOrganizedPaths ?? false;
  const entries: ModelCatalogEntry[] = [];

  for (const group of scanResult.groups) {
    const primaryMmproj = group.mmprojFiles[0];
    const primaryMtp = group.mtpFiles[0];

    const primaryMmprojPath = primaryMmproj
      ? useOrganized
        ? computeTargetFilePath(
          scanResult.rootDir,
          group.family,
          group.modelName,
          primaryMmproj.fileName
        )
        : primaryMmproj.filePath
      : undefined;

    const primaryMtpPath = primaryMtp
      ? useOrganized
        ? computeTargetFilePath(
          scanResult.rootDir,
          group.family,
          group.modelName,
          primaryMtp.fileName
        )
        : primaryMtp.filePath
      : undefined;

    for (const variant of group.variants) {
      const modelPath = useOrganized
        ? computeTargetFilePath(
          scanResult.rootDir,
          group.family,
          group.modelName,
          variant.primaryFile.fileName,
          variant.quantization
        )
        : variant.primaryFile.filePath;

      const isMoe =
        variant.primaryFile.isMoe ??
        detectMoeModel(variant.primaryFile.fileName, variant.primaryFile.metadata);

      entries.push({
        variantId: variant.id,
        family: group.family,
        modelName: group.modelName,
        quantization: variant.quantization,
        modelPath,
        isMoe,
        availableMmprojFiles: group.mmprojFiles,
        availableMtpFiles: group.mtpFiles,
        primaryMmprojPath,
        primaryMtpPath,
      });
    }
  }

  return entries;
}

/**
 * Returns all valid combination slots (mixtures of Base Model, Vision `mmproj`, and Draft `mtp`)
 * that can be enabled/disabled for a given `ModelCatalogEntry`.
 */
export function getAvailableCombinationSlots(entry: ModelCatalogEntry): ModelCombinationSlot[] {
  const hasVision = Boolean(entry.primaryMmprojPath);
  const hasDraft = Boolean(entry.primaryMtpPath);

  const slots: ModelCombinationSlot[] = [
    {
      key: 'base',
      label: 'Base Model Only (Text-only, no MTP)',
      shortBadge: 'base',
      useMmproj: false,
      useMtp: false,
      defaultSectionId:
        hasVision || hasDraft ? `${entry.variantId}-base` : entry.variantId,
    },
  ];

  if (hasVision) {
    slots.push({
      key: 'vision',
      label: 'Base Model + Vision (mmproj)',
      shortBadge: '+mmproj',
      useMmproj: true,
      useMtp: false,
      defaultSectionId: hasDraft ? `${entry.variantId}-vision` : entry.variantId,
      mmprojPath: entry.primaryMmprojPath,
    });
  }

  if (hasDraft) {
    slots.push({
      key: 'mtp',
      label: 'Base Model + MTP (model-draft)',
      shortBadge: '+mtp',
      useMmproj: false,
      useMtp: true,
      defaultSectionId: hasVision ? `${entry.variantId}-mtp` : entry.variantId,
      mtpPath: entry.primaryMtpPath,
    });
  }

  if (hasVision && hasDraft) {
    slots.push({
      key: 'vision+mtp',
      label: 'Base Model + Vision (mmproj) + MTP (model-draft)',
      shortBadge: '+mmproj+mtp',
      useMmproj: true,
      useMtp: true,
      defaultSectionId: entry.variantId,
      mmprojPath: entry.primaryMmprojPath,
      mtpPath: entry.primaryMtpPath,
    });
  }

  return slots;
}

/**
 * Determines which combination key (`'base' | 'vision' | 'mtp' | 'vision+mtp'`) a `ModelPresetSection` represents.
 */
export function getSectionCombinationKey(
  section: Pick<ModelPresetSection, 'mmproj' | 'model-draft'>
): 'base' | 'vision' | 'mtp' | 'vision+mtp' {
  const v = hasMmproj(section);
  const d = hasModelDraft(section);
  if (v && d) return 'vision+mtp';
  if (v) return 'vision';
  if (d) return 'mtp';
  return 'base';
}

/**
 * Finds all `ModelPresetSection` entries in `doc.models` that belong to a given `ModelCatalogEntry`
 * (matched by model file basename or variantId prefix).
 */
export function getSectionsForCatalogEntry(
  entry: ModelCatalogEntry,
  models: Record<string, ModelPresetSection>
): ModelPresetSection[] {
  const targetBasename = path.basename(entry.modelPath).toLowerCase();
  const matched: ModelPresetSection[] = [];

  for (const sec of Object.values(models)) {
    const secBasename = sec.model ? path.basename(sec.model).toLowerCase() : '';
    if (
      secBasename === targetBasename ||
      sec.sectionId.toLowerCase() === entry.variantId.toLowerCase() ||
      sec.sectionId.toLowerCase().startsWith(`${entry.variantId.toLowerCase()}-`)
    ) {
      matched.push(sec);
    }
  }

  return matched;
}

/**
 * Creates a new `ModelPresetSection` for a specific combination slot (`base`, `vision`, `mtp`, or `vision+mtp`)
 * or custom configuration of a `ModelCatalogEntry`.
 */
export function createSectionForSlot(
  entry: ModelCatalogEntry,
  slot: ModelCombinationSlot,
  existingModels: Record<string, ModelPresetSection>,
  customSectionId?: string,
  templateSection?: ModelPresetSection
): ModelPresetSection {
  let sectionId = customSectionId?.trim() || slot.defaultSectionId;
  // Ensure sectionId is unique if another section already uses it
  if (existingModels[sectionId]) {
    let suffix = `${entry.variantId}-${slot.key}`;
    let counter = 2;
    while (existingModels[suffix]) {
      suffix = `${entry.variantId}-${slot.key}-${counter++}`;
    }
    sectionId = suffix;
  }

  const baseSection: ModelPresetSection = templateSection
    ? {
      ...templateSection,
      sectionId,
      model: entry.modelPath,
      custom: { ...templateSection.custom },
    }
    : {
      sectionId,
      model: entry.modelPath,
      custom: {},
    };

  if (slot.useMmproj && (slot.mmprojPath || entry.primaryMmprojPath)) {
    baseSection.mmproj = slot.mmprojPath ?? entry.primaryMmprojPath;
  } else {
    delete baseSection.mmproj;
  }

  if (slot.useMtp && (slot.mtpPath || entry.primaryMtpPath)) {
    baseSection['model-draft'] = slot.mtpPath ?? entry.primaryMtpPath;
    if (baseSection['spec-type'] === undefined) {
      baseSection['spec-type'] = 'draft-mtp';
    }
  } else {
    delete baseSection['model-draft'];
  }

  return sanitizeDraftOptions(baseSection);
}

/**
 * Synchronizes a `ScanResult` with an existing (or newly created) `PresetConfigDocument`.
 * - Preserves ALL existing user-defined configurations for each model (e.g. Base, +Vision, +MTP, +Vision+MTP),
 *   updating their `model`, `mmproj`, and `model-draft` paths if files were organized.
 * - If a scanned model has no existing section yet, creates its default full-featured section.
 */
export function syncPresetWithScan(
  scanResult: ScanResult,
  existingDoc?: PresetConfigDocument,
  options: { useOrganizedPaths?: boolean } = {}
): PresetConfigDocument {
  const baseDoc = existingDoc
    ? {
      common: { ...existingDoc.common, custom: { ...existingDoc.common.custom } },
      models: { ...existingDoc.models },
    }
    : createEmptyPresetDocument();

  const catalog = buildModelCatalog(scanResult, options);

  // Group all existing sections by normalized model filename so multiple configurations of the same model are preserved!
  const existingByFile = new Map<string, ModelPresetSection[]>();
  for (const sec of Object.values(baseDoc.models)) {
    if (sec.model) {
      const key = path.basename(sec.model).toLowerCase();
      const list = existingByFile.get(key) ?? [];
      list.push(sec);
      existingByFile.set(key, list);
    }
  }

  const updatedModels: Record<string, ModelPresetSection> = {};

  for (const entry of catalog) {
    const fileKey = path.basename(entry.modelPath).toLowerCase();
    const priorList = existingByFile.get(fileKey) ?? [];

    // Also check if there was a section keyed by `entry.variantId` without a matching basename
    if (priorList.length === 0 && baseDoc.models[entry.variantId]) {
      priorList.push(baseDoc.models[entry.variantId]);
    }

    if (priorList.length > 0) {
      // Preserve every configuration the user created for this model, updating file paths if organized
      for (const prior of priorList) {
        const merged: ModelPresetSection = {
          ...prior,
          model: entry.modelPath,
          custom: { ...prior.custom },
        };

        // If this configuration had mmproj enabled, update it to the organized mmproj path if same file
        if (hasMmproj(prior) && entry.primaryMmprojPath) {
          merged.mmproj = entry.primaryMmprojPath;
        }
        // If this configuration had model-draft enabled, update it to the organized mtp path if same file
        if (hasModelDraft(prior) && entry.primaryMtpPath) {
          merged['model-draft'] = entry.primaryMtpPath;
        }

        sanitizeDraftOptions(merged);
        updatedModels[merged.sectionId] = merged;
      }
    } else {
      // No existing configuration for this model yet: create default section with available mmproj & mtp
      const defaultSec: ModelPresetSection = {
        sectionId: entry.variantId,
        model: entry.modelPath,
        custom: {},
      };
      if (entry.primaryMmprojPath) {
        defaultSec.mmproj = entry.primaryMmprojPath;
      }
      if (entry.primaryMtpPath) {
        defaultSec['model-draft'] = entry.primaryMtpPath;
        defaultSec['spec-type'] = 'draft-mtp';
      }
      sanitizeDraftOptions(defaultSec);
      updatedModels[defaultSec.sectionId] = defaultSec;
    }
  }

  return {
    common: baseDoc.common,
    models: updatedModels,
    disabledSectionIds: baseDoc.disabledSectionIds ? [...baseDoc.disabledSectionIds] : undefined,
  };
}

/**
 * Loads a preset INI file from disk if it exists, or returns a default document.
 */
export async function loadPresetFile(filePath: string): Promise<PresetConfigDocument> {
  try {
    const content = await fs.readFile(path.resolve(filePath), 'utf8');
    return parsePresetIni(content);
  } catch {
    return createEmptyPresetDocument();
  }
}

/**
 * Writes a `PresetConfigDocument` to disk as an INI file.
 * By default, excludes disabled sections when saving the user's exported preset file.
 */
export async function savePresetFile(
  filePath: string,
  doc: PresetConfigDocument,
  options: { excludeDisabled?: boolean } = { excludeDisabled: true }
): Promise<void> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const serialized = serializePresetIni(doc, options);
  await fs.writeFile(resolved, serialized, 'utf8');
}

/**
 * Saves all available models and their configurations to `.all_configs_available.ini`
 * inside the models root directory, including all sections regardless of enabled/disabled state.
 */
export async function saveAllConfigsAvailableFile(
  modelsDir: string,
  doc: PresetConfigDocument
): Promise<string> {
  const allConfigsPath = getAllConfigsFilePath(modelsDir);
  await fs.mkdir(path.dirname(allConfigsPath), { recursive: true });
  // Always include all sections in .all_configs_available.ini
  const serialized = serializePresetIni(doc, { excludeDisabled: false });
  await fs.writeFile(allConfigsPath, serialized, 'utf8');
  return allConfigsPath;
}

export const ALL_CONFIGS_AVAILABLE_FILENAME = '.all_configs_available.ini';

export function getAllConfigsFilePath(modelsDir: string): string {
  return path.join(path.resolve(modelsDir), ALL_CONFIGS_AVAILABLE_FILENAME);
}

/**
 * Loads `.all_configs_available.ini` from the models root directory if it exists,
 * or returns an empty `PresetConfigDocument`.
 */
export async function loadAllConfigsAvailableFile(modelsDir: string): Promise<PresetConfigDocument> {
  return loadPresetFile(getAllConfigsFilePath(modelsDir));
}

/**
 * Merges `.all_configs_available.ini` (which holds all configured models, including disabled ones)
 * with the currently exported preset file (`<presetPath>`), giving precedence to `exportedDoc`
 * for any sections or common keys present in both.
 */
export function mergePresetWithAllConfigs(
  allConfigsDoc: PresetConfigDocument,
  exportedDoc: PresetConfigDocument
): PresetConfigDocument {
  return {
    common: {
      ...allConfigsDoc.common,
      ...exportedDoc.common,
      custom: {
        ...allConfigsDoc.common.custom,
        ...exportedDoc.common.custom,
      },
    },
    models: {
      ...allConfigsDoc.models,
      ...exportedDoc.models,
    },
  };
}

/**
 * Computes initial `disabledSectionIds` by comparing the synced document against
 * `.all_configs_available.ini` and the currently exported preset file:
 * - Already in `exportedDoc`: enabled (`[✓]`)
 * - Known in `allConfigsDoc` but absent from `exportedDoc`: disabled (`[✗]`)
 * - Newly discovered (not in `allConfigsDoc` and not in `exportedDoc`): enabled for next save (`[+]`)
 */
export function computeInitialDisabledSectionIds(
  syncedDoc: PresetConfigDocument,
  allConfigsDoc: PresetConfigDocument,
  exportedDoc: PresetConfigDocument
): string[] {
  const exportedIds = new Set(Object.keys(exportedDoc.models));
  const knownIds = new Set(Object.keys(allConfigsDoc.models));
  const disabled: string[] = [];

  for (const sectionId of Object.keys(syncedDoc.models)) {
    if (!exportedIds.has(sectionId) && knownIds.has(sectionId)) {
      disabled.push(sectionId);
    }
  }

  return disabled;
}

/**
 * Renames a model/configuration section (`oldSectionId` -> `updatedSection.sectionId`)
 * inside a `PresetConfigDocument` while preserving section order and updating
 * `disabledSectionIds` if the section was disabled.
 */
export function renameModelSectionInDocument(
  doc: PresetConfigDocument,
  oldSectionId: string,
  updatedSection: ModelPresetSection
): { doc: PresetConfigDocument; renamed: boolean; reason?: string } {
  const newSectionId = updatedSection.sectionId.replace(/[\[\]]/g, '').trim();
  if (!newSectionId) {
    return { doc, renamed: false, reason: 'Section name cannot be empty.' };
  }
  if (!(oldSectionId in doc.models)) {
    return { doc, renamed: false, reason: `Section [${oldSectionId}] does not exist.` };
  }
  if (newSectionId === oldSectionId) {
    return {
      doc: {
        ...doc,
        models: {
          ...doc.models,
          [oldSectionId]: { ...updatedSection, sectionId: oldSectionId },
        },
      },
      renamed: false,
    };
  }
  if (newSectionId in doc.models) {
    return {
      doc,
      renamed: false,
      reason: `Section [${newSectionId}] already exists.`,
    };
  }

  const nextModels: Record<string, ModelPresetSection> = {};
  for (const [key, value] of Object.entries(doc.models)) {
    if (key === oldSectionId) {
      nextModels[newSectionId] = { ...updatedSection, sectionId: newSectionId };
    } else {
      nextModels[key] = value;
    }
  }

  const nextDisabled = doc.disabledSectionIds
    ? doc.disabledSectionIds.map((id) => (id === oldSectionId ? newSectionId : id))
    : undefined;

  return {
    doc: {
      ...doc,
      models: nextModels,
      disabledSectionIds: nextDisabled,
    },
    renamed: true,
  };
}
