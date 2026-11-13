import { describe, expect, it } from 'vitest';
import {
  computeScrollWindow,
  truncateMiddle,
  wrapTextToLines,
} from '../src/ui/hooks/useTerminalSize.js';
import { computeTextInputViewport } from '../src/ui/components/BottomTextEditorBar.js';

describe('UI viewport & vertical scrolling helpers', () => {
  it('returns the full range when totalItems fits within maxVisibleItems', () => {
    const win = computeScrollWindow(5, 2, 10);
    expect(win).toEqual({
      startIndex: 0,
      endIndex: 5,
      hasMoreAbove: false,
      hasMoreBelow: false,
    });
  });

  it('centers the selectedIndex and reports hasMoreAbove / hasMoreBelow when scrolling vertically', () => {
    // At top of list
    const topWin = computeScrollWindow(20, 0, 6);
    expect(topWin).toEqual({
      startIndex: 0,
      endIndex: 6,
      hasMoreAbove: false,
      hasMoreBelow: true,
    });

    // In middle of list
    const midWin = computeScrollWindow(20, 10, 6);
    expect(midWin).toEqual({
      startIndex: 7,
      endIndex: 13,
      hasMoreAbove: true,
      hasMoreBelow: true,
    });

    // At bottom of list
    const bottomWin = computeScrollWindow(20, 19, 6);
    expect(bottomWin).toEqual({
      startIndex: 14,
      endIndex: 20,
      hasMoreAbove: true,
      hasMoreBelow: false,
    });
  });

  it('middle-truncates long paths so horizontal lines never overflow the terminal width', () => {
    const shortStr = '/models/qwen2/model.gguf';
    expect(truncateMiddle(shortStr, 30)).toBe(shortStr);

    const longStr = '/home/user/models/qwen2/Qwen2.5-VL-7B-Instruct/Q4_K_M/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf';
    const truncated = truncateMiddle(longStr, 35);
    expect(truncated.length).toBe(35);
    expect(truncated).toContain('…');
    expect(truncated.startsWith('/home/user/models')).toBe(true);
    expect(truncated.endsWith('-Q4_K_M.gguf')).toBe(true);
  });

  it('computes a horizontal sliding viewport around cursorPos for BottomTextEditorBar when editing long strings', () => {
    const longPath =
      '/home/ronny/models/qwen3/Qwen3-30B-A3B-Instruct/Q4_K_M/Qwen3-30B-A3B-Instruct-Q4_K_M.gguf';

    // Cursor at end of long string in a 40-column bar
    const endVp = computeTextInputViewport(longPath, longPath.length, 40);
    expect(endVp.hasLeftOverflow).toBe(true);
    expect(endVp.hasRightOverflow).toBe(false);
    expect(endVp.beforeCursor.endsWith('Instruct-Q4_K_M.gguf')).toBe(true);
    expect(endVp.cursorChar).toBe(' ');

    // Cursor at start of long string
    const startVp = computeTextInputViewport(longPath, 0, 40);
    expect(startVp.hasLeftOverflow).toBe(false);
    expect(startVp.hasRightOverflow).toBe(true);
    expect(startVp.cursorChar).toBe('/');
    expect(startVp.afterCursor.startsWith('home/ronny/models')).toBe(true);
  });

  it('wraps long command lines and output lines into multiline arrays so no text is truncated', () => {
    const longCmd =
      'Cmd: llama cli --jinja --model /models/qwen3/Qwen3-30B-A3B/Q4_K_M/Qwen3-30B-A3B-Q4_K_M.gguf --n-gpu-layers 99 --n-cpu-moe 8 -p "why is the sky blue?" --single-turn';
    const lines = wrapTextToLines(longCmd, 50);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => l.length <= 50)).toBe(true);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('--n-cpu-moe 8');
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('--single-turn');
  });
});
