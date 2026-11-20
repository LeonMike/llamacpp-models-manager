import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { CommonPresetConfig } from '../../types/index.js';
import { KNOWN_COMMON_KEYS } from '../../core/preset-config.js';
import { computeScrollWindow, truncateMiddle } from '../hooks/useTerminalSize.js';
import {
  BOTTOM_TEXT_EDITOR_HEIGHT,
  BottomTextEditorBar,
} from './BottomTextEditorBar.js';
import { KeyValueEditor } from './KeyValueEditor.js';

export interface CommonConfigViewProps {
  common: CommonPresetConfig;
  onChange: (updated: CommonPresetConfig) => void;
  onEditingTextChange?: (editing: boolean) => void;
  onSubScreenChange?: (inSubScreen: boolean) => void;
  contentHeight: number;
  columns: number;
}

interface FieldDescriptor {
  key: (typeof KNOWN_COMMON_KEYS)[number];
  label: string;
  description: string;
  isBoolean?: boolean;
  isPath?: boolean;
}

const COMMON_FIELDS: FieldDescriptor[] = [
  { key: 'jinja', label: 'jinja', description: 'Enable Jinja2 chat template engine (true/false)', isBoolean: true },
  { key: 'device', label: 'device', description: 'Comma-separated list of devices to use for offloading (e.g. CUDA0,CUDA1 or none)' },
  { key: 'mmproj-device', label: 'mmproj-device', description: 'Device(s) to use for offloading the multimodal projector (e.g. CUDA0,CPU)' },
  { key: 'split-mode', label: 'split-mode', description: 'How to split the model across multiple GPUs (none, layer, row)' },
  { key: 'reasoning', label: 'reasoning', description: 'Reasoning / thinking mode configuration (e.g. on, off, auto, budget)' },
  { key: 'parallel', label: 'parallel', description: 'Number of parallel sequences / slots to decode simultaneously (e.g. 1, 4)' },
  { key: 'flash-attn', label: 'flash-attn', description: 'Enable Flash Attention by default (true/false/auto)' },
  { key: 'n-gpu-layers', label: 'n-gpu-layers', description: 'Default GPU layers to offload (e.g. 99 or -1)' },
  { key: 'ctx-size', label: 'ctx-size', description: 'Default context window size (e.g. 8192, 16384)' },
  { key: 'batch-size', label: 'batch-size', description: 'Logical maximum batch size (default: 2048)' },
  { key: 'ubatch-size', label: 'ubatch-size', description: 'Physical micro-batch size (default: 512)' },
  { key: 'temp', label: 'temp', description: 'Default sampling temperature (e.g. 0.7)' },
  { key: 'top-p', label: 'top-p', description: 'Default top-p nucleus sampling (e.g. 0.95)' },
  { key: 'top-k', label: 'top-k', description: 'Default top-k sampling (e.g. 40)' },
  { key: 'min-p', label: 'min-p', description: 'Default min-p sampling (e.g. 0.05)' },
  { key: 'repeat-penalty', label: 'repeat-penalty', description: 'Default repeat penalty (e.g. 1.1)' },
  { key: 'presence-penalty', label: 'presence-penalty', description: 'Default presence penalty (e.g. 0.0)' },
  { key: 'frequency-penalty', label: 'frequency-penalty', description: 'Default frequency penalty (e.g. 0.0)' },
  { key: 'cache-type-k', label: 'cache-type-k', description: 'Default KV cache K data type (f16, q8_0, q4_0, etc.)' },
  { key: 'cache-type-v', label: 'cache-type-v', description: 'Default KV cache V data type (f16, q8_0, q4_0, etc.)' },
  { key: 'reasoning-format', label: 'reasoning-format', description: 'Reasoning extraction format (deepseek, none, auto)' },
  { key: 'chat-template', label: 'chat-template', description: 'Override default named chat template', isPath: true },
  { key: 'system-prompt', label: 'system-prompt', description: 'Default system prompt if applicable' },
];

