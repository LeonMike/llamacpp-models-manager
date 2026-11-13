import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  AppTestSettings,
  ModelDetailVisibilityMode,
  ModelListHotkeys,
} from '../../types/index.js';
import {
  cycleModelDetailVisibility,
  DEFAULT_APP_TEST_SETTINGS,
  DEFAULT_MODEL_LIST_HOTKEYS,
  resolveModelListHotkeys,
} from '../../core/model-tester.js';
import { computeScrollWindow, isNarrowTerminal, truncateMiddle } from '../hooks/useTerminalSize.js';
import { BOTTOM_TEXT_EDITOR_HEIGHT, BottomTextEditorBar } from './BottomTextEditorBar.js';

export interface AppSettingsViewProps {
  settings: AppTestSettings;
  onChange: (updated: AppTestSettings) => void;
  onEditingTextChange?: (editing: boolean) => void;
  contentHeight: number;
  columns: number;
}

const VISIBILITY_LABELS: Record<ModelDetailVisibilityMode, string> = {
  'names-only': 'Names only',
  'names-and-configs': 'Names + available configs',
  full: 'Names + configs + performance',
};

interface SettingField {
  id: string;
  key?: keyof AppTestSettings;
  hotkeyKey?: keyof ModelListHotkeys;
  label: string;
  description: string;
  isNumeric?: boolean;
  isVisibilityCycle?: boolean;
}

const SETTING_FIELDS: SettingField[] = [
  {
    id: 'modelDetailVisibility',
    key: 'modelDetailVisibility',
    label: 'Model Details Visibility',
    description: 'Press [Enter/e/Space] to rotate: Names only → Names + configs → Names + configs + performance',
    isVisibilityCycle: true,
  },
  {
    id: 'hotkey.cycleDetailMode',
    hotkeyKey: 'cycleDetailMode',
    label: 'Hotkey: Cycle Model Details',
    description: 'Rotate model detail visibility in Models Config view (default: "i")',
  },
  {
    id: 'hotkey.toggleExport',
    hotkeyKey: 'toggleExport',
    label: 'Hotkey: Toggle Export',
    description: 'Enable/disable model or section for preset export (default: "x")',
  },
  {
    id: 'hotkey.expandAll',
    hotkeyKey: 'expandAll',
    label: 'Hotkey: Expand / Collapse All',
    description: 'Expand or collapse all model groups (default: "a")',
  },
  {
    id: 'hotkey.mixProfiles',
    hotkeyKey: 'mixProfiles',
    label: 'Hotkey: Mix Profiles',
    description: 'Open mixture profiles builder for selected model (default: "v")',
  },
  {
    id: 'hotkey.testModel',
    hotkeyKey: 'testModel',
    label: 'Hotkey: Test Model / Config',
    description: 'Run llama cli test on selected model or config (default: "t")',
  },
  {
    id: 'hotkey.testAll',
    hotkeyKey: 'testAll',
    label: 'Hotkey: Test All Models',
    description: 'Sequentially test all models and configurations (default: "T")',
  },
  {
    id: 'hotkey.testChild',
    hotkeyKey: 'testChild',
    label: 'Hotkey: Test Parent Model',
    description: 'Test all configurations of the parent model from a child row (default: "m")',
  },
  {
    id: 'hotkey.edit',
    hotkeyKey: 'edit',
    label: 'Hotkey: Edit Config',
    description: 'Open model configuration editor (also Enter, default: "e")',
  },
  {
    id: 'hotkey.deleteSection',
    hotkeyKey: 'deleteSection',
    label: 'Hotkey: Delete Config',
    description: 'Delete selected configuration section (default: "d")',
  },
  {
    id: 'hotkey.filter',
    hotkeyKey: 'filter',
    label: 'Hotkey: Filter Models',
    description: 'Focus search filter bar (default: "/")',
  },
  {
    id: 'testCommand',
    key: 'testCommand',
    label: 'Test Command',
    description: 'CLI command to run when testing a model (default: "llama cli" or "llama cli -p {PROMPT}")',
  },
  {
    id: 'serveCommand',
    key: 'serveCommand',
    label: 'Serve Command',
    description: 'CLI command to start the server (default: "llama serve", --models-preset is appended)',
  },
  {
    id: 'defaultPrompt',
    key: 'defaultPrompt',
    label: 'Default Test Prompt',
    description: 'Prompt sent to llama cli during configuration test (default: "why is the sky blue?")',
  },
  {
    id: 'maxPredictTokens',
    key: 'maxPredictTokens',
    label: 'Max Predict Tokens (-n)',
    description: 'Maximum tokens to generate so the test finishes and exits quickly (default: 64)',
    isNumeric: true,
  },
  {
    id: 'timeoutSeconds',
    key: 'timeoutSeconds',
    label: 'Test Timeout (seconds)',
    description: 'Maximum seconds to wait before terminating the spawned test process (default: 120)',
    isNumeric: true,
  },
];

