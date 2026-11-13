#!/usr/bin/env node
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { scanModelsDirectory } from './core/scanner.js';
import { createOrganizationPlan, executeOrganizationPlan } from './core/organizer.js';
import {
  ALL_CONFIGS_AVAILABLE_FILENAME,
  loadPresetFile,
  saveAllConfigsAvailableFile,
  savePresetFile,
  serializePresetIni,
  syncPresetWithScan,
} from './core/preset-config.js';
import { App } from './ui/App.js';
import { ActiveTab } from './ui/components/Header.js';

const program = new Command();

program
  .name('llamacpp-ui-manager')
  .description(
    'Scan and organize GGUF models (including mmproj & mtp/model-draft) and manage llama serve --models-preset files'
  )
  .version('1.0.0');

program
  .command('ui', { isDefault: true })
  .description('Launch the interactive Terminal UI (default command)')
  .option('-d, --dir <path>', 'Root directory containing GGUF models', '.')
  .option(
    '-p, --preset <path>',
    'Path to the llama serve --models-preset INI file',
    './models-preset.ini'
  )
  .option(
    '-t, --tab <tab>',
    'Initial TUI tab: models-config | common-config | scan-organize | app-settings | llama-serve',
    'models-config'
  )
  .action((opts: { dir: string; preset: string; tab: string }) => {
    const modelsDir = path.resolve(opts.dir);
    const presetPath = path.resolve(opts.preset);
    const validTabs: ActiveTab[] = [
      'models-config',
      'common-config',
      'scan-organize',
      'app-settings',
      'llama-serve',
    ];
    const initialTab: ActiveTab = validTabs.includes(opts.tab as ActiveTab)
      ? (opts.tab as ActiveTab)
      : 'models-config';

    render(<App modelsDir={modelsDir} presetPath={presetPath} initialTab={initialTab} />);
  });

program
  .command('scan')
  .description('Scan a directory tree for GGUF models, mmproj, and mtp files and print summary')
  .argument('[dir]', 'Root directory containing GGUF models', '.')
  .option('--json', 'Output scan result as JSON', false)
  .action(async (dir: string, opts: { json: boolean }) => {
    const rootDir = path.resolve(dir);
    const result = await scanModelsDirectory(rootDir);

    if (opts.json) {
      console.log(
        JSON.stringify(
          result,
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
          2
        )
      );
      return;
    }

    console.log(`Scanned directory: ${result.rootDir}`);
    console.log(
      `Found ${result.files.length} GGUF file(s) grouped into ${result.groups.length} model family group(s).\n`
    );

    for (const group of result.groups) {
      console.log(`[${group.family}] ${group.modelName}`);
      for (const variant of group.variants) {
        const shardNote =
          variant.allShardFiles.length > 1 ? ` (${variant.allShardFiles.length} shards)` : '';
        console.log(
          `  • Quant ${variant.quantization.padEnd(8)} -> ${variant.primaryFile.fileName}${shardNote}  [section: ${variant.id}]`
        );
      }
      for (const mm of group.mmprojFiles) {
        console.log(`  • Shared mmproj    -> ${mm.fileName}`);
      }
      for (const mtp of group.mtpFiles) {
        console.log(`  • Shared mtp/draft -> ${mtp.fileName}`);
      }
      console.log('');
    }

    if (result.orphanAuxFiles.length > 0) {
      console.log('Unpaired Auxiliary Files:');
      for (const orf of result.orphanAuxFiles) {
        console.log(`  • [${orf.role}] ${orf.filePath}`);
      }
    }
  });

