import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPathCompletion,
  extractPathPrefixAtCursor,
  getPathCompletions,
} from '../src/core/path-autocomplete.js';

describe('path-autocomplete', () => {
  it('extracts path prefixes at cursor in single-path and command modes', () => {
    const pathStr = '/home/user/My Models/qw';
    const single = extractPathPrefixAtCursor(pathStr, pathStr.length, 'single-path');
    expect(single).toEqual({
      prefix: pathStr,
      tokenStart: 0,
      tokenEnd: pathStr.length,
    });

    const cmd = extractPathPrefixAtCursor('llama-server --model /tmp/mo', 28, 'command');
    expect(cmd).toEqual({
      prefix: '/tmp/mo',
      tokenStart: 21,
      tokenEnd: 28,
    });
  });

  it('lists directories before files, filters by prefix, and hides dotfiles unless requested', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-path-ac-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'models'));
      await fs.mkdir(path.join(tmpDir, 'AlphaDir'));
      await fs.mkdir(path.join(tmpDir, '.hidden-dir'));
      await fs.writeFile(path.join(tmpDir, 'qwen-7b.gguf'), '');
      await fs.writeFile(path.join(tmpDir, 'mmproj-qwen.gguf'), '');
      await fs.writeFile(path.join(tmpDir, '.secret.gguf'), '');

      const allVisible = getPathCompletions(`${tmpDir}/`);
      expect(allVisible.map((i) => i.displayName)).toEqual([
        'AlphaDir/',
        'models/',
        'mmproj-qwen.gguf',
        'qwen-7b.gguf',
      ]);
      expect(allVisible[0]?.isDirectory).toBe(true);
      expect(allVisible[2]?.isDirectory).toBe(false);

      const filtered = getPathCompletions(`${tmpDir}/qw`);
      expect(filtered.map((i) => i.displayName)).toEqual(['qwen-7b.gguf']);
      expect(filtered[0]?.insertValue).toBe(`${tmpDir}/qwen-7b.gguf`);

      const hidden = getPathCompletions(`${tmpDir}/.`);
      expect(hidden.map((i) => i.displayName)).toEqual(['.hidden-dir/', '.secret.gguf']);

      const missing = getPathCompletions(path.join(tmpDir, 'does-not-exist/'));
      expect(missing).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports relative baseDir completion (for Tab-Tab) and tilde expansion', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llamacpp-path-rel-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'sub'));
      await fs.writeFile(path.join(tmpDir, 'model.gguf'), '');

      const rel = getPathCompletions('', { baseDir: tmpDir });
      expect(rel.map((i) => i.displayName)).toEqual(['sub/', 'model.gguf']);

      const tilde = getPathCompletions('~');
      expect(tilde).toEqual([
        { name: '~', displayName: '~/', isDirectory: true, insertValue: '~/' },
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies selected completion at the token range and advances cursor', () => {
    const text = 'llama --model /tmp/mo --ctx-size 4096';
    const cursor = 21; // right after /tmp/mo
    const token = extractPathPrefixAtCursor(text, cursor, 'command');
    const result = applyPathCompletion(text, token, {
      name: 'models',
      displayName: 'models/',
      isDirectory: true,
      insertValue: '/tmp/models/',
    });
    expect(result.nextText).toBe('llama --model /tmp/models/ --ctx-size 4096');
    expect(result.nextCursor).toBe(26);
  });
});
