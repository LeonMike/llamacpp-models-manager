import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ModelGroup,
  QuantizedModelVariant,
  ScannedGgufFile,
  ScanResult,
} from '../types/index.js';
import { inspectGgufFile } from './gguf-parser.js';

/**
 * Recursively finds all `.gguf` files under `rootDir`.
 */
export async function findGgufFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        results.push(fullPath);
      }
    }
  }

  await walk(path.resolve(rootDir));
  return results.sort();
}

/**
 * Normalizes a string for fuzzy model-name comparison (lowercase alphanumeric only).
 */
function normalizeKey(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tokenizes a model name into meaningful lowercase tokens for similarity scoring.
 */
function tokenizeName(str: string): string[] {
  return str
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 0 && !['gguf', 'model', 'mmproj', 'mtp', 'draft', 'projector'].includes(t));
}

/**
 * Computes a similarity score between an auxiliary file (`mmproj` or `mtp`) and a `ModelGroup`.
 */
function scoreAuxMatch(aux: ScannedGgufFile, group: ModelGroup): number {
  let score = 0;

  const auxNorm = normalizeKey(aux.modelName);
  const groupNorm = normalizeKey(group.modelName);

  // Exact normalized modelName match is highest confidence
  if (auxNorm.length > 0 && auxNorm === groupNorm) {
    score += 100;
  } else if (auxNorm.length > 2 && (groupNorm.includes(auxNorm) || auxNorm.includes(groupNorm))) {
    score += 60;
  }

  // Token overlap
  const auxTokens = tokenizeName(aux.modelName);
  const groupTokens = new Set(tokenizeName(group.modelName));
  let matchedTokens = 0;
  for (const t of auxTokens) {
    if (groupTokens.has(t)) {
      matchedTokens++;
    }
  }
  if (auxTokens.length > 0) {
    score += Math.round((matchedTokens / Math.max(auxTokens.length, groupTokens.size)) * 50);
  }

  // Family match bonus
  if (aux.family !== 'other' && aux.family === group.family) {
    score += 15;
  }

  // Directory proximity bonus: if the aux file is in the same directory or parent directory of any variant
  const auxDir = path.dirname(aux.filePath);
  for (const variant of group.variants) {
    const varDir = path.dirname(variant.primaryFile.filePath);
    if (auxDir === varDir || auxDir === path.dirname(varDir)) {
      score += 35;
      break;
    }
  }

  return score;
}

/**
 * Scans a directory tree, inspects all `.gguf` files, groups main models by
 * `<family>/<modelName>/<quantization>`, and pairs `mmproj` and `mtp` files with their parent model group.
 */
export async function scanModelsDirectory(rootDir: string): Promise<ScanResult> {
  const resolvedRoot = path.resolve(rootDir);
  const filePaths = await findGgufFiles(resolvedRoot);
  const files: ScannedGgufFile[] = [];

  for (const fp of filePaths) {
    const inspected = await inspectGgufFile(fp);
    files.push(inspected);
  }

  const mainFiles = files.filter((f) => f.role === 'model');
  const auxFiles = files.filter((f) => f.role === 'mmproj' || f.role === 'mtp');

  // Group main model files by (family + normalized modelName)
  const groupMap = new Map<string, { family: string; modelName: string; files: ScannedGgufFile[] }>();

  for (const file of mainFiles) {
    const groupKey = `${file.family.toLowerCase()}::${normalizeKey(file.modelName)}`;
    const existing = groupMap.get(groupKey);
    if (existing) {
      existing.files.push(file);
    } else {
      groupMap.set(groupKey, {
        family: file.family,
        modelName: file.modelName,
        files: [file],
      });
    }
  }

  const groups: ModelGroup[] = [];
  const usedVariantIds = new Set<string>();

  for (const { family, modelName, files: groupFiles } of groupMap.values()) {
    // Sub-group by quantization to collect multi-part shards together
    const quantMap = new Map<string, ScannedGgufFile[]>();
    for (const f of groupFiles) {
      const q = f.quantization || 'UNKNOWN';
      const list = quantMap.get(q) ?? [];
      list.push(f);
      quantMap.set(q, list);
    }

    const variants: QuantizedModelVariant[] = [];
    for (const [quantization, qFiles] of quantMap.entries()) {
      // Sort shards so shard 1 (`00001-of-XXXXX`) is first
      qFiles.sort((a, b) => {
        const idxA = a.shard?.index ?? 1;
        const idxB = b.shard?.index ?? 1;
        if (idxA !== idxB) return idxA - idxB;
        return a.fileName.localeCompare(b.fileName);
      });

      const primaryFile = qFiles[0];
      let baseId = `${modelName}-${quantization}`;
      let uniqueId = baseId;
      let counter = 2;
      while (usedVariantIds.has(uniqueId.toLowerCase())) {
        uniqueId = `${baseId}-${counter++}`;
      }
      usedVariantIds.add(uniqueId.toLowerCase());

      variants.push({
        id: uniqueId,
        family,
        modelName,
        quantization,
        primaryFile,
        allShardFiles: qFiles,
      });
    }

    variants.sort((a, b) => a.quantization.localeCompare(b.quantization));

    groups.push({
      family,
      modelName,
      variants,
      mmprojFiles: [],
      mtpFiles: [],
    });
  }

  // Sort groups deterministically by family then modelName
  groups.sort((a, b) => {
    const famCmp = a.family.localeCompare(b.family);
    return famCmp !== 0 ? famCmp : a.modelName.localeCompare(b.modelName);
  });

  // Pair auxiliary files (`mmproj` and `mtp`) to the best matching ModelGroup
  const orphanAuxFiles: ScannedGgufFile[] = [];

  for (const aux of auxFiles) {
    let bestGroup: ModelGroup | null = null;
    let bestScore = 0;

    for (const group of groups) {
      const score = scoreAuxMatch(aux, group);
      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    // Require a minimum confidence score of 35 (e.g., same directory or matching name tokens)
    if (bestGroup && bestScore >= 35) {
      // Align aux file's family & modelName with its paired group so organizer moves it cleanly
      aux.family = bestGroup.family;
      aux.modelName = bestGroup.modelName;
      if (aux.role === 'mmproj') {
        bestGroup.mmprojFiles.push(aux);
      } else {
        bestGroup.mtpFiles.push(aux);
      }
    } else {
      orphanAuxFiles.push(aux);
    }
  }

  return {
    rootDir: resolvedRoot,
    files,
    groups,
    orphanAuxFiles,
  };
}

