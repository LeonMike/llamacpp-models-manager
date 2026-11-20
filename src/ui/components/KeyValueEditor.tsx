import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  isValuelessFlag,
  VALUELESS_FLAG_MARKER,
} from '../../types/index.js';
import { computeScrollWindow, isNarrowTerminal, truncateMiddle } from '../hooks/useTerminalSize.js';
import {
  BOTTOM_TEXT_EDITOR_HEIGHT,
  BottomTextEditorBar,
} from './BottomTextEditorBar.js';

export interface KeyValueEditorProps {
  pairs: Record<string, string>;
  inheritedPairs?: Record<string, string>;
  onChange: (updated: Record<string, string>) => void;
  isFocused: boolean;
  onFocusChange?: (editingText: boolean) => void;
  maxRows?: number;
  maxCols?: number;
}

type Mode =
  | 'list'
  | 'select-flag-type'
  | 'add-key'
  | 'add-value'
  | 'edit-value'
  | 'edit-key';

type CustomFlagKind = 'with-value' | 'toggle-only';

export const KeyValueEditor: React.FC<KeyValueEditorProps> = ({
  pairs,
  inheritedPairs = {},
  onChange,
  isFocused,
  onFocusChange,
  maxRows = 15,
  maxCols = 100,
}) => {
  const entries = Object.entries(pairs);
  const inheritedOnlyEntries = Object.entries(inheritedPairs).filter(
    ([k]) => !(k in pairs)
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [flagKind, setFlagKind] = useState<CustomFlagKind>('with-value');
  const [draftKey, setDraftKey] = useState('');
  const [originalKey, setOriginalKey] = useState('');
  const [draftValue, setDraftValue] = useState('');

  const setEditorMode = (nextMode: Mode) => {
    setMode(nextMode);
    onFocusChange?.(nextMode !== 'list');
  };

  useInput(
    (input, key) => {
      if (!isFocused) return;

      if (mode === 'select-flag-type') {
        if (key.escape || input === 'q') {
          setEditorMode('list');
          return;
        }
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || input === ' ') {
          setFlagKind((prev) => (prev === 'with-value' ? 'toggle-only' : 'with-value'));
          return;
        }
        if (input === '1') {
          setFlagKind('with-value');
          setEditorMode('add-key');
          return;
        }
        if (input === '2') {
          setFlagKind('toggle-only');
          setEditorMode('add-key');
          return;
        }
        if (key.return) {
          setEditorMode('add-key');
          return;
        }
        return;
      }

      if (mode !== 'list') return;

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.max(0, entries.length - 1), prev + 1));
      } else if (input === 'a') {
        setDraftKey('');
        setDraftValue('');
        setFlagKind('with-value');
        setEditorMode('select-flag-type');
      } else if (input === ' ' && entries.length > 0) {
        // Space toggles an existing custom flag between "Straight-forward Toggle Flag" and "Key = Value Flag"
        const [k, v] = entries[selectedIndex] ?? ['', ''];
        if (k) {
          if (isValuelessFlag(v)) {
            setDraftKey(k);
            setDraftValue('');
            setEditorMode('edit-value');
          } else {
            const next = { ...pairs, [k]: VALUELESS_FLAG_MARKER };
            onChange(next);
          }
        }
      } else if ((key.return || input === 'e') && entries.length > 0) {
        const [k, v] = entries[selectedIndex] ?? ['', ''];
        if (k) {
          if (isValuelessFlag(v)) {
            // For a valueless toggle flag, Enter edits its flag name
            setOriginalKey(k);
            setDraftKey(k);
            setEditorMode('edit-key');
          } else {
            setDraftKey(k);
            setDraftValue(v);
            setEditorMode('edit-value');
          }
        }
      } else if ((input === 'd' || key.delete) && entries.length > 0) {
        const [k] = entries[selectedIndex] ?? [''];
        if (k) {
          const next = { ...pairs };
          delete next[k];
          onChange(next);
          setSelectedIndex((prev) => Math.max(0, Math.min(prev, Object.keys(next).length - 1)));
        }
      }
    },
    { isActive: isFocused && (mode === 'list' || mode === 'select-flag-type') }
  );

  const bottomBarRows =
    mode === 'select-flag-type'
      ? 5
      : mode !== 'list'
      ? BOTTOM_TEXT_EDITOR_HEIGHT
      : 0;
  const listAvailableRows = Math.max(2, maxRows - 3 - bottomBarRows);
  const { startIndex, endIndex, hasMoreAbove, hasMoreBelow } = computeScrollWindow(
    entries.length,
    selectedIndex,
    listAvailableRows
  );
  const visibleEntries = entries.slice(startIndex, endIndex);
  const maxValWidth = Math.max(20, maxCols - 42);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={maxCols}
      height={maxRows}
      justifyContent="space-between"
      overflowX="hidden"
      overflowY="hidden"
    >
      <Box flexDirection="column" width={maxCols - 2} overflowX="hidden">
        <Box justifyContent="space-between" width={maxCols - 2}>
          <Text bold color="cyan" wrap="truncate-end">
            Custom Flags ({entries.length})
          </Text>
          <Text color="gray" wrap="truncate-end">
            [a] Add Flag │ [Enter/e] Edit │ [Space] Switch Type (Value ↔ Toggle) │ [d] Delete
          </Text>
        </Box>

        {hasMoreAbove && (
          <Text color="gray" dimColor wrap="truncate-end">
            ↑ ({startIndex} more above)
          </Text>
        )}

        {entries.length === 0 && inheritedOnlyEntries.length === 0 && mode === 'list' && (
          <Text color="gray" italic wrap="truncate-end">
            No custom flags defined. Press &apos;a&apos; to add a key=value or toggle-only llama.cpp flag.
          </Text>
        )}

        {visibleEntries.map(([k, v], localIdx) => {
          const idx = startIndex + localIdx;
          const isSelected = idx === selectedIndex && isFocused;
          const isToggleOnly = isValuelessFlag(v);
          const isEditingThis =
            (mode === 'edit-value' && draftKey === k) ||
            (mode === 'edit-key' && originalKey === k);

          return (
            <Box key={k} paddingX={1} width={maxCols - 2} overflowX="hidden">
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} wrap="truncate-end">
                {isSelected ? '❯ ' : '  '}
                {k}
              </Text>
              {isEditingThis ? (
                <Text color="yellow" bold wrap="truncate-end">
                  {' '}
                  (editing in bottom bar…)
                </Text>
              ) : isToggleOnly ? (
                <Text color="magenta" bold wrap="truncate-end">
                  {' '}
                  [Toggle Flag — passed straight-forward without value]
                </Text>
              ) : (
                <>
                  <Text color="gray"> = </Text>
                  <Text color="green" wrap="truncate-end">
                    {truncateMiddle(v, maxValWidth)}
                  </Text>
                </>
              )}
            </Box>
          );
        })}

        {inheritedOnlyEntries.map(([k, v]) => {
          const isToggleOnly = isValuelessFlag(v);
          return (
            <Box key={`inherited-${k}`} paddingX={1} width={maxCols - 2} overflowX="hidden">
              <Text color="gray" italic wrap="truncate-end">
                {'  '}
                {k}
              </Text>
              {isToggleOnly ? (
                <>
                  <Text color="cyan" italic wrap="truncate-end">
                    {' '}
                    ([Toggle Flag — no value])
                  </Text>
                  <Text color="gray" italic wrap="truncate-end">
                    {' '}← [*]
                  </Text>
                </>
              ) : (
                <>
                  <Text color="gray"> = </Text>
                  <Text color="cyan" italic wrap="truncate-end">
                    ({truncateMiddle(v, maxValWidth)})
                  </Text>
                  <Text color="gray" italic wrap="truncate-end">
                    {' '}← [*]
                  </Text>
                </>
              )}
            </Box>
          );
        })}

        {hasMoreBelow && (
          <Text color="gray" dimColor wrap="truncate-end">
            ↓ ({entries.length - endIndex} more below)
          </Text>
        )}
      </Box>

      {/* Step 1 when pressing [a]: Select whether the flag has a value or is a toggle flag passed straight-forward */}
      {mode === 'select-flag-type' && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
          width={Math.max(36, maxCols - 2)}
          flexShrink={0}
          overflowX="hidden"
        >
          <Box justifyContent="space-between" width={Math.max(32, maxCols - 6)}>
            <Text bold color="yellow" wrap="truncate-end">
              ➕ Select Custom Flag Type:
            </Text>
            {!isNarrowTerminal(maxCols) && (
              <Text color="gray" wrap="truncate-end">
                [↑/↓/Space] Choose │ [1/2/Enter] Confirm │ [Esc/q] Cancel
              </Text>
            )}
          </Box>
          <Box paddingX={1}>
            <Text
              color={flagKind === 'with-value' ? 'cyan' : 'white'}
              bold={flagKind === 'with-value'}
              wrap="truncate-end"
            >
              {flagKind === 'with-value' ? '❯ ' : '  '}
              [1] Key = Value Flag (e.g. override-kv = ..., draft-min = 5)
            </Text>
          </Box>
          <Box paddingX={1}>
            <Text
              color={flagKind === 'toggle-only' ? 'magenta' : 'white'}
              bold={flagKind === 'toggle-only'}
              wrap="truncate-end"
            >
              {flagKind === 'toggle-only' ? '❯ ' : '  '}
              [2] Toggle / Switch Flag without value (passed straight-forward, e.g. --no-webui, --no-cnv, --mlock)
            </Text>
          </Box>
        </Box>
      )}

      {mode === 'add-key' && (
        <BottomTextEditorBar
          label={
            flagKind === 'toggle-only'
              ? 'New Toggle Flag Name (no value)'
              : 'New Key=Value Flag Name'
          }
          initialValue={draftKey}
          placeholder={
            flagKind === 'toggle-only'
              ? 'e.g. no-webui, no-cnv, no-kv-offload, escape...'
              : 'e.g. cont-batching, draft-min, override-kv...'
          }
          columns={maxCols}
          onSubmit={(val) => {
            const trimmed = val.trim().replace(/^--+/, '');
            if (trimmed.length > 0) {
              if (flagKind === 'toggle-only') {
                // Save immediately as a valueless toggle flag!
                const next = { ...pairs, [trimmed]: VALUELESS_FLAG_MARKER };
                onChange(next);
                setEditorMode('list');
              } else {
                setDraftKey(trimmed);
                setEditorMode('add-value');
              }
            } else {
              setEditorMode('list');
            }
          }}
          onCancel={() => setEditorMode('list')}
        />
      )}

      {mode === 'edit-key' && (
        <BottomTextEditorBar
          label={`Rename Toggle Flag "${originalKey}"`}
          initialValue={draftKey}
          placeholder="Enter toggle flag name..."
          columns={maxCols}
          onSubmit={(val) => {
            const trimmed = val.trim().replace(/^--+/, '');
            if (trimmed.length > 0) {
              const next: Record<string, string> = {};
              for (const [k, v] of Object.entries(pairs)) {
                if (k === originalKey) {
                  next[trimmed] = VALUELESS_FLAG_MARKER;
                } else {
                  next[k] = v;
                }
              }
              onChange(next);
            }
            setEditorMode('list');
          }}
          onCancel={() => setEditorMode('list')}
        />
      )}

      {(mode === 'add-value' || mode === 'edit-value') && (
        <BottomTextEditorBar
          label={`Custom Flag "${draftKey}" Value`}
          initialValue={draftValue}
          placeholder="Enter flag value..."
          columns={maxCols}
          enablePathAutocomplete={true}
          onSubmit={(val) => {
            const next = { ...pairs, [draftKey.trim()]: val };
            onChange(next);
            setEditorMode('list');
          }}
          onCancel={() => setEditorMode('list')}
        />
      )}
    </Box>
  );
};