program
  .command('organize')
  .description(
    'Preview (dry-run) and organize GGUF files into <family>/<model-name>/<quantization>/ with shared mmproj & mtp'
  )
  .argument('[dir]', 'Root directory containing GGUF models', '.')
  .option('--dry-run', 'Show planned file moves without modifying disk', false)
  .option('-y, --yes', 'Execute planned file moves without interactive confirmation prompt', false)
  .action(async (dir: string, opts: { dryRun: boolean; yes: boolean }) => {
    const rootDir = path.resolve(dir);
    const scanResult = await scanModelsDirectory(rootDir);
    const plan = await createOrganizationPlan(scanResult);

    const pending = plan.operations.filter((op) => op.status === 'pending');
    const organized = plan.operations.filter((op) => op.status === 'already-organized');

    console.log(`Organization Plan for: ${plan.rootDir}`);
    console.log(
      `Total files: ${plan.operations.length} | Pending moves: ${pending.length} | Already organized: ${organized.length} | Conflicts: ${plan.conflicts.length}\n`
    );

    for (const op of plan.operations) {
      const relSrc = path.relative(rootDir, op.sourcePath);
      const relDest = path.relative(rootDir, op.destinationPath);
      if (op.status === 'already-organized') {
        console.log(`  [OK]       (${op.role}) ${relSrc}`);
      } else if (op.status === 'conflict') {
        console.log(`  [CONFLICT] (${op.role}) ${relSrc} -> ${relDest} (${op.errorMessage})`);
      } else {
        console.log(`  [MOVE]     (${op.role}) ${relSrc} -> ${relDest}`);
      }
    }

    if (opts.dryRun || pending.length === 0) {
      if (pending.length === 0) {
        console.log('\nAll paired GGUF files are already organized.');
      } else {
        console.log('\nDry-run complete. Re-run without --dry-run to move files.');
      }
      return;
    }

    if (!opts.yes) {
      const rl = readline.createInterface({ input, output });
      const answer = await rl.question(
        `\nProceed with moving ${pending.length} file(s) in-place? [y/N]: `
      );
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log('Aborted.');
        return;
      }
    }

    const result = await executeOrganizationPlan(plan);
    console.log(
      `\nDone: ${result.movedCount} moved, ${result.skippedCount} skipped, ${result.removedDirsCount} empty directories removed.`
    );
    if (result.errors.length > 0) {
      console.error('Errors encountered:');
      for (const e of result.errors) {
        console.error(`  • ${e.operation.sourcePath}: ${e.error}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command('generate-preset')
  .description(
    'Generate or update a llama serve --models-preset INI configuration file from discovered models'
  )
  .argument('[dir]', 'Root directory containing GGUF models', '.')
  .option(
    '-o, --output <file>',
    'Output path for the models-preset INI file',
    './models-preset.ini'
  )
  .option(
    '--organized-paths',
    'Emit target organized paths (<family>/<model>/<quant>) even if files have not been moved yet',
    false
  )
  .option('--stdout', 'Print generated INI to stdout instead of writing to disk', false)
  .action(
    async (
      dir: string,
      opts: { output: string; organizedPaths: boolean; stdout: boolean }
    ) => {
      const rootDir = path.resolve(dir);
      const outputPath = path.resolve(opts.output);

      const scanResult = await scanModelsDirectory(rootDir);
      const existingDoc = await loadPresetFile(outputPath);
      const syncedDoc = syncPresetWithScan(scanResult, existingDoc, {
        useOrganizedPaths: opts.organizedPaths,
      });

      if (opts.stdout) {
        process.stdout.write(serializePresetIni(syncedDoc));
        return;
      }

      await Promise.all([
        savePresetFile(outputPath, syncedDoc, { excludeDisabled: true }),
        saveAllConfigsAvailableFile(rootDir, syncedDoc),
      ]);
      console.log(
        `Generated preset file with ${Object.keys(syncedDoc.models).length} model section(s) at: ${outputPath}`
      );
      console.log(`Saved all configurations to: ${path.join(rootDir, ALL_CONFIGS_AVAILABLE_FILENAME)}`);
      console.log(`Run with: llama serve --models-preset ${outputPath}`);
    }
  );

await program.parseAsync(process.argv);

