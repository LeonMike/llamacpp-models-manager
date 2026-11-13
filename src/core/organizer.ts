import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  FileMoveOperation,
  OrganizationPlan,
  OrganizationResult,
  ScanResult,
} from '../types/index.js';

/**
 * Computes the target directory path for a main model file (`<root>/<family>/<modelName>/<quantization>/<fileName>`)
 * or an auxiliary file (`<root>/<family>/<modelName>/<fileName>`).
 */
export function computeTargetFilePath(
  rootDir: string,
  family: string,
  modelName: string,
  fileName: string,
  quantization?: string
): string {
  const resolvedRoot = path.resolve(rootDir);
  if (quantization) {
    return path.join(resolvedRoot, family, modelName, quantization, fileName);
  }
  return path.join(resolvedRoot, family, modelName, fileName);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a dry-run `OrganizationPlan` from a `ScanResult`.
 * - Main model shards are placed in `<rootDir>/<family>/<modelName>/<quantization>/<fileName>`.
 * - Shared `mmproj` and `mtp` files are placed in `<rootDir>/<family>/<modelName>/<fileName>`.
 */
export async function createOrganizationPlan(scanResult: ScanResult): Promise<OrganizationPlan> {
  const operations: FileMoveOperation[] = [];
  const conflicts: FileMoveOperation[] = [];
  const plannedDestinations = new Set<string>();

  for (const group of scanResult.groups) {
    // 1. Plan main model quantization variants (including all shards)
    for (const variant of group.variants) {
      for (const shardFile of variant.allShardFiles) {
        const destPath = computeTargetFilePath(
          scanResult.rootDir,
          group.family,
          group.modelName,
          shardFile.fileName,
          variant.quantization
        );
        const op = await buildMoveOperation(
          shardFile.filePath,
          destPath,
          'model',
          group.family,
          group.modelName,
          plannedDestinations,
          variant.quantization
        );
        operations.push(op);
        if (op.status === 'conflict') {
          conflicts.push(op);
        }
      }
    }

    // 2. Plan shared mmproj files at `<rootDir>/<family>/<modelName>/<fileName>`
    for (const mmproj of group.mmprojFiles) {
      const destPath = computeTargetFilePath(
        scanResult.rootDir,
        group.family,
        group.modelName,
        mmproj.fileName
      );
      const op = await buildMoveOperation(
        mmproj.filePath,
        destPath,
        'mmproj',
        group.family,
        group.modelName,
        plannedDestinations
      );
      operations.push(op);
      if (op.status === 'conflict') {
        conflicts.push(op);
      }
    }

    // 3. Plan shared mtp (`model-draft`) files at `<rootDir>/<family>/<modelName>/<fileName>`
    for (const mtp of group.mtpFiles) {
      const destPath = computeTargetFilePath(
        scanResult.rootDir,
        group.family,
        group.modelName,
        mtp.fileName
      );
      const op = await buildMoveOperation(
        mtp.filePath,
        destPath,
        'mtp',
        group.family,
        group.modelName,
        plannedDestinations
      );
      operations.push(op);
      if (op.status === 'conflict') {
        conflicts.push(op);
      }
    }
  }

  return {
    rootDir: scanResult.rootDir,
    operations,
    orphanFiles: scanResult.orphanAuxFiles,
    conflicts,
  };
}

async function buildMoveOperation(
  sourcePath: string,
  destinationPath: string,
  role: 'model' | 'mmproj' | 'mtp',
  family: string,
  modelName: string,
  plannedDestinations: Set<string>,
  quantization?: string
): Promise<FileMoveOperation> {
  const resolvedSrc = path.resolve(sourcePath);
  const resolvedDest = path.resolve(destinationPath);

  if (resolvedSrc === resolvedDest) {
    plannedDestinations.add(resolvedDest);
    return {
      sourcePath: resolvedSrc,
      destinationPath: resolvedDest,
      role,
      family,
      modelName,
      quantization,
      status: 'already-organized',
    };
  }

  // Check if another file in this plan is already targeting the same destination
  if (plannedDestinations.has(resolvedDest)) {
    return {
      sourcePath: resolvedSrc,
      destinationPath: resolvedDest,
      role,
      family,
      modelName,
      quantization,
      status: 'conflict',
      errorMessage: 'Multiple source files map to the same destination path',
    };
  }

  // Check if a different file already exists on disk at destinationPath
  if (await pathExists(resolvedDest)) {
    return {
      sourcePath: resolvedSrc,
      destinationPath: resolvedDest,
      role,
      family,
      modelName,
      quantization,
      status: 'conflict',
      errorMessage: 'Destination file already exists on disk',
    };
  }

  plannedDestinations.add(resolvedDest);
  return {
    sourcePath: resolvedSrc,
    destinationPath: resolvedDest,
    role,
    family,
    modelName,
    quantization,
    status: 'pending',
  };
}

/**
 * Executes a planned `OrganizationPlan` by moving files in-place (`fs.rename`)
 * and pruning any empty directories left behind under `plan.rootDir`.
 */
export async function executeOrganizationPlan(plan: OrganizationPlan): Promise<OrganizationResult> {
  let movedCount = 0;
  let skippedCount = 0;
  const errors: Array<{ operation: FileMoveOperation; error: string }> = [];
  const sourceDirs = new Set<string>();

  for (const op of plan.operations) {
    if (op.status === 'already-organized') {
      skippedCount++;
      continue;
    }
    if (op.status === 'conflict') {
      skippedCount++;
      errors.push({
        operation: op,
        error: op.errorMessage ?? 'Conflict prevented moving file',
      });
      continue;
    }

    try {
      const destDir = path.dirname(op.destinationPath);
      await fs.mkdir(destDir, { recursive: true });
      await fs.rename(op.sourcePath, op.destinationPath);
      op.status = 'moved';
      movedCount++;
      sourceDirs.add(path.dirname(op.sourcePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      op.status = 'error';
      op.errorMessage = message;
      errors.push({ operation: op, error: message });
    }
  }

  const removedDirsCount = await pruneEmptyDirectories(plan.rootDir, sourceDirs);

  return {
    movedCount,
    skippedCount,
    removedDirsCount,
    errors,
  };
}

/**
 * Removes empty directories starting from the deepest moved source directories up to (but not including) `rootDir`.
 */
async function pruneEmptyDirectories(rootDir: string, candidateDirs: Set<string>): Promise<number> {
  const resolvedRoot = path.resolve(rootDir);
  let removed = 0;

  // Sort deepest paths first
  const sortedDirs = Array.from(candidateDirs).sort((a, b) => b.length - a.length);

  for (const startDir of sortedDirs) {
    let current = path.resolve(startDir);
    while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
      try {
        const entries = await fs.readdir(current);
        if (entries.length === 0) {
          await fs.rmdir(current);
          removed++;
          current = path.dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  return removed;
}