export const CommonConfigView: React.FC<CommonConfigViewProps> = ({
  common,
  onChange,
  onEditingTextChange,
  onSubScreenChange,
  contentHeight,
  columns,
}) => {
  const [sectionMode, setSectionModeState] = useState<'standard' | 'custom'>('standard');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEditingField, setIsEditingField] = useState(false);
  const [draftVal, setDraftVal] = useState('');

  const setSectionMode = (next: 'standard' | 'custom') => {
    setSectionModeState(next);
    onSubScreenChange?.(next === 'custom');
  };

  const updateEditingState = (editing: boolean) => {
    setIsEditingField(editing);
    onEditingTextChange?.(editing);
  };

  const commitFieldEdit = (rawValue: string) => {
    const field = COMMON_FIELDS[selectedIndex];
    if (field) {
      const next = { ...common, custom: { ...common.custom } };
      const trimmed = rawValue.trim();
      if (trimmed === '') {
        delete next[field.key];
      } else if (trimmed.toLowerCase() === 'true') {
        (next as unknown as Record<string, unknown>)[field.key] = true;
      } else if (trimmed.toLowerCase() === 'false') {
        (next as unknown as Record<string, unknown>)[field.key] = false;
      } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        (next as unknown as Record<string, unknown>)[field.key] = Number(trimmed);
      } else {
        (next as unknown as Record<string, unknown>)[field.key] = trimmed;
      }
      onChange(next);
    }
    updateEditingState(false);
  };

  useInput(
    (input, key) => {
      if (sectionMode === 'custom') {
        if ((input === 'c' || input === 'q' || key.escape) && !isEditingField) {
          setSectionMode('standard');
        }
        return;
      }

      if (isEditingField) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(COMMON_FIELDS.length - 1, prev + 1));
      } else if (input === 'c') {
        setSectionMode('custom');
      } else if (input === ' ' && COMMON_FIELDS[selectedIndex]?.isBoolean) {
        const field = COMMON_FIELDS[selectedIndex];
        const current = common[field.key];
        const nextVal = current === true ? false : true;
        onChange({ ...common, [field.key]: nextVal });
      } else if (key.return || input === 'e') {
        const field = COMMON_FIELDS[selectedIndex];
        if (field) {
          const cur = common[field.key];
          setDraftVal(cur !== undefined ? String(cur) : '');
          updateEditingState(true);
        }
      } else if (input === 'x' || key.delete) {
        const field = COMMON_FIELDS[selectedIndex];
        if (field) {
          const next = { ...common };
          delete next[field.key];
          onChange(next);
        }
      }
    },
    { isActive: !isEditingField }
  );

  const innerWidth = Math.max(40, columns - 2);
  const bottomBarRows = isEditingField && sectionMode === 'standard' ? BOTTOM_TEXT_EDITOR_HEIGHT : 0;
  const maxVisibleRows = Math.max(2, contentHeight - 6 - bottomBarRows);
  const { startIndex, endIndex, hasMoreAbove, hasMoreBelow } = computeScrollWindow(
    COMMON_FIELDS.length,
    selectedIndex,
    maxVisibleRows
  );
  const visibleFields = COMMON_FIELDS.slice(startIndex, endIndex);
  const leftColWidth = Math.min(44, Math.max(28, Math.floor(innerWidth * 0.42)));
  const activeField = COMMON_FIELDS[selectedIndex];

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
          borderColor="gray"
          paddingX={1}
          justifyContent="space-between"
          width={innerWidth}
          flexShrink={0}
        >
          <Box overflowX="hidden">
            <Text bold color="cyan" wrap="truncate-end">
              [*] Global Common Preset Section
            </Text>
            <Text color="gray" wrap="truncate-end">
              {' '}
              — Inherited by all models
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color="yellow" bold wrap="truncate-end">
              [c] Switch to {sectionMode === 'standard' ? 'Custom Key-Values' : 'Standard Parameters'}
            </Text>
          </Box>
        </Box>

        {sectionMode === 'standard' ? (
          <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
            <Box justifyContent="space-between" width={innerWidth} paddingX={1}>
              <Text color="gray" wrap="truncate-end">
                [↑/↓] Scroll ({selectedIndex + 1}/{COMMON_FIELDS.length}) │ [Enter/e] Edit in Bottom Bar │ [Space] Toggle Bool │ [x] Clear
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
              const val = common[field.key];
              const isEditingThis = isSelected && isEditingField;

              return (
                <Box
                  key={field.key}
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
                    ) : val !== undefined && val !== '' ? (
                      <Text color="green" bold wrap="truncate-end">
                        {truncateMiddle(String(val), Math.max(8, leftColWidth - field.label.length - 6))}
                      </Text>
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
                ↓ ({COMMON_FIELDS.length - endIndex} more below)
              </Text>
            )}
          </Box>
        ) : (
          <KeyValueEditor
            pairs={common.custom}
            onChange={(updatedCustom) => onChange({ ...common, custom: updatedCustom })}
            isFocused={sectionMode === 'custom'}
            onFocusChange={(editing) => updateEditingState(editing)}
            maxRows={Math.max(4, contentHeight - 4)}
            maxCols={innerWidth}
          />
        )}
      </Box>

      {isEditingField && sectionMode === 'standard' && activeField && (
        <BottomTextEditorBar
          label={`[*].${activeField.label}`}
          initialValue={draftVal}
          placeholder={activeField.description}
          columns={columns}
          enablePathAutocomplete={Boolean(activeField.isPath)}
          onSubmit={commitFieldEdit}
          onCancel={() => updateEditingState(false)}
        />
      )}
    </Box>
  );
};
