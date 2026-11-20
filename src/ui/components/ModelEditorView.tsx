import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  AppTestSettings,
  CommonPresetConfig,
  isValuelessFlag,
  ModelPresetSection,
  ModelTestRunResult,
  SectionTestStatus,
} from '../../types/index.js';
import { hasModelDraft, sanitizeDraftOptions } from '../../core/preset-config.js';
import {
  compareTokensPerSecond,
  getTestStatusColor,
  recordCompletedTestStatus,
  recordRunningTestStatus,
  RunningTestController,
  startModelConfigurationTest,
} from '../../core/model-tester.js';
import {
  computeScrollWindow,
  isNarrowTerminal,
  truncateMiddle,
  wrapTextToLines,
} from '../hooks/useTerminalSize.js';
import {
  BOTTOM_TEXT_EDITOR_HEIGHT,
  BottomTextEditorBar,
} from './BottomTextEditorBar.js';
import { KeyValueEditor } from './KeyValueEditor.js';

export interface ModelEditorViewProps {
  common: CommonPresetConfig;
  section: ModelPresetSection;
  isMoe?: boolean;
  testSettings: AppTestSettings;
  sectionTestStatus?: SectionTestStatus;
  onUpdateTestStatus?: (
    sectionId: string,
    statusOrUpdater:
      | SectionTestStatus
      | ((prevStatus: SectionTestStatus | undefined) => SectionTestStatus)
  ) => void;
  onChange: (updated: ModelPresetSection) => void;
  onBack: () => void;
  onEditingTextChange?: (editing: boolean) => void;
  contentHeight: number;
  columns: number;
}

type CategoryId = 'core' | 'hardware' | 'moe' | 'sampling' | 'chat' | 'draft' | 'custom';

interface FieldSpec {
  key: keyof ModelPresetSection;
  label: string;
  description: string;
  isBoolean?: boolean;
  isStringOnly?: boolean;
  isPath?: boolean;
}

const CORE_FIELDS: FieldSpec[] = [
  { key: 'sectionId', label: 'name (section-id)', description: 'Model / configuration name ([section-id]) in preset INI', isStringOnly: true },
  { key: 'model', label: 'model', description: 'Path to primary .gguf model file', isStringOnly: true, isPath: true },
  { key: 'mmproj', label: 'mmproj', description: 'Path to multimodal vision projector .gguf (optional)', isStringOnly: true, isPath: true },
  {
    key: 'model-draft',
    label: 'model-draft',
    description: 'Path to MTP / speculative draft .gguf (unlocks Draft/MTP tab when set)',
    isStringOnly: true,
    isPath: true,
  },
  { key: 'alias', label: 'alias', description: 'Optional alias name exposed by llama serve', isStringOnly: true },
];

const HARDWARE_FIELDS: FieldSpec[] = [
  { key: 'device', label: 'device', description: 'Comma-separated list of devices to use (e.g. CUDA0,CUDA1)', isStringOnly: true },
  { key: 'mmproj-device', label: 'mmproj-device', description: 'Device(s) to use for offloading the multimodal projector (e.g. CUDA0,CPU)', isStringOnly: true },
  { key: 'split-mode', label: 'split-mode', description: 'How to split the model across multiple GPUs (none, layer, row)', isStringOnly: true },
  { key: 'parallel', label: 'parallel', description: 'Number of parallel sequences / slots to decode simultaneously' },
  { key: 'n-gpu-layers', label: 'n-gpu-layers', description: 'GPU layers to offload (e.g. 99 or -1)' },
  { key: 'ctx-size', label: 'ctx-size', description: 'Context size in tokens (e.g. 8192, 32768)' },
  { key: 'batch-size', label: 'batch-size', description: 'Logical maximum batch size (b)' },
  { key: 'ubatch-size', label: 'ubatch-size', description: 'Physical micro-batch size (ub)' },
  { key: 'flash-attn', label: 'flash-attn', description: 'Enable Flash Attention (true/false/auto)' },
  { key: 'tensor-split', label: 'tensor-split', description: 'Multi-GPU split ratios (e.g. 3,1)', isStringOnly: true },
  { key: 'cache-type-k', label: 'cache-type-k', description: 'KV cache K type (f16, bf16, q8_0, q4_0, etc.)', isStringOnly: true },
  { key: 'cache-type-v', label: 'cache-type-v', description: 'KV cache V type (f16, bf16, q8_0, q4_0, etc.)', isStringOnly: true },
  { key: 'no-mmap', label: 'no-mmap', description: 'Disable memory-mapping model file (true/false)', isBoolean: true },
  { key: 'mlock', label: 'mlock', description: 'Lock model in RAM to prevent swapping (true/false)', isBoolean: true },
];

