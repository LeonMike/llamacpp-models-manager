import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  applyPathCompletion,
  extractPathPrefixAtCursor,
  getPathCompletions,
  PathAutocompleteMode,
} from '../../core/path-autocomplete.js';
import { computeScrollWindow, truncateMiddle } from '../hooks/useTerminalSize.js';

export const BOTTOM_TEXT_EDITOR_HEIGHT = 4;
const MAX_VISIBLE_AUTOCOMPLETE_ITEMS = 6;
const DOUBLE_TAB_WINDOW_MS = 800;

export interface BottomTextEditorBarProps {
  label: string;
  initialValue: string;
  placeholder?: string;
  columns: number;
  enablePathAutocomplete?: boolean;
  pathAutocompleteMode?: PathAutocompleteMode;
  pathBaseDir?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Computes a horizontal slice of `value` around `cursorPos` so the user can see
 * and edit long string values (paths, prompts, commands, templates) within `maxWidth` columns.
 */
export function computeTextInputViewport(
  value: string,
  cursorPos: number,
  maxWidth: number
): {
  beforeCursor: string;
  cursorChar: string;
  afterCursor: string;
  hasLeftOverflow: boolean;
  hasRightOverflow: boolean;
} {
  const safeWidth = Math.max(8, maxWidth - 4); // Reserve space for overflow indicators ‹ ›
  const clampedCursor = Math.max(0, Math.min(cursorPos, value.length));

  // Total characters including the cursor block at the end
  const totalLen = value.length + 1;

  let start = 0;
  if (totalLen > safeWidth) {
    // Keep cursor roughly 2/3 into the visible window when scrolling right
    const targetOffset = Math.floor(safeWidth * 0.65);
    start = Math.max(0, clampedCursor - targetOffset);
    if (start + safeWidth > totalLen) {
      start = Math.max(0, totalLen - safeWidth);
    }
  }

  const end = Math.min(value.length, start + safeWidth - 1);
  const beforeCursor = value.slice(start, clampedCursor);
  const cursorChar = clampedCursor < value.length ? value[clampedCursor] : ' ';
  const afterCursor =
    clampedCursor < end ? value.slice(clampedCursor + 1, end + 1) : '';

  return {
    beforeCursor,
    cursorChar,
    afterCursor,
    hasLeftOverflow: start > 0,
    hasRightOverflow: end < value.length,
  };
}

export const BottomTextEditorBar: React.FC<BottomTextEditorBarProps> = ({
  label,
  initialValue,
  placeholder,
  columns,
  enablePathAutocomplete = false,
  pathAutocompleteMode = 'single-path',
  pathBaseDir,
  onSubmit,
  onCancel,
}) => {
  const [text, setText] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lastTabTimeRef = useRef<number>(0);

  useEffect(() => {
    setText(initialValue);
    setCursor(initialValue.length);
    setAutocompleteOpen(false);
    setSelectedIndex(0);
    lastTabTimeRef.current = 0;
  }, [initialValue, label]);

  const completionContext = useMemo(() => {
    if (!enablePathAutocomplete || !autocompleteOpen) {
      return null;
    }
    const token = extractPathPrefixAtCursor(text, cursor, pathAutocompleteMode);
    const items = getPathCompletions(token.prefix, { baseDir: pathBaseDir });
    return { token, items };
  }, [enablePathAutocomplete, autocompleteOpen, text, cursor, pathAutocompleteMode, pathBaseDir]);

  const items = completionContext?.items ?? [];
  const clampedSelectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  const acceptSelectedCompletion = () => {
    if (!completionContext || items.length === 0) {
      return false;
    }
    const chosen = items[clampedSelectedIndex];
    if (!chosen) {
      return false;
    }
    const { nextText, nextCursor } = applyPathCompletion(
      text,
      completionContext.token,
      chosen
    );
    setText(nextText);
    setCursor(nextCursor);
    setSelectedIndex(0);
    // Keep popup open when drilling into a directory; close once a file is chosen
    if (!chosen.isDirectory) {
      setAutocompleteOpen(false);
    }
    return true;
  };

  useInput(
    (input, key) => {
      if (enablePathAutocomplete && key.tab) {
        if (autocompleteOpen) {
          acceptSelectedCompletion();
          return;
        }
        const now = Date.now();
        if (now - lastTabTimeRef.current <= DOUBLE_TAB_WINDOW_MS) {
          lastTabTimeRef.current = 0;
          setAutocompleteOpen(true);
          setSelectedIndex(0);
        } else {
          lastTabTimeRef.current = now;
        }
        return;
      }

      lastTabTimeRef.current = 0;

      if (key.escape) {
        if (autocompleteOpen) {
          setAutocompleteOpen(false);
          return;
        }
        onCancel();
        return;
      }

      if (autocompleteOpen && items.length > 0) {
        if (key.upArrow) {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return;
        }
      }

      if (key.return) {
        if (autocompleteOpen && items.length > 0) {
          acceptSelectedCompletion();
          return;
        }
        onSubmit(text);
        return;
      }
      if (key.leftArrow) {
        setCursor((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((prev) => Math.min(text.length, prev + 1));
        return;
      }
      // Ctrl+A -> Home (start of string)
      if (key.ctrl && input === 'a') {
        setCursor(0);
        return;
      }
      // Ctrl+E -> End (end of string)
      if (key.ctrl && input === 'e') {
        setCursor(text.length);
        return;
      }
      // Ctrl+U -> Clear entire string
      if (key.ctrl && input === 'u') {
        setText('');
        setCursor(0);
        setAutocompleteOpen(false);
        setSelectedIndex(0);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          const nextText = text.slice(0, cursor - 1) + text.slice(cursor);
          const nextCursor = Math.max(0, cursor - 1);
          setText(nextText);
          setCursor(nextCursor);
          if (autocompleteOpen) {
            if (nextCursor === 0 && nextText.length === 0) {
              setAutocompleteOpen(false);
            }
            setSelectedIndex(0);
          }
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const nextText = text.slice(0, cursor) + input + text.slice(cursor);
        const nextCursor = cursor + input.length;
        setText(nextText);
        setCursor(nextCursor);
        if (enablePathAutocomplete) {
          if (input.includes('/')) {
            setAutocompleteOpen(true);
            setSelectedIndex(0);
          } else if (autocompleteOpen) {
            setSelectedIndex(0);
          }
        }
      }
    },
    { isActive: true }
  );

  const innerWidth = Math.max(30, columns - 4);
  const vp = computeTextInputViewport(text, cursor, innerWidth);
  const cursorCol = (vp.hasLeftOverflow ? 2 : 0) + vp.beforeCursor.length;
  const popupWidth = Math.min(56, Math.max(30, innerWidth));
  const innerPopupWidth = Math.max(20, popupWidth - 4);
  const floatingLeft = Math.min(cursorCol, Math.max(0, innerWidth - popupWidth));
  const scrollWin = computeScrollWindow(
    items.length,
    clampedSelectedIndex,
    MAX_VISIBLE_AUTOCOMPLETE_ITEMS
  );
  const visibleItems = items.slice(scrollWin.startIndex, scrollWin.endIndex);
  const popupHeight =
    3 +
    (scrollWin.hasMoreAbove ? 1 : 0) +
    (items.length === 0 ? 1 : visibleItems.length) +
    (scrollWin.hasMoreBelow ? 1 : 0);

  const hintText = autocompleteOpen
    ? '[↑/↓] Select │ [Tab/Enter] Pick │ [Esc] Close List'
    : enablePathAutocomplete
    ? '[/ or Tab×2] Path List │ [←/→] Move │ [Enter] Apply │ [Esc] Cancel'
    : '[←/→] Move Cursor │ [Ctrl+A/E] Start/End │ [Ctrl+U] Clear │ [Enter] Apply │ [Esc] Cancel';

  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
      width={Math.max(36, columns - 2)}
      height={BOTTOM_TEXT_EDITOR_HEIGHT}
      flexShrink={0}
      overflowX="hidden"
    >
      {enablePathAutocomplete && autocompleteOpen && (
        <Box
          position="absolute"
          marginTop={-popupHeight}
          marginLeft={floatingLeft}
          width={popupWidth}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="cyan" wrap="truncate-end">
            {truncateMiddle(
              `Paths (${items.length}) — ${completionContext?.token.prefix || '.'}`,
              innerPopupWidth
            ).padEnd(innerPopupWidth, ' ')}
          </Text>
          {scrollWin.hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              {`↑ (${scrollWin.startIndex} more above)`.padEnd(innerPopupWidth, ' ')}
            </Text>
          )}
          {items.length === 0 ? (
            <Text color="gray" italic wrap="truncate-end">
              {'(no matching files or directories)'.padEnd(innerPopupWidth, ' ')}
            </Text>
          ) : (
            visibleItems.map((item, localIdx) => {
              const idx = scrollWin.startIndex + localIdx;
              const isSelected = idx === clampedSelectedIndex;
              const prefix = isSelected ? '▸ ' : '  ';
              const rowText = truncateMiddle(
                `${prefix}${item.displayName}`,
                innerPopupWidth
              ).padEnd(innerPopupWidth, ' ');

              return (
                <Text
                  key={`${item.name}-${idx}`}
                  backgroundColor={isSelected ? 'cyan' : undefined}
                  color={isSelected ? 'black' : item.isDirectory ? 'cyan' : 'white'}
                  bold={isSelected || item.isDirectory}
                  wrap="truncate-end"
                >
                  {rowText}
                </Text>
              );
            })
          )}
          {scrollWin.hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              {`↓ (${items.length - scrollWin.endIndex} more below)`.padEnd(
                innerPopupWidth,
                ' '
              )}
            </Text>
          )}
        </Box>
      )}

      <Box justifyContent="space-between" width={innerWidth} overflowX="hidden">
        <Box gap={1} overflowX="hidden">
          <Text bold color="yellow" wrap="truncate-end">
            ✎ Editing {label}
          </Text>
          <Text color="gray" wrap="truncate-end">
            (len: {text.length}, pos: {cursor})
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color="gray" wrap="truncate-end">
            {hintText}
          </Text>
        </Box>
      </Box>

      <Box width={innerWidth} overflowX="hidden">
        {text.length === 0 && placeholder ? (
          <Text>
            <Text color="black" backgroundColor="yellow" bold>
              {' '}
            </Text>
            <Text color="gray" italic wrap="truncate-end">
              {placeholder}
            </Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            {vp.hasLeftOverflow && (
              <Text color="yellow" bold>
                ‹{' '}
              </Text>
            )}
            <Text color="green">{vp.beforeCursor}</Text>
            <Text color="black" backgroundColor="yellow" bold>
              {vp.cursorChar}
            </Text>
            <Text color="green">{vp.afterCursor}</Text>
            {vp.hasRightOverflow && (
              <Text color="yellow" bold>
                {' '}›
              </Text>
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
};

