import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export const NARROW_TERMINAL_WIDTH = 120;

export function isNarrowTerminal(columns: number): boolean {
  return columns < NARROW_TERMINAL_WIDTH;
}

/**
 * React hook that tracks the terminal window dimensions (`columns` and `rows`)
 * and automatically updates on terminal `resize` events.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 30,
  }));

  useEffect(() => {
    if (!stdout) return;

    const handleResize = () => {
      setSize({
        columns: stdout.columns ?? 100,
        rows: stdout.rows ?? 30,
      });
    };

    handleResize();
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  return size;
}

/**
 * Computes a vertical scroll window `[startIndex, endIndex)` that keeps `selectedIndex`
 * visible within `maxVisibleItems` rows.
 */
export function computeScrollWindow(
  totalItems: number,
  selectedIndex: number,
  maxVisibleItems: number
): { startIndex: number; endIndex: number; hasMoreAbove: boolean; hasMoreBelow: boolean } {
  const visibleCount = Math.max(1, maxVisibleItems);
  if (totalItems <= visibleCount) {
    return {
      startIndex: 0,
      endIndex: totalItems,
      hasMoreAbove: false,
      hasMoreBelow: false,
    };
  }

  const half = Math.floor(visibleCount / 2);
  let startIndex = Math.max(0, selectedIndex - half);
  if (startIndex + visibleCount > totalItems) {
    startIndex = Math.max(0, totalItems - visibleCount);
  }
  const endIndex = Math.min(totalItems, startIndex + visibleCount);

  return {
    startIndex,
    endIndex,
    hasMoreAbove: startIndex > 0,
    hasMoreBelow: endIndex < totalItems,
  };
}

/**
 * Middle-truncates a long path or string so it fits within `maxLength` characters
 * without causing horizontal wrapping/scrolling.
 */
export function truncateMiddle(str: string, maxLength: number): string {
  if (maxLength <= 4) return str.slice(0, Math.max(0, maxLength));
  if (str.length <= maxLength) return str;
  const keepStart = Math.ceil((maxLength - 1) / 2);
  const keepEnd = Math.floor((maxLength - 1) / 2);
  return `${str.slice(0, keepStart)}…${str.slice(str.length - keepEnd)}`;
}

/**
 * Wraps a single line of text into one or more lines that each fit within `maxWidth` columns.
 * Used when displaying the full test command or full multi-line command output so nothing is cut off.
 */
export function wrapTextToLines(text: string, maxWidth: number): string[] {
  const safeWidth = Math.max(10, maxWidth);
  const rawLines = text.split(/\r?\n/);
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      wrapped.push('');
      continue;
    }
    if (rawLine.length <= safeWidth) {
      wrapped.push(rawLine);
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > safeWidth) {
      // Prefer breaking at the last space within safeWidth if available after 50% of width
      let breakIdx = remaining.lastIndexOf(' ', safeWidth);
      if (breakIdx < Math.floor(safeWidth * 0.5)) {
        breakIdx = safeWidth;
      }
      wrapped.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx).replace(/^\s+/, '  ');
    }
    if (remaining.length > 0) {
      wrapped.push(remaining);
    }
  }

  return wrapped.length > 0 ? wrapped : [''];
}