const MOE_HARDWARE_FIELD: FieldSpec = {
  key: 'n-cpu-moe',
  label: 'n-cpu-moe',
  description: 'Number of MoE (Mixture-of-Experts) layers to keep on CPU (ncmoe)',
};

const MOE_FIELDS: FieldSpec[] = [
  {
    key: 'n-cpu-moe',
    label: 'n-cpu-moe',
    description: 'Number of MoE (Mixture-of-Experts) layers whose expert weights stay on CPU',
  },
  {
    key: 'n-gpu-layers',
    label: 'n-gpu-layers',
    description: 'Number of model layers to offload to GPU (ngl)',
  },
];

const SAMPLING_FIELDS: FieldSpec[] = [
  { key: 'temp', label: 'temp', description: 'Sampling temperature (e.g. 0.7)' },
  { key: 'top-p', label: 'top-p', description: 'Top-p nucleus sampling (e.g. 0.95)' },
  { key: 'top-k', label: 'top-k', description: 'Top-k sampling (e.g. 40)' },
  { key: 'min-p', label: 'min-p', description: 'Min-p sampling threshold (e.g. 0.05)' },
  { key: 'repeat-penalty', label: 'repeat-penalty', description: 'Penalty for repeating tokens (e.g. 1.1)' },
  { key: 'presence-penalty', label: 'presence-penalty', description: 'Presence penalty (e.g. 0.0)' },
  { key: 'frequency-penalty', label: 'frequency-penalty', description: 'Frequency penalty (e.g. 0.0)' },
  { key: 'seed', label: 'seed', description: 'RNG seed (-1 for random)' },
];

const CHAT_FIELDS: FieldSpec[] = [
  { key: 'jinja', label: 'jinja', description: 'Override Jinja template engine for this model (true/false)', isBoolean: true },
  { key: 'reasoning', label: 'reasoning', description: 'Reasoning / thinking mode configuration (on, off, auto)', isStringOnly: true },
  { key: 'chat-template', label: 'chat-template', description: 'Custom chat template name or string', isStringOnly: true, isPath: true },
  { key: 'reasoning-format', label: 'reasoning-format', description: 'Reasoning format (deepseek, none, auto)', isStringOnly: true },
  { key: 'system-prompt', label: 'system-prompt', description: 'Model-specific system prompt', isStringOnly: true },
];

/**
 * CRITICAL RULE: These draft-specific fields are ONLY available when `model-draft` is present!
 */
const DRAFT_FIELDS: FieldSpec[] = [
  {
    key: 'spec-type',
    label: 'spec-type',
    description: 'Speculative decoding type (e.g. draft-mtp, draft-paged, eagle)',
    isStringOnly: true,
  },
  {
    key: 'cache-type-k-draft',
    label: 'cache-type-k-draft',
    description: 'KV cache K data type for draft model (f16, q8_0, q4_0, etc.)',
    isStringOnly: true,
  },
  {
    key: 'cache-type-v-draft',
    label: 'cache-type-v-draft',
    description: 'KV cache V data type for draft model (f16, q8_0, q4_0, etc.)',
    isStringOnly: true,
  },
  {
    key: 'n-gpu-layers-draft',
    label: 'n-gpu-layers-draft',
    description: 'Number of layers to offload to GPU for the draft model',
  },
  {
    key: 'spec-draft-device',
    label: 'spec-draft-device',
    description: 'Device(s) to use for offloading the draft model (e.g. CUDA0,CPU)',
    isStringOnly: true,
  },
  {
    key: 'spec-draft-n-max',
    label: 'spec-draft-n-max',
    description: 'Maximum number of tokens to draft per speculative step (e.g. 16)',
  },
  {
    key: 'spec-draft-p-min',
    label: 'spec-draft-p-min',
    description: 'Minimum speculative draft acceptance probability threshold (e.g. 0.75)',
  },
];

