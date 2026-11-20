import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PathCompletionItem {
  name: string;
  displayName: string;
  isDirectory: boolean;
  /** Replacement string for the active path token up to the cursor */
  insertValue: string;
}

export type PathAutocompleteMode = 'single-path' | 'command';

export interface ExtractedPathToken {
  prefix: string;
  tokenStart: number;
  tokenEnd: number;
}

/**
 * Extracts the active path prefix ending at `cursor` from `text`.
 * - `single-path`: treats the entire input (after any leading spaces) as one path,
 *   so paths containing spaces (e.g. `/home/user/My Models/qwen`) are preserved.
 * - `command`: extracts only the whitespace-delimited token ending at `cursor`.
 */
export function extractPathPrefixAtCursor(
  text: string,
  cursor: number,
  mode: PathAutocompleteMode = 'single-path'
): ExtractedPathToken {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, clampedCursor);

  if (mode === 'single-path') {
    const leadingSpaces = before.match(/^\s*/)?.[0].length ?? 0;
    return {
      prefix: before.slice(leadingSpaces),
      tokenStart: leadingSpaces,
      tokenEnd: clampedCursor,
    };
  }

  let tokenStart = clampedCursor;
  while (tokenStart > 0 && !/\s/.test(before[tokenStart - 1]!)) {
    tokenStart--;
  }
  return {
    prefix: before.slice(tokenStart),
    tokenStart,
    tokenEnd: clampedCursor,
  };
}

/**
 * Lists matching directories and files for a given `prefix`.
 * Directories are sorted before files, alphabetically (case-insensitive).
 * Hidden dotfiles are excluded unless the partial filename starts with `.`.
 */
export function getPathCompletions(
  prefix: string,
  options?: { baseDir?: string; maxItems?: number }
): PathCompletionItem[] {
  const baseDir = options?.baseDir ?? process.cwd();
  const maxItems = options?.maxItems ?? 200;

  if (prefix === '~') {
    return [
      {
        name: '~',
        displayName: '~/',
        isDirectory: true,
        insertValue: '~/',
      },
    ];
  }

  const lastSlash = prefix.lastIndexOf('/');
  let dirPrefix = '';
  let partialName = prefix;
  let fsDir: string;

  if (lastSlash >= 0) {
    dirPrefix = prefix.slice(0, lastSlash + 1);
    partialName = prefix.slice(lastSlash + 1);

    if (dirPrefix === '~/') {
      fsDir = os.homedir();
    } else if (dirPrefix.startsWith('~/')) {
      fsDir = path.join(os.homedir(), dirPrefix.slice(2));
    } else if (path.isAbsolute(dirPrefix)) {
      fsDir = dirPrefix;
    } else {
      fsDir = path.resolve(baseDir, dirPrefix);
    }
  } else {
    fsDir = path.resolve(baseDir);
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(fsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const includeHidden = partialName.startsWith('.');
  const partialLower = partialName.toLowerCase();
  const items: PathCompletionItem[] = [];

  for (const entry of dirents) {
    if (!includeHidden && entry.name.startsWith('.')) {
      continue;
    }
    if (partialLower && !entry.name.toLowerCase().startsWith(partialLower)) {
      continue;
    }

    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = fs.statSync(path.join(fsDir, entry.name)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }

    items.push({
      name: entry.name,
      displayName: isDirectory ? `${entry.name}/` : entry.name,
      isDirectory,
      insertValue: `${dirPrefix}${entry.name}${isDirectory ? '/' : ''}`,
    });
  }

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return items.slice(0, maxItems);
}

/**
 * Applies a selected `PathCompletionItem` into `text` at the extracted token range.
 */
export function applyPathCompletion(
  text: string,
  token: ExtractedPathToken,
  item: PathCompletionItem
): { nextText: string; nextCursor: number } {
  const nextText =
    text.slice(0, token.tokenStart) + item.insertValue + text.slice(token.tokenEnd);
  const nextCursor = token.tokenStart + item.insertValue.length;
  return { nextText, nextCursor };
}
