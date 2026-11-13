import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export const BOTTOM_TEXT_EDITOR_HEIGHT = 4;

export interface BottomTextEditorBarProps {
  label: string;
  initialValue: string;
  placeholder?: string;
  columns: number;
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
  onSubmit,
  onCancel,
}) => {
  const [text, setText] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);

  useEffect(() => {
    setText(initialValue);
    setCursor(initialValue.length);
  }, [initialValue, label]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
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
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setText((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
          setCursor((prev) => Math.max(0, prev - 1));
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setText((prev) => prev.slice(0, cursor) + input + prev.slice(cursor));
        setCursor((prev) => prev + input.length);
      }
    },
    { isActive: true }
  );

  const innerWidth = Math.max(30, columns - 4);
  const vp = computeTextInputViewport(text, cursor, innerWidth);

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
            [←/→] Move Cursor │ [Ctrl+A/E] Start/End │ [Ctrl+U] Clear │ [Enter] Apply │ [Esc] Cancel
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