/**
 * Resolves the value that a model field will inherit from the global `[*]` `CommonPresetConfig`
 * when the field is not explicitly set on the model's own section.
 */
export function getInheritedValueFromCommon(
  common: CommonPresetConfig,
  key: keyof ModelPresetSection
): string | number | boolean | undefined {
  if (key === 'custom' || key === 'sectionId' || key === 'model') {
    return undefined;
  }
  const direct = (common as unknown as Record<string, unknown>)[key];
  if (direct !== undefined && direct !== '' && typeof direct !== 'object') {
    return direct as string | number | boolean;
  }
  const customFallback = common.custom?.[String(key)];
  if (customFallback !== undefined && customFallback !== '') {
    return isValuelessFlag(customFallback) ? true : customFallback;
  }
  return undefined;
}

export const ModelEditorView: React.FC<ModelEditorViewProps> = ({
  common,
  section,
  isMoe = false,
  testSettings,
  sectionTestStatus,
  onUpdateTestStatus,
  onChange,
  onBack,
  onEditingTextChange,
  contentHeight,
  columns,
}) => {
  const draftEnabled = hasModelDraft(section);
  const moeEnabled = isMoe || section['n-cpu-moe'] !== undefined;

  const categories = useMemo(() => {
    const base: Array<{ id: CategoryId; label: string }> = [
      { id: 'core', label: 'Core & Paths' },
      { id: 'hardware', label: 'Hardware' },
    ];
    if (moeEnabled) {
      base.push({ id: 'moe', label: '🧠 MoE Offload' });
    }
    base.push(
      { id: 'sampling', label: 'Sampling' },
      { id: 'chat', label: 'Chat' }
    );
    if (draftEnabled) {
      base.push({ id: 'draft', label: '⚡ Draft / MTP' });
    }
    base.push({ id: 'custom', label: 'Custom Flags' });
    return base;
  }, [draftEnabled, moeEnabled]);

  const [activeCategory, setActiveCategory] = useState<CategoryId>('core');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEditingField, setIsEditingField] = useState(false);
  const [draftVal, setDraftVal] = useState('');

  // Model Test Runner Modal State
  const [isTestModalOpen, setIsTestModalOpen] = useState(false);
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [liveTestOutput, setLiveTestOutput] = useState('');
  const [testResult, setTestResult] = useState<ModelTestRunResult | null>(null);
  const [testScrollOffset, setTestScrollOffset] = useState(0);
  const [autoFollowLog, setAutoFollowLog] = useState(true);
  const testControllerRef = useRef<RunningTestController | null>(null);

  // Clean up only the spawned test process if component unmounts while running
  useEffect(() => {
    return () => {
      if (testControllerRef.current) {
        testControllerRef.current.abort();
        testControllerRef.current = null;
      }
    };
  }, []);

  // Inform parent when the Test Output Modal is open/closed
  const openTestModal = () => {
    setIsTestModalOpen(true);
  };

  const closeTestModal = () => {
    if (testControllerRef.current) {
      testControllerRef.current.abort();
      testControllerRef.current = null;
    }
    setIsTestRunning(false);
    setIsTestModalOpen(false);
  };

  const triggerModelTest = () => {
    if (testControllerRef.current) {
      testControllerRef.current.abort();
    }
    openTestModal();
    setIsTestRunning(true);
    setTestResult(null);
    setLiveTestOutput('Starting llama cli test process...\n');
    setTestScrollOffset(0);
    setAutoFollowLog(true);
    onUpdateTestStatus?.(section.sectionId, (prev) => recordRunningTestStatus(prev));

    const controller = startModelConfigurationTest(
      common,
      section,
      testSettings,
      (combined) => {
        setLiveTestOutput(combined);
      }
    );
    testControllerRef.current = controller;

    void controller.promise.then((res) => {
      setIsTestRunning(false);
      setTestResult(res);
      onUpdateTestStatus?.(section.sectionId, (prev) => recordCompletedTestStatus(prev, res));
      const finalOut = res.combinedOutput || '(No output emitted)';
      setLiveTestOutput(finalOut);
      // Position scroll at the bottom of the output when finished so user sees the result and can scroll ↑/↓ freely
      const wrappedCount = wrapTextToLines(finalOut, Math.max(20, columns - 6)).length;
      setTestScrollOffset(Math.max(0, wrappedCount - 1));
      setAutoFollowLog(false);
      testControllerRef.current = null;
    });
  };

  // If `model-draft` was cleared while viewing the `draft` tab, fall back to `core`
  const effectiveCategory: CategoryId =
    activeCategory === 'draft' && !draftEnabled
      ? 'core'
      : activeCategory === 'moe' && !moeEnabled
      ? 'hardware'
      : activeCategory;

  const activeFields: FieldSpec[] = useMemo(() => {
    switch (effectiveCategory) {
      case 'core':
        return CORE_FIELDS;
      case 'hardware':
        return moeEnabled
          ? [
              ...HARDWARE_FIELDS.slice(0, 4),
              MOE_HARDWARE_FIELD,
              ...HARDWARE_FIELDS.slice(4),
            ]
          : HARDWARE_FIELDS;
      case 'moe':
        return moeEnabled ? MOE_FIELDS : [];
      case 'sampling':
        return SAMPLING_FIELDS;
      case 'chat':
        return CHAT_FIELDS;
      case 'draft':
        return draftEnabled ? DRAFT_FIELDS : [];
      default:
        return [];
    }
  }, [effectiveCategory, draftEnabled, moeEnabled]);

  const updateEditing = (editing: boolean) => {
    setIsEditingField(editing);
    onEditingTextChange?.(editing);
  };

  const commitFieldEdit = (rawValue: string) => {
    const field = activeFields[selectedIndex];
    if (field) {
      const next: ModelPresetSection = {
        ...section,
        custom: { ...section.custom },
      };
      const trimmed = rawValue.trim();
      if (field.key === 'sectionId') {
        const sanitized = trimmed.replace(/[\[\]]/g, '').trim();
        if (sanitized) {
          next.sectionId = sanitized;
        }
      } else if (trimmed === '') {
        delete next[field.key];
      } else if (!field.isStringOnly && trimmed.toLowerCase() === 'true') {
        (next as unknown as Record<string, unknown>)[field.key] = true;
      } else if (!field.isStringOnly && trimmed.toLowerCase() === 'false') {
        (next as unknown as Record<string, unknown>)[field.key] = false;
      } else if (!field.isStringOnly && /^-?\d+(\.\d+)?$/.test(trimmed)) {
        (next as unknown as Record<string, unknown>)[field.key] = Number(trimmed);
      } else {
        (next as unknown as Record<string, unknown>)[field.key] = trimmed;
      }

      // Enforce rule: if `model-draft` was removed, strip draft-dependent options
      sanitizeDraftOptions(next);
      onChange(next);
    }
    updateEditing(false);
  };

  const innerWidth = Math.max(40, columns - 2);
  const logLineWidth = Math.max(20, innerWidth - 4);

  const outputLines = useMemo(() => {
    const raw = (testResult ? testResult.combinedOutput : liveTestOutput) || '';
    return wrapTextToLines(raw, logLineWidth);
  }, [testResult, liveTestOutput, logLineWidth]);

  useInput(
    (input, key) => {
      // Handle Test Output Modal navigation & process termination
      if (isTestModalOpen) {
        if (key.escape || input === 'q' || input === 'b' || input === 'c') {
          closeTestModal();
          return;
        }
        if (input === 'r' || input === 't') {
          triggerModelTest();
          return;
        }
        if (key.upArrow) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, outputLines.length - 1) : prev;
            return Math.max(0, base - 1);
          });
        } else if (key.downArrow) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, outputLines.length - 1) : prev;
            return Math.min(Math.max(0, outputLines.length - 1), base + 1);
          });
        } else if (key.pageUp) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, outputLines.length - 1) : prev;
            return Math.max(0, base - 10);
          });
        } else if (key.pageDown) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, outputLines.length - 1) : prev;
            return Math.min(Math.max(0, outputLines.length - 1), base + 10);
          });
        } else if (input === 'g') {
          setAutoFollowLog(false);
          setTestScrollOffset(0);
        } else if (input === 'G') {
          setAutoFollowLog(true);
          setTestScrollOffset(Math.max(0, outputLines.length - 1));
        }
        return;
      }

      if (effectiveCategory === 'custom') {
        if (!isEditingField) {
          if (input === 't') {
            triggerModelTest();
            return;
          }
          if (key.leftArrow || input === '[') {
            const idx = categories.findIndex((c) => c.id === effectiveCategory);
            const nextIdx = (idx - 1 + categories.length) % categories.length;
            setActiveCategory(categories[nextIdx].id);
            setSelectedIndex(0);
          } else if (key.rightArrow || input === ']') {
            const idx = categories.findIndex((c) => c.id === effectiveCategory);
            const nextIdx = (idx + 1) % categories.length;
            setActiveCategory(categories[nextIdx].id);
            setSelectedIndex(0);
          } else if (key.escape || input === 'q' || input === 'b') {
            onBack();
          }
        }
        return;
      }

      if (isEditingField) {
        return;
      }

      if (key.escape || input === 'q' || input === 'b') {
        onBack();
        return;
      }

      // Hotkey [t]: Try / Test this model configuration with llama cli!
      if (input === 't') {
        triggerModelTest();
        return;
      }

      if (key.leftArrow || input === '[') {
        const idx = categories.findIndex((c) => c.id === effectiveCategory);
        const nextIdx = (idx - 1 + categories.length) % categories.length;
        setActiveCategory(categories[nextIdx].id);
        setSelectedIndex(0);
      } else if (key.rightArrow || input === ']') {
        const idx = categories.findIndex((c) => c.id === effectiveCategory);
        const nextIdx = (idx + 1) % categories.length;
        setActiveCategory(categories[nextIdx].id);
        setSelectedIndex(0);
      } else if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.max(0, activeFields.length - 1), prev + 1));
      } else if (input === ' ' && activeFields[selectedIndex]?.isBoolean) {
        const field = activeFields[selectedIndex];
        const cur = section[field.key];
        const inherited = getInheritedValueFromCommon(common, field.key);
        const effectiveCurrent =
          cur !== undefined
            ? cur === true || String(cur).toLowerCase() === 'true'
            : inherited === true || String(inherited).toLowerCase() === 'true';
        const nextVal = !effectiveCurrent;
        onChange({ ...section, [field.key]: nextVal });
      } else if (key.return || input === 'e') {
        const field = activeFields[selectedIndex];
        if (field) {
          const cur = section[field.key];
          setDraftVal(cur !== undefined ? String(cur) : '');
          updateEditing(true);
        }
      } else if (input === 'x' || key.delete) {
        const field = activeFields[selectedIndex];
        if (field && field.key !== 'model' && field.key !== 'sectionId') {
          const next: ModelPresetSection = {
            ...section,
            custom: { ...section.custom },
          };
          delete next[field.key];
          sanitizeDraftOptions(next);
          onChange(next);
        }
      }
    },
    { isActive: !isEditingField }
  );

  // Render Test Configuration Modal when active
  if (isTestModalOpen) {
    const cmdText = testResult?.commandLine ?? testControllerRef.current?.commandLine ?? '';
    const pidNumber = testResult?.pid ?? testControllerRef.current?.pid;
    const wrappedCmdLines = wrapTextToLines(`Cmd: ${cmdText}`, Math.max(20, innerWidth - 4));
    const wrappedPromptLines = wrapTextToLines(
      `Prompt: "${testSettings.defaultPrompt}"`,
      Math.max(20, innerWidth - 4)
    );

    const speedCmp = compareTokensPerSecond(
      sectionTestStatus?.avgTokensPerSec ?? testResult?.avgTokensPerSec,
      sectionTestStatus?.previousAvgTokensPerSec
    );

    const headerBannerRows = 4 + wrappedCmdLines.length + wrappedPromptLines.length;
    const maxLogRows = Math.max(3, contentHeight - headerBannerRows - 4);

    const activeLineIndex =
      isTestRunning && autoFollowLog
        ? Math.max(0, outputLines.length - 1)
        : Math.min(testScrollOffset, Math.max(0, outputLines.length - 1));

    const logWin = computeScrollWindow(outputLines.length, activeLineIndex, maxLogRows);
    const visibleLogLines = outputLines.slice(logWin.startIndex, logWin.endIndex);

    return (
      <Box
        flexDirection="column"
        paddingX={1}
        width={columns}
        height={contentHeight}
        overflowY="hidden"
        overflowX="hidden"
      >
        <Box
          borderStyle="double"
          borderColor={
            isTestRunning ? 'yellow' : testResult?.success ? 'green' : 'red'
          }
          paddingX={1}
          flexDirection="column"
          width={innerWidth}
          flexShrink={0}
        >
          <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
            <Box gap={1} overflowX="hidden">
              <Text
                bold
                color={isTestRunning ? 'yellow' : testResult?.success ? 'green' : 'red'}
                wrap="truncate-end"
              >
                {isTestRunning
                  ? `⏳ Testing [${section.sectionId}] (PID: ${pidNumber ?? 'spawning'})...`
                  : testResult?.success
                  ? `✓ Test Succeeded for [${section.sectionId}] (${(testResult.durationMs / 1000).toFixed(1)}s, PID ${pidNumber ?? '-'} closed)`
                  : `✗ Test Failed for [${section.sectionId}] (Exit: ${testResult?.exitCode ?? 'err'}, PID ${pidNumber ?? '-'} closed)`}
              </Text>
            </Box>
            {!isNarrowTerminal(columns) && (
              <Box flexShrink={0}>
                <Text color="yellow" bold wrap="truncate-end">
                  {isTestRunning
                    ? '[Esc/q] Stop Process & Return'
                    : '[t/r] Re-run Test │ [Esc/q] Back to Config'}
                </Text>
              </Box>
            )}
          </Box>

          {/* Average Tokens/Sec & Comparison vs Previous Saved Run */}
          <Box gap={2} width={innerWidth - 2} overflowX="hidden">
            <Text bold color="yellow" wrap="truncate-end">
              ⚡ Avg Speed:{' '}
              <Text color={speedCmp.currentTps !== undefined ? 'white' : 'gray'}>
                {isTestRunning ? 'Measuring…' : speedCmp.formattedCurrent}
              </Text>
            </Text>
            {!isTestRunning && speedCmp.formattedDetailedComparison && (
              <Text
                bold={speedCmp.direction === 'better' || speedCmp.direction === 'worse'}
                color={
                  speedCmp.direction === 'better'
                    ? 'green'
                    : speedCmp.direction === 'worse'
                    ? 'red'
                    : 'gray'
                }
                wrap="truncate-end"
              >
                {speedCmp.formattedDetailedComparison}
              </Text>
            )}
          </Box>

          {/* Full multi-line command display without truncation */}
          {wrappedCmdLines.map((line, i) => (
            <Text key={`cmd-${i}`} color="gray" wrap="truncate-end">
              {line}
            </Text>
          ))}

          {/* Full multi-line prompt display */}
          {wrappedPromptLines.map((line, i) => (
            <Text key={`prompt-${i}`} color="cyan" wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>

        <Box
          flexDirection="column"
          paddingX={1}
          width={innerWidth}
          overflowY="hidden"
          overflowX="hidden"
        >
          <Box justifyContent="space-between" width={innerWidth - 2}>
            <Text bold underline wrap="truncate-end">
              llama cli Output (Line {outputLines.length > 0 ? activeLineIndex + 1 : 0}/{outputLines.length}):
            </Text>
            <Text color="gray" wrap="truncate-end">
              [↑/↓] Scroll Line │ [PgUp/PgDn] Scroll Page │ [g/G] Top/Bottom
            </Text>
          </Box>

          {logWin.hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↑ ({logWin.startIndex} more line(s) above — press [↑] or [g] to scroll up)
            </Text>
          )}

          {visibleLogLines.map((line, idx) => {
            const globalIdx = logWin.startIndex + idx;
            const isCursorLine = !autoFollowLog && globalIdx === activeLineIndex;
            const isErrorLine = /error|failed|exception|invalid|ggml_assert/i.test(line);

            return (
              <Text
                key={`${globalIdx}`}
                color={isErrorLine ? 'red' : isCursorLine ? 'cyan' : 'white'}
                bold={isCursorLine}
                wrap="truncate-end"
              >
                {isCursorLine ? '❯ ' : '  '}
                {line || ' '}
              </Text>
            );
          })}

          {logWin.hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↓ ({outputLines.length - logWin.endIndex} more line(s) below — press [↓] or [G] to scroll down)
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  const bottomBarRows = isEditingField && effectiveCategory !== 'custom' ? BOTTOM_TEXT_EDITOR_HEIGHT : 0;
  const maxVisibleRows = Math.max(2, contentHeight - 7 - bottomBarRows);
  const { startIndex, endIndex, hasMoreAbove, hasMoreBelow } = computeScrollWindow(
    activeFields.length,
    selectedIndex,
    maxVisibleRows
  );
  const visibleFields = activeFields.slice(startIndex, endIndex);
  const leftColWidth = Math.min(54, Math.max(32, Math.floor(innerWidth * 0.48)));
  const activeField = activeFields[selectedIndex];

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={columns}
      height={contentHeight}
      justifyContent="space-between"
      overflowY="hidden"
      overflowX="hidden"
    >
      <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
        <Box
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          justifyContent="space-between"
          width={innerWidth}
          flexShrink={0}
        >
          <Box gap={1} overflowX="hidden">
            <Text
              color={getTestStatusColor(sectionTestStatus?.status ?? 'untested')}
              bold
            >
              ●
            </Text>
            <Text bold color="cyan" wrap="truncate-end">
              Model: [{section.sectionId}]
            </Text>
            {sectionTestStatus?.avgTokensPerSec !== undefined && (
              <Text color="yellow" bold wrap="truncate-end">
                ⚡ {sectionTestStatus.avgTokensPerSec.toFixed(2)} t/s
              </Text>
            )}
            {sectionTestStatus?.avgTokensPerSec !== undefined &&
              sectionTestStatus?.previousAvgTokensPerSec !== undefined && (
                <Text
                  bold
                  color={
                    sectionTestStatus.avgTokensPerSec >
                    sectionTestStatus.previousAvgTokensPerSec
                      ? 'green'
                      : sectionTestStatus.avgTokensPerSec <
                        sectionTestStatus.previousAvgTokensPerSec
                      ? 'red'
                      : 'gray'
                  }
                  wrap="truncate-end"
                >
                  {
                    compareTokensPerSecond(
                      sectionTestStatus.avgTokensPerSec,
                      sectionTestStatus.previousAvgTokensPerSec
                    ).formattedShortComparison
                  }
                </Text>
              )}
            {moeEnabled && (
              <Text color="yellow" bold wrap="truncate-end">
                [🧠 MoE: n-cpu-moe & n-gpu-layers]
              </Text>
            )}
            {draftEnabled ? (
              <Text color="blue" bold wrap="truncate-end">
                [⚡ model-draft active]
              </Text>
            ) : (
              <Text color="gray" wrap="truncate-end">
                [No model-draft]
              </Text>
            )}
          </Box>
          {!isNarrowTerminal(columns) && (
            <Box flexShrink={0} gap={1}>
              <Text color="black" backgroundColor="green" bold wrap="truncate-end">
                {' [t] ▶ Try Config with llama cli '}
              </Text>
              <Text color="yellow" bold wrap="truncate-end">
                [Esc/q] Back
              </Text>
            </Box>
          )}
        </Box>

        {/* Sub-navigation category bar */}
        <Box gap={1} paddingX={1} width={innerWidth} flexShrink={0} overflowX="hidden">
          <Text color="gray" wrap="truncate-end">
            [←/→]:
          </Text>
          {categories.map((cat) => {
            const isCurr = cat.id === effectiveCategory;
            return (
              <Text
                key={cat.id}
                bold={isCurr}
                color={isCurr ? 'black' : cat.id === 'draft' ? 'blue' : 'white'}
                backgroundColor={isCurr ? 'cyan' : undefined}
                wrap="truncate-end"
              >
                {` ${cat.label} `}
              </Text>
            );
          })}
        </Box>

        {effectiveCategory === 'custom' ? (
          <KeyValueEditor
            pairs={section.custom}
            inheritedPairs={common.custom}
            onChange={(updatedCustom) =>
              onChange(sanitizeDraftOptions({ ...section, custom: updatedCustom }))
            }
            isFocused={effectiveCategory === 'custom'}
            onFocusChange={(editing) => updateEditing(editing)}
            maxRows={Math.max(4, contentHeight - 5)}
            maxCols={innerWidth}
          />
        ) : (
          <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
            <Box paddingX={1} width={innerWidth}>
              <Text color="gray" wrap="truncate-end">
                [↑/↓] Select ({selectedIndex + 1}/{activeFields.length}) │ [Enter/e] Edit in Bottom Bar │ [Space] Toggle Bool │ [x] Clear (Inherit) │ [t] Test Model
              </Text>
            </Box>

            {hasMoreAbove && (
              <Text color="gray" dimColor wrap="truncate-end">
                ↑ ({startIndex} more above)
              </Text>
            )}

            {visibleFields.map((field, localIdx) => {
              const idx = startIndex + localIdx;
              const isSelected = idx === selectedIndex;
              const val = section[field.key];
              const inheritedVal = getInheritedValueFromCommon(common, field.key);
              const hasExplicitVal = val !== undefined && val !== '';
              const hasInheritedVal =
                !hasExplicitVal && inheritedVal !== undefined && inheritedVal !== '';
              const isEditingThis = isSelected && isEditingField;

              return (
                <Box
                  key={String(field.key)}
                  justifyContent="space-between"
                  paddingX={1}
                  width={innerWidth}
                  overflowX="hidden"
                >
                  <Box width={leftColWidth} overflowX="hidden" flexShrink={0}>
                    <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} wrap="truncate-end">
                      {isSelected ? '❯ ' : '  '}
                      {field.label}
                    </Text>
                    <Text color="gray"> = </Text>
                    {isEditingThis ? (
                      <Text color="yellow" bold wrap="truncate-end">
                        (editing in bottom bar…)
                      </Text>
                    ) : hasExplicitVal ? (
                      <Text color="green" bold wrap="truncate-end">
                        {truncateMiddle(String(val), Math.max(10, leftColWidth - field.label.length - 6))}
                      </Text>
                    ) : hasInheritedVal ? (
                      <>
                        <Text color="cyan" italic wrap="truncate-end">
                          ({truncateMiddle(String(inheritedVal), Math.max(8, leftColWidth - field.label.length - 14))})
                        </Text>
                        <Text color="gray" italic wrap="truncate-end">
                          {' '}← [*]
                        </Text>
                      </>
                    ) : (
                      <Text color="gray" italic wrap="truncate-end">
                        (unset)
                      </Text>
                    )}
                  </Box>
                  <Box flexGrow={1} overflowX="hidden">
                    <Text color="gray" wrap="truncate-end">
                      {field.description}
                    </Text>
                  </Box>
                </Box>
              );
            })}

            {hasMoreBelow && (
              <Text color="gray" dimColor wrap="truncate-end">
                ↓ ({activeFields.length - endIndex} more below)
              </Text>
            )}
          </Box>
        )}
      </Box>

      {isEditingField && effectiveCategory !== 'custom' && activeField && (
        <BottomTextEditorBar
          label={
            getInheritedValueFromCommon(common, activeField.key) !== undefined
              ? `[${section.sectionId}].${activeField.label} (inherits: ${String(
                  getInheritedValueFromCommon(common, activeField.key)
                )})`
              : `[${section.sectionId}].${activeField.label}`
          }
          initialValue={draftVal}
          placeholder={
            getInheritedValueFromCommon(common, activeField.key) !== undefined
              ? `Inherited from [*]: (${String(
                  getInheritedValueFromCommon(common, activeField.key)
                )}) — leave empty to inherit, or type to override`
              : activeField.description
          }
          columns={columns}
          enablePathAutocomplete={Boolean(activeField.isPath)}
          onSubmit={commitFieldEdit}
          onCancel={() => updateEditing(false)}
        />
      )}
    </Box>
  );
};