export const AppSettingsView: React.FC<AppSettingsViewProps> = ({
  settings,
  onChange,
  onEditingTextChange,
  contentHeight,
  columns,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [draftVal, setDraftVal] = useState('');

  const updateEditing = (editing: boolean) => {
    setIsEditing(editing);
    onEditingTextChange?.(editing);
  };

  const resolvedHotkeys = resolveModelListHotkeys(settings.hotkeys);
  const currentVisibility: ModelDetailVisibilityMode = settings.modelDetailVisibility ?? 'full';

  const getFieldDisplayValue = (field: SettingField): string => {
    if (field.isVisibilityCycle) {
      return `${VISIBILITY_LABELS[currentVisibility]} (${currentVisibility})`;
    }
    if (field.hotkeyKey) {
      return resolvedHotkeys[field.hotkeyKey];
    }
    if (field.key) {
      return String(settings[field.key] ?? '');
    }
    return '';
  };

  const commitFieldEdit = (rawValue: string) => {
    const field = SETTING_FIELDS[selectedIndex];
    if (field) {
      const next: AppTestSettings = {
        ...settings,
        hotkeys: { ...resolvedHotkeys },
      };
      if (field.hotkeyKey) {
        const keyChar = rawValue.trim().slice(0, 1);
        if (keyChar.length === 1) {
          next.hotkeys = {
            ...resolvedHotkeys,
            [field.hotkeyKey]: keyChar,
          };
        }
      } else if (field.key) {
        const trimmed = rawValue.trim();
        if (field.isNumeric) {
          const parsed = Number(trimmed);
          if (!Number.isNaN(parsed) && parsed > 0) {
            (next as unknown as Record<string, unknown>)[field.key] = Math.round(parsed);
          }
        } else if (trimmed.length > 0) {
          (next as unknown as Record<string, unknown>)[field.key] = trimmed;
        }
      }
      onChange(next);
    }
    updateEditing(false);
  };

  useInput(
    (input, key) => {
      if (isEditing) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(SETTING_FIELDS.length - 1, prev + 1));
      } else if (key.return || input === 'e' || input === ' ') {
        const field = SETTING_FIELDS[selectedIndex];
        if (!field) return;
        if (field.isVisibilityCycle) {
          onChange({
            ...settings,
            hotkeys: { ...resolvedHotkeys },
            modelDetailVisibility: cycleModelDetailVisibility(currentVisibility),
          });
          return;
        }
        if (input === ' ') return;
        setDraftVal(field.hotkeyKey ? resolvedHotkeys[field.hotkeyKey] : String(settings[field.key!] ?? ''));
        updateEditing(true);
      } else if (input === 'r') {
        onChange({
          ...DEFAULT_APP_TEST_SETTINGS,
          hotkeys: { ...DEFAULT_MODEL_LIST_HOTKEYS },
        });
      }
    },
    { isActive: !isEditing }
  );

  const innerWidth = Math.max(40, columns - 2);
  const leftColWidth = Math.min(54, Math.max(32, Math.floor(innerWidth * 0.48)));
  const activeField = SETTING_FIELDS[selectedIndex];
  const bottomBarRows = isEditing ? BOTTOM_TEXT_EDITOR_HEIGHT : 0;
  const maxVisibleRows = Math.max(3, Math.floor((contentHeight - 7 - bottomBarRows) / 2));
  const { startIndex, endIndex, hasMoreAbove, hasMoreBelow } = computeScrollWindow(
    SETTING_FIELDS.length,
    selectedIndex,
    maxVisibleRows
  );
  const visibleFields = SETTING_FIELDS.slice(startIndex, endIndex);

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
          flexDirection={isNarrowTerminal(columns) ? 'column' : 'row'}
          justifyContent="space-between"
          width={innerWidth}
          flexShrink={0}
        >
          <Box overflowX="hidden">
            <Text bold color="cyan" wrap="truncate-end">
              ⚙ App & Model Test Configuration (llama cli Runner)
            </Text>
          </Box>
          <Box flexShrink={isNarrowTerminal(columns) ? 1 : 0} overflowX="hidden">
            <Text color="gray" wrap="truncate-end">
              [↑/↓] Select │ [Enter/e] Edit in Bottom Bar │ [r] Reset Defaults
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1} width={innerWidth} overflowX="hidden">
          {hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↑ ({startIndex} more setting(s) above)
            </Text>
          )}
          {visibleFields.map((field, localIdx) => {
            const idx = startIndex + localIdx;
            const isSelected = idx === selectedIndex;
            const isEditingThis = isSelected && isEditing;
            const val = getFieldDisplayValue(field);

            return (
              <Box
                key={field.id}
                flexDirection="column"
                paddingX={1}
                marginBottom={1}
                width={innerWidth}
                overflowX="hidden"
              >
                <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
                  <Box width={leftColWidth} overflowX="hidden" flexShrink={0}>
                    <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} wrap="truncate-end">
                      {isSelected ? '❯ ' : '  '}
                      {field.label}:{' '}
                    </Text>
                    {isEditingThis ? (
                      <Text color="yellow" bold wrap="truncate-end">
                        (editing in bottom bar…)
                      </Text>
                    ) : (
                      <Text color="green" bold wrap="truncate-end">
                        {truncateMiddle(val, Math.max(12, leftColWidth - field.label.length - 6))}
                      </Text>
                    )}
                  </Box>
                  <Box flexGrow={1} overflowX="hidden">
                    <Text color="gray" wrap="truncate-end">
                      {field.description}
                    </Text>
                  </Box>
                </Box>
              </Box>
            );
          })}
          {hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↓ ({SETTING_FIELDS.length - endIndex} more setting(s) below)
            </Text>
          )}

          {!isEditing && (
            <Box
              borderStyle="round"
              borderColor="gray"
              paddingX={1}
              flexDirection="column"
              width={innerWidth}
              overflowX="hidden"
            >
              <Text bold color="yellow" wrap="truncate-end">
                ℹ How Model Configuration Testing Works:
              </Text>
              <Text color="gray" wrap="truncate-end">
                • Inside any model configuration editor (Tab 3), press [t] (&quot;Try Configuration&quot;) to run this command.
              </Text>
              <Text color="gray" wrap="truncate-end">
                • All active [*] Common Settings and model-specific flags (model, mmproj, model-draft, ngl, ctx-size, etc.) are passed.
              </Text>
              <Text color="gray" wrap="truncate-end">
                • The spawned child process is tracked by its exact PID and closed immediately once the response or error is returned.
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {isEditing && activeField && (
        <BottomTextEditorBar
          label={activeField.label}
          initialValue={draftVal}
          placeholder={activeField.description}
          columns={columns}
          onSubmit={commitFieldEdit}
          onCancel={() => updateEditing(false)}
        />
      )}
    </Box>
  );
};
