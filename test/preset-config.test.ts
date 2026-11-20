import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_CONFIGS_AVAILABLE_FILENAME,
  buildModelCatalog,
  computeInitialDisabledSectionIds,
  createEmptyPresetDocument,
  createSectionForSlot,
  getAllConfigsFilePath,
  getAvailableCombinationSlots,
  getSectionCombinationKey,
  getSectionsForCatalogEntry,
  loadAllConfigsAvailableFile,
  loadPresetFile,
  mergePresetWithAllConfigs,
  parsePresetIni,
  renameModelSectionInDocument,
  sanitizeDraftOptions,
  saveAllConfigsAvailableFile,
  savePresetFile,
  serializePresetIni,
  syncPresetWithScan,
} from '../src/core/preset-config.js';
import {
  isValuelessFlag,
  ModelPresetSection,
  PresetConfigDocument,
  ScanResult,
  VALUELESS_FLAG_MARKER,
} from '../src/types/index.js';
import { getInheritedValueFromCommon } from '../src/ui/components/ModelEditorView.js';
import {
  getModelHeaderExportBadge,
  getSectionExportBadge,
} from '../src/ui/components/ModelListView.js';

describe('preset-config INI parser & serializer', () => {
  it('emits [*] for common configuration and includes draft options ONLY when model-draft is present', () => {
    const doc: PresetConfigDocument = {
      common: {
        jinja: true,
        device: 'CUDA0,CUDA1',
        'split-mode': 'layer',
        'mmproj-device': 'CUDA0',
        reasoning: 'auto',
        parallel: 4,
        'top-p': 0.95,
        'top-k': 40,
        temp: 0.7,
        'flash-attn': true,
        custom: {
          'cont-batching': 'true',
        },
      },
      models: {
        'Qwen2.5-VL-7B-Instruct-Q4_K_M': {
          sectionId: 'Qwen2.5-VL-7B-Instruct-Q4_K_M',
          model: '/models/qwen2/Qwen2.5-VL-7B-Instruct/Q4_K_M/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf',
          mmproj: '/models/qwen2/Qwen2.5-VL-7B-Instruct/mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf',
          'model-draft': '/models/qwen2/Qwen2.5-VL-7B-Instruct/Qwen2.5-VL-7B-Instruct-mtp.gguf',
          'n-gpu-layers': 99,
          'ctx-size': 16384,
          'cache-type-k-draft': 'q8_0',
          'cache-type-v-draft': 'q8_0',
          'n-gpu-layers-draft': 99,
          'spec-draft-device': 'CUDA0',
          'spec-draft-n-max': 16,
          'spec-draft-p-min': 0.75,
          'spec-type': 'draft-mtp',
          custom: {
            'no-webui': 'false',
          },
        },
        'Llama-3.1-8B-Instruct-Q8_0': {
          sectionId: 'Llama-3.1-8B-Instruct-Q8_0',
          model: '/models/llama/Llama-3.1-8B-Instruct/Q8_0/Llama-3.1-8B-Instruct-Q8_0.gguf',
          'n-gpu-layers': 99,
          // Even if draft properties are accidentally populated in memory, without `model-draft` they MUST NOT be emitted!
          'cache-type-k-draft': 'q4_0',
          'cache-type-v-draft': 'q4_0',
          'n-gpu-layers-draft': 32,
          'spec-draft-device': 'CUDA1',
          'spec-draft-n-max': 8,
          'spec-draft-p-min': 0.8,
          custom: {},
        },
      },
    };

    const ini = serializePresetIni(doc);

    // 1. Verify [*] header and common settings
    expect(ini).toContain('[*]');
    expect(ini).toContain('jinja = true');
    expect(ini).toContain('device = CUDA0,CUDA1');
    expect(ini).toContain('mmproj-device = CUDA0');
    expect(ini).toContain('split-mode = layer');
    expect(ini).toContain('reasoning = auto');
    expect(ini).toContain('parallel = 4');
    expect(ini).toContain('top-p = 0.95');
    expect(ini).toContain('top-k = 40');
    expect(ini).toContain('cont-batching = true');

    // 2. Verify Qwen section (which has `model-draft`) contains all draft options
    const qwenBlock = ini.split('[Llama-3.1-8B-Instruct-Q8_0]')[0];
    expect(qwenBlock).toContain('[Qwen2.5-VL-7B-Instruct-Q4_K_M]');
    expect(qwenBlock).toContain(
      'model-draft = /models/qwen2/Qwen2.5-VL-7B-Instruct/Qwen2.5-VL-7B-Instruct-mtp.gguf'
    );
    expect(qwenBlock).toContain('cache-type-k-draft = q8_0');
    expect(qwenBlock).toContain('cache-type-v-draft = q8_0');
    expect(qwenBlock).toContain('n-gpu-layers-draft = 99');
    expect(qwenBlock).toContain('spec-draft-device = CUDA0');
    expect(qwenBlock).toContain('spec-draft-n-max = 16');
    expect(qwenBlock).toContain('spec-draft-p-min = 0.75');
    expect(qwenBlock).toContain('spec-type = draft-mtp');

    // 3. Verify Llama section (which has NO `model-draft`) omits all draft options
    const llamaBlock = ini.split('[Llama-3.1-8B-Instruct-Q8_0]')[1];
    expect(llamaBlock).toBeDefined();
    expect(llamaBlock).not.toContain('model-draft');
    expect(llamaBlock).not.toContain('cache-type-k-draft');
    expect(llamaBlock).not.toContain('cache-type-v-draft');
    expect(llamaBlock).not.toContain('n-gpu-layers-draft');
    expect(llamaBlock).not.toContain('spec-draft-device');
    expect(llamaBlock).not.toContain('spec-draft-n-max');
    expect(llamaBlock).not.toContain('spec-draft-p-min');
    expect(llamaBlock).not.toContain('spec-type');
  });

  it('round-trips INI files and strips orphan draft options when parsing a model without model-draft', () => {
    const rawIni = `
[*]
jinja = true
top-p = 0.9
top-k = 50
custom-global = "hello world"

[Model-With-Draft]
model = /path/to/main.gguf
model-draft = /path/to/draft.gguf
cache-type-k-draft = f16
cache-type-v-draft = f16
n-gpu-layers-draft = 99
spec-draft-n-max = 12
spec-draft-p-min = 0.6
spec-type = draft-mtp

[Model-Without-Draft]
model = /path/to/other.gguf
cache-type-k-draft = f16
spec-draft-n-max = 12
spec-type = draft-mtp
`;

    const parsed = parsePresetIni(rawIni);

    expect(parsed.common.jinja).toBe(true);
    expect(parsed.common['top-p']).toBe(0.9);
    expect(parsed.common['top-k']).toBe(50);
    expect(parsed.common.custom['custom-global']).toBe('hello world');

    const withDraft = parsed.models['Model-With-Draft'];
    expect(withDraft['model-draft']).toBe('/path/to/draft.gguf');
    expect(withDraft['cache-type-k-draft']).toBe('f16');
    expect(withDraft['cache-type-v-draft']).toBe('f16');
    expect(withDraft['n-gpu-layers-draft']).toBe(99);
    expect(withDraft['spec-draft-n-max']).toBe(12);
    expect(withDraft['spec-draft-p-min']).toBe(0.6);
    expect(withDraft['spec-type']).toBe('draft-mtp');

    const withoutDraft = parsed.models['Model-Without-Draft'];
    expect(withoutDraft['model-draft']).toBeUndefined();
    expect(withoutDraft['cache-type-k-draft']).toBeUndefined();
    expect(withoutDraft['spec-draft-n-max']).toBeUndefined();
    expect(withoutDraft['spec-type']).toBeUndefined();

    // Removing model-draft and calling sanitizeDraftOptions clears all draft fields
    const copy: ModelPresetSection = { ...withDraft, 'model-draft': '' };
    sanitizeDraftOptions(copy);
    expect(copy['model-draft']).toBeUndefined();
    expect(copy['cache-type-k-draft']).toBeUndefined();
    expect(copy['spec-draft-n-max']).toBeUndefined();
    expect(copy['spec-type']).toBeUndefined();
  });

  it('supports multiple mixture configurations (base, +mmproj, +mtp, +mmproj+mtp) for a single base model and preserves them across scans', () => {
    const mockScan: ScanResult = {
      rootDir: '/models',
      files: [],
      orphanAuxFiles: [],
      groups: [
        {
          family: 'qwen2',
          modelName: 'Qwen2.5-VL-7B-Instruct',
          variants: [
            {
              id: 'Qwen2.5-VL-7B-Instruct-Q4_K_M',
              family: 'qwen2',
              modelName: 'Qwen2.5-VL-7B-Instruct',
              quantization: 'Q4_K_M',
              primaryFile: {
                filePath: '/models/qwen2/Qwen2.5-VL-7B-Instruct/Q4_K_M/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf',
                fileName: 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf',
                fileSize: 1024,
                role: 'model',
                family: 'qwen2',
                modelName: 'Qwen2.5-VL-7B-Instruct',
                quantization: 'Q4_K_M',
                headerParsed: true,
                metadata: { rawKv: {} },
              },
              allShardFiles: [],
            },
          ],
          mmprojFiles: [
            {
              filePath: '/models/qwen2/Qwen2.5-VL-7B-Instruct/mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf',
              fileName: 'mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf',
              fileSize: 512,
              role: 'mmproj',
              family: 'qwen2',
              modelName: 'Qwen2.5-VL-7B-Instruct',
              quantization: 'F16',
              headerParsed: true,
              metadata: { rawKv: {} },
            },
          ],
          mtpFiles: [
            {
              filePath: '/models/qwen2/Qwen2.5-VL-7B-Instruct/Qwen2.5-VL-7B-Instruct-mtp-Q8_0.gguf',
              fileName: 'Qwen2.5-VL-7B-Instruct-mtp-Q8_0.gguf',
              fileSize: 512,
              role: 'mtp',
              family: 'qwen2',
              modelName: 'Qwen2.5-VL-7B-Instruct',
              quantization: 'Q8_0',
              headerParsed: true,
              metadata: { rawKv: {} },
            },
          ],
        },
      ],
    };

    const catalog = buildModelCatalog(mockScan);
    expect(catalog).toHaveLength(1);
    const entry = catalog[0];

    // Should expose 4 combination slots: base, vision, mtp, vision+mtp
    const slots = getAvailableCombinationSlots(entry);
    expect(slots.map((s) => s.key)).toEqual(['base', 'vision', 'mtp', 'vision+mtp']);

    // Start with default synced doc (which creates the full vision+mtp section)
    const doc = syncPresetWithScan(mockScan);
    expect(Object.keys(doc.models)).toEqual(['Qwen2.5-VL-7B-Instruct-Q4_K_M']);

    // Enable the 'base' (no mmproj, no mtp), 'vision' (+mmproj only), and 'mtp' (+mtp only) slots for the same model
    for (const slot of slots) {
      if (slot.key === 'vision+mtp') continue;
      const newSec = createSectionForSlot(entry, slot, doc.models);
      doc.models[newSec.sectionId] = newSec;
    }

    // Configure distinct settings on each mixture
    doc.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-base']['ctx-size'] = 32768;
    doc.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-mtp']['spec-draft-n-max'] = 16;

    const entrySections = getSectionsForCatalogEntry(entry, doc.models);
    expect(entrySections).toHaveLength(4);
    expect(entrySections.map((s) => getSectionCombinationKey(s)).sort()).toEqual(
      ['base', 'mtp', 'vision', 'vision+mtp'].sort()
    );

    // Rescanning must preserve all 4 configurations of the same model!
    const resynced = syncPresetWithScan(mockScan, doc);
    expect(Object.keys(resynced.models)).toHaveLength(4);
    expect(resynced.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-base']['ctx-size']).toBe(32768);
    expect(resynced.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-base'].mmproj).toBeUndefined();
    expect(resynced.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-base']['model-draft']).toBeUndefined();
    expect(resynced.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-mtp']['spec-draft-n-max']).toBe(16);
    expect(resynced.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-mtp']['spec-type']).toBe('draft-mtp');
    expect(resynced.models['Qwen2.5-VL-7B-Instruct-Q4_K_M-mtp'].mmproj).toBeUndefined();
  });

  it('exports toggle flags as "FLAG = true" in [*] and [model] sections while preserving valueless toggle state in memory', () => {
    const doc: PresetConfigDocument = {
      common: {
        jinja: true,
        custom: {
          'no-warmup': VALUELESS_FLAG_MARKER,
          'custom-kv': 'some-value',
        },
      },
      models: {
        'Qwen3-8B-Q4_K_M': {
          sectionId: 'Qwen3-8B-Q4_K_M',
          model: '/models/qwen3/Qwen3-8B/Q4_K_M/Qwen3-8B-Q4_K_M.gguf',
          custom: {
            'no-webui': VALUELESS_FLAG_MARKER,
            'special-toggle': VALUELESS_FLAG_MARKER,
            'override-kv': 'foo=bar',
          },
        },
      },
    };

    const ini = serializePresetIni(doc);
    const lines = ini.split(/\r?\n/).map((l) => l.trim());

    // Export format expected by llama serve INI: FLAG = true
    expect(lines).toContain('no-warmup = true');
    expect(lines).not.toContain('no-warmup = __TOGGLE_FLAG__');
    expect(lines).toContain('custom-kv = some-value');
    expect(lines).toContain('no-webui = true');
    expect(lines).toContain('special-toggle = true');
    expect(lines).toContain('override-kv = foo=bar');

    const roundTripped = parsePresetIni(ini);
    // When read from INI, standard key = value is parsed (custom-kv and string 'true')
    expect(roundTripped.common.custom['no-warmup']).toBe('true');
    expect(roundTripped.common.custom['custom-kv']).toBe('some-value');
    expect(roundTripped.models['Qwen3-8B-Q4_K_M'].custom['no-webui']).toBe('true');
    expect(roundTripped.models['Qwen3-8B-Q4_K_M'].custom['special-toggle']).toBe('true');
    expect(roundTripped.models['Qwen3-8B-Q4_K_M'].custom['override-kv']).toBe('foo=bar');
    // isValuelessFlag recognises VALUELESS_FLAG_MARKER, boolean true, and string 'true'
    expect(isValuelessFlag(roundTripped.common.custom['no-warmup'])).toBe(true);
    expect(isValuelessFlag(roundTripped.models['Qwen3-8B-Q4_K_M'].custom['no-webui'])).toBe(true);
    expect(isValuelessFlag(roundTripped.models['Qwen3-8B-Q4_K_M'].custom['special-toggle'])).toBe(true);
  });

  it('resolves inherited values from [*] common configuration for unset per-model fields', () => {
    const common = {
      jinja: true,
      device: 'CUDA0',
      'split-mode': 'layer',
      reasoning: 'auto',
      parallel: 4,
      'top-p': 0.95,
      'ctx-size': 16384,
      custom: {
        'tensor-split': '3,1',
      },
    };

    expect(getInheritedValueFromCommon(common, 'jinja')).toBe(true);
    expect(getInheritedValueFromCommon(common, 'device')).toBe('CUDA0');
    expect(getInheritedValueFromCommon(common, 'split-mode')).toBe('layer');
    expect(getInheritedValueFromCommon(common, 'reasoning')).toBe('auto');
    expect(getInheritedValueFromCommon(common, 'parallel')).toBe(4);
    expect(getInheritedValueFromCommon(common, 'top-p')).toBe(0.95);
    expect(getInheritedValueFromCommon(common, 'ctx-size')).toBe(16384);
    expect(getInheritedValueFromCommon(common, 'tensor-split')).toBe('3,1');
    expect(getInheritedValueFromCommon(common, 'seed')).toBeUndefined();
    expect(getInheritedValueFromCommon(common, 'model')).toBeUndefined();
  });

  it('saves all configurations to .all_configs_available.ini and exports only enabled configurations to the user preset file', async () => {
    const doc: PresetConfigDocument = {
      common: {
        jinja: true,
        custom: {},
      },
      models: {
        'Model-A': {
          sectionId: 'Model-A',
          model: '/models/model-a.gguf',
          custom: {},
        },
        'Model-B': {
          sectionId: 'Model-B',
          model: '/models/model-b.gguf',
          custom: {},
        },
        'Model-C': {
          sectionId: 'Model-C',
          model: '/models/model-c.gguf',
          custom: {},
        },
      },
      disabledSectionIds: ['Model-B'],
    };

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-export-test-'));
    try {
      const exportPath = path.join(tmpDir, 'exported-preset.ini');

      // 1. Export user preset file (excludes disabled 'Model-B')
      await savePresetFile(exportPath, doc, { excludeDisabled: true });
      const exportedDoc = await loadPresetFile(exportPath);
      expect(Object.keys(exportedDoc.models)).toContain('Model-A');
      expect(Object.keys(exportedDoc.models)).not.toContain('Model-B');
      expect(Object.keys(exportedDoc.models)).toContain('Model-C');

      // 2. Save .all_configs_available.ini in modelsDir (contains ALL models: A, B, and C)
      const allConfigsPath = await saveAllConfigsAvailableFile(tmpDir, doc);
      expect(allConfigsPath).toBe(path.join(tmpDir, ALL_CONFIGS_AVAILABLE_FILENAME));
      expect(allConfigsPath).toBe(getAllConfigsFilePath(tmpDir));

      const allConfigsDoc = await loadPresetFile(allConfigsPath);
      expect(Object.keys(allConfigsDoc.models)).toContain('Model-A');
      expect(Object.keys(allConfigsDoc.models)).toContain('Model-B');
      expect(Object.keys(allConfigsDoc.models)).toContain('Model-C');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('infers export status from .all_configs_available.ini + exported preset and computes 4-state UI badges', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-diff-state-test-'));
    try {
      const exportPath = path.join(tmpDir, 'exported-preset.ini');

      // Existing .all_configs_available.ini has Model-A (exported) and Model-B (not exported, with custom temp)
      const savedAllConfigs: PresetConfigDocument = {
        common: { temp: 0.6, custom: {} },
        models: {
          'Model-A': { sectionId: 'Model-A', model: '/models/a.gguf', custom: {} },
          'Model-B': { sectionId: 'Model-B', model: '/models/b.gguf', temp: 0.3, custom: {} },
        },
        disabledSectionIds: ['Model-B'],
      };

      await savePresetFile(exportPath, savedAllConfigs, { excludeDisabled: true });
      await saveAllConfigsAvailableFile(tmpDir, savedAllConfigs);

      const allConfigsDoc = await loadAllConfigsAvailableFile(tmpDir);
      const exportedDoc = await loadPresetFile(exportPath);
      const merged = mergePresetWithAllConfigs(allConfigsDoc, exportedDoc);

      // Model-B's custom temp from .all_configs_available.ini is preserved
      expect(merged.models['Model-B']?.temp).toBe(0.3);

      // Simulate a newly discovered Model-C added by scan
      const syncedDoc: PresetConfigDocument = {
        common: merged.common,
        models: {
          ...merged.models,
          'Model-C': { sectionId: 'Model-C', model: '/models/c.gguf', custom: {} },
        },
      };

      const disabledIds = computeInitialDisabledSectionIds(syncedDoc, allConfigsDoc, exportedDoc);
      // Model-B was known in .all_configs_available.ini and absent from exportedDoc -> disabled [✗]
      // Model-C is newly discovered -> enabled for next save [+]
      expect(disabledIds).toEqual(['Model-B']);

      const exportedIds = Object.keys(exportedDoc.models); // ['Model-A']

      // 1. Exported & staying exported -> green [✓]
      expect(getSectionExportBadge('Model-A', disabledIds, exportedIds)).toEqual({
        state: 'exported',
        symbol: '[✓]',
        color: 'green',
        isDisabled: false,
      });

      // 2. Not exported & staying not exported -> red [✗]
      expect(getSectionExportBadge('Model-B', disabledIds, exportedIds)).toEqual({
        state: 'not-exported',
        symbol: '[✗]',
        color: 'red',
        isDisabled: true,
      });

      // 3. Newly discovered (not in exportedIds, not disabled) -> yellow [+]
      expect(getSectionExportBadge('Model-C', disabledIds, exportedIds)).toEqual({
        state: 'to-add',
        symbol: '[+]',
        color: 'yellow',
        isDisabled: false,
      });

      // 4. Currently exported, toggled off before save -> orange [-]
      expect(getSectionExportBadge('Model-A', ['Model-A', 'Model-B'], exportedIds)).toEqual({
        state: 'to-remove',
        symbol: '[-]',
        color: '#FFA500',
        isDisabled: true,
      });

      // Parent header badge: mixed states show [~], uniform states show their shared symbol
      expect(
        getModelHeaderExportBadge(
          [syncedDoc.models['Model-A']!, syncedDoc.models['Model-B']!],
          disabledIds,
          exportedIds
        )
      ).toEqual({ symbol: '[~]', color: 'cyan', isAllDisabled: false });

      expect(
        getModelHeaderExportBadge([syncedDoc.models['Model-C']!], disabledIds, exportedIds)
      ).toEqual({ symbol: '[+]', color: 'yellow', isAllDisabled: false });

      // First run (neither file exists): all discovered models default to enabled -> [+]
      const emptyDoc = createEmptyPresetDocument();
      const firstRunDisabled = computeInitialDisabledSectionIds(syncedDoc, emptyDoc, emptyDoc);
      expect(firstRunDisabled).toEqual([]);
      expect(getSectionExportBadge('Model-A', firstRunDisabled, [])).toEqual({
        state: 'to-add',
        symbol: '[+]',
        color: 'yellow',
        isDisabled: false,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('renames a model or custom configuration section while preserving order, disabled state, and preventing collisions', () => {
    const doc: PresetConfigDocument = {
      common: { custom: {} },
      models: {
        'Model-A': { sectionId: 'Model-A', model: '/models/a.gguf', temp: 0.7, custom: {} },
        'Model-A-custom': {
          sectionId: 'Model-A-custom',
          model: '/models/a.gguf',
          temp: 0.2,
          custom: {},
        },
        'Model-B': { sectionId: 'Model-B', model: '/models/b.gguf', custom: {} },
      },
      disabledSectionIds: ['Model-A-custom'],
    };

    // Successful rename preserves order and updates disabledSectionIds
    const res = renameModelSectionInDocument(doc, 'Model-A-custom', {
      ...doc.models['Model-A-custom']!,
      sectionId: '[Model-A-coding]',
    });
    expect(res.renamed).toBe(true);
    expect(Object.keys(res.doc.models)).toEqual(['Model-A', 'Model-A-coding', 'Model-B']);
    expect(res.doc.models['Model-A-coding']?.sectionId).toBe('Model-A-coding');
    expect(res.doc.models['Model-A-coding']?.temp).toBe(0.2);
    expect(res.doc.disabledSectionIds).toEqual(['Model-A-coding']);

    // Collision is rejected
    const collision = renameModelSectionInDocument(res.doc, 'Model-A-coding', {
      ...res.doc.models['Model-A-coding']!,
      sectionId: 'Model-B',
    });
    expect(collision.renamed).toBe(false);
    expect(collision.reason).toContain('already exists');

    // Empty name is rejected
    const empty = renameModelSectionInDocument(res.doc, 'Model-A-coding', {
      ...res.doc.models['Model-A-coding']!,
      sectionId: '   ',
    });
    expect(empty.renamed).toBe(false);
  });
});

