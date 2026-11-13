import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  AppTestSettings,
  CommonPresetConfig,
  ModelCatalogEntry,
  ModelDetailVisibilityMode,
  ModelPresetSection,
  ScanResult,
  SectionTestStatus,
} from '../../types/index.js';
import {
  buildModelCatalog,
  getSectionCombinationKey,
  getSectionsForCatalogEntry,
  hasMmproj,
  hasModelDraft,
} from '../../core/preset-config.js';
import {
  compareTokensPerSecond,
  cycleModelDetailVisibility,
  getModelAggregateTestStatus,
  getSectionTestStatus,
  getTestStatusColor,
  recordCompletedTestStatus,
  recordRunningTestStatus,
  resolveModelListHotkeys,
  RunningBatchTestController,
  startBatchModelConfigurationTest,
} from '../../core/model-tester.js';
import {
  computeScrollWindow,
  isNarrowTerminal,
  truncateMiddle,
  wrapTextToLines,
} from '../hooks/useTerminalSize.js';
import {
  BOTTOM_TEXT_EDITOR_HEIGHT,
  BottomTextEditorBar,
} from './BottomTextEditorBar.js';
import { ModelEditorView } from './ModelEditorView.js';
import { ModelProfilesBuilderView } from './ModelProfilesBuilderView.js';

export interface ModelListViewProps {
  scanResult: ScanResult;
  common: CommonPresetConfig;
  models: Record<string, ModelPresetSection>;
  disabledSectionIds?: string[];
  exportedSectionIds?: string[];
  testSettings: AppTestSettings;
  onUpdateTestSettings?: (updated: AppTestSettings) => void;
  testStatuses: Record<string, SectionTestStatus>;
  onUpdateTestStatus: (
    sectionId: string,
    statusOrUpdater:
      | SectionTestStatus
      | ((prevStatus: SectionTestStatus | undefined) => SectionTestStatus)
  ) => void;
  onToggleSectionEnabled?: (sectionId: string) => void;
  onToggleModelEnabled?: (sectionIds: string[], targetState?: boolean) => void;
  onUpdateModel: (sectionId: string, updated: ModelPresetSection) => void;
  onDeleteModel: (sectionId: string) => void;
  onEditingTextChange?: (editing: boolean) => void;
  onSubScreenChange?: (inSubScreen: boolean) => void;
  contentHeight: number;
  columns: number;
}

type NavRow =
  | {
      type: 'model-header';
      entry: ModelCatalogEntry;
      sections: ModelPresetSection[];
      isExpanded: boolean;
    }
  | {
      type: 'child-section';
      section: ModelPresetSection;
      parentEntry: ModelCatalogEntry;
      siblingCount: number;
      siblingIndex: number;
    }
  | {
      type: 'standalone-section';
      section: ModelPresetSection;
    };

export type SectionExportState = 'exported' | 'not-exported' | 'to-add' | 'to-remove';

export function getSectionExportBadge(
  sectionId: string,
  disabledSectionIds: string[],
  exportedSectionIds?: string[]
): { state: SectionExportState; symbol: string; color: string; isDisabled: boolean } {
  const isDisabled = disabledSectionIds.includes(sectionId);
  const willExport = !isDisabled;

  if (!exportedSectionIds) {
    return willExport
      ? { state: 'exported', symbol: '[✓]', color: 'green', isDisabled }
      : { state: 'not-exported', symbol: '[✗]', color: 'red', isDisabled };
  }

  const isExportedOnDisk = exportedSectionIds.includes(sectionId);
  if (isExportedOnDisk && willExport) {
    return { state: 'exported', symbol: '[✓]', color: 'green', isDisabled };
  }
  if (!isExportedOnDisk && !willExport) {
    return { state: 'not-exported', symbol: '[✗]', color: 'red', isDisabled };
  }
  if (!isExportedOnDisk && willExport) {
    return { state: 'to-add', symbol: '[+]', color: 'yellow', isDisabled };
  }
  return { state: 'to-remove', symbol: '[-]', color: '#FFA500', isDisabled };
}

export function getModelHeaderExportBadge(
  sections: ModelPresetSection[],
  disabledSectionIds: string[],
  exportedSectionIds?: string[]
): { symbol: string; color: string; isAllDisabled: boolean } {
  if (sections.length === 0) {
    return { symbol: '[✗]', color: 'red', isAllDisabled: true };
  }
  const badges = sections.map((s) =>
    getSectionExportBadge(s.sectionId, disabledSectionIds, exportedSectionIds)
  );
  const isAllDisabled = badges.every((b) => b.isDisabled);
  const firstState = badges[0]!.state;
  const allSameState = badges.every((b) => b.state === firstState);

  if (allSameState) {
    return { symbol: badges[0]!.symbol, color: badges[0]!.color, isAllDisabled };
  }
  return { symbol: '[~]', color: 'cyan', isAllDisabled };
}

export const ModelListView: React.FC<ModelListViewProps> = ({
  scanResult,
  common,
  models,
  disabledSectionIds = [],
  exportedSectionIds,
  testSettings,
  onUpdateTestSettings,
  testStatuses,
  onUpdateTestStatus,
  onToggleSectionEnabled,
  onToggleModelEnabled,
  onUpdateModel,
  onDeleteModel,
  onEditingTextChange,
  onSubScreenChange,
  contentHeight,
  columns,
}) => {
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(null);
  const [builderEntryId, setBuilderEntryIdState] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterText, setFilterText] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const hotkeys = useMemo(() => resolveModelListHotkeys(testSettings.hotkeys), [testSettings.hotkeys]);
  const detailMode: ModelDetailVisibilityMode = testSettings.modelDetailVisibility ?? 'full';

  // Batch / Multi-Configuration Test Runner Modal state
  const [isBatchModalOpen, setIsBatchModalOpenState] = useState(false);
  const [batchTitle, setBatchTitle] = useState('');
  const [batchSections, setBatchSections] = useState<ModelPresetSection[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [currentRunningIdx, setCurrentRunningIdx] = useState(0);
  const [inspectedIdx, setInspectedIdx] = useState(0);
  const [autoFollowSection, setAutoFollowSection] = useState(true);
  const [liveOutputs, setLiveOutputs] = useState<Record<string, string>>({});
  const [liveCommands, setLiveCommands] = useState<Record<string, string>>({});
  const [livePids, setLivePids] = useState<Record<string, number | undefined>>({});
  const [testScrollOffset, setTestScrollOffset] = useState(0);
  const [autoFollowLog, setAutoFollowLog] = useState(true);
  const batchControllerRef = useRef<RunningBatchTestController | null>(null);

  useEffect(() => {
    return () => {
      if (batchControllerRef.current) {
        batchControllerRef.current.abort();
        batchControllerRef.current = null;
      }
    };
  }, []);

  const syncSubScreenState = (
    nextModelId: string | null,
    nextBuilderId: string | null,
    nextFilter: string,
    nextBatchOpen: boolean
  ) => {
    onSubScreenChange?.(Boolean(nextModelId || nextBuilderId || nextFilter || nextBatchOpen));
  };

  const setSelectedModelId = (nextId: string | null) => {
    setSelectedModelIdState(nextId);
    syncSubScreenState(nextId, builderEntryId, filterText, isBatchModalOpen);
  };

  const setBuilderEntryId = (nextId: string | null) => {
    setBuilderEntryIdState(nextId);
    syncSubScreenState(selectedModelId, nextId, filterText, isBatchModalOpen);
  };

  const setIsBatchModalOpen = (nextOpen: boolean) => {
    setIsBatchModalOpenState(nextOpen);
    syncSubScreenState(selectedModelId, builderEntryId, filterText, nextOpen);
  };

  // Collapsed by default so the user sees a compact overview of models and can expand only desired models
  const [expandedVariantIds, setExpandedVariantIds] = useState<Set<string>>(() => new Set());

  const catalog = useMemo(() => buildModelCatalog(scanResult), [scanResult]);

  // All available model sections in catalog order + standalone sections
  const allOrderedSections = useMemo(() => {
    const list: ModelPresetSection[] = [];
    const seen = new Set<string>();
    for (const entry of catalog) {
      const secs = getSectionsForCatalogEntry(entry, models);
      for (const s of secs) {
        if (!seen.has(s.sectionId)) {
          seen.add(s.sectionId);
          list.push(s);
        }
      }
    }
    for (const s of Object.values(models)) {
      if (!seen.has(s.sectionId)) {
        seen.add(s.sectionId);
        list.push(s);
      }
    }
    return list;
  }, [catalog, models]);

  const startBatchTest = (title: string, targetSections: ModelPresetSection[]) => {
    if (targetSections.length === 0) return;

    if (batchControllerRef.current) {
      batchControllerRef.current.abort();
      batchControllerRef.current = null;
    }

    setBatchTitle(title);
    setBatchSections(targetSections);
    setIsBatchModalOpen(true);
    setIsBatchRunning(true);
    setCurrentRunningIdx(0);
    setInspectedIdx(0);
    setAutoFollowSection(true);
    setTestScrollOffset(0);
    setAutoFollowLog(true);
    setLiveOutputs({});
    setLiveCommands({});
    setLivePids({});

    const ctrl = startBatchModelConfigurationTest(common, targetSections, testSettings, {
      onSectionStart: (sec, idx, _total, cmdLine, pid) => {
        setCurrentRunningIdx(idx);
        setLiveCommands((prev) => ({ ...prev, [sec.sectionId]: cmdLine }));
        setLivePids((prev) => ({ ...prev, [sec.sectionId]: pid }));
        setLiveOutputs((prev) => ({
          ...prev,
          [sec.sectionId]: 'Starting llama cli test process...\n',
        }));
        onUpdateTestStatus(sec.sectionId, (prev) => recordRunningTestStatus(prev));
      },
      onSectionOutput: (sec, _idx, _total, combined) => {
        setLiveOutputs((prev) => ({ ...prev, [sec.sectionId]: combined }));
      },
      onSectionComplete: (sec, _idx, _total, res) => {
        const finalOut = res.combinedOutput || '(No output emitted)';
        setLiveOutputs((prev) => ({ ...prev, [sec.sectionId]: finalOut }));
        onUpdateTestStatus(sec.sectionId, (prev) => recordCompletedTestStatus(prev, res));
      },
    });

    batchControllerRef.current = ctrl;

    void ctrl.promise.then(() => {
      setIsBatchRunning(false);
      setAutoFollowLog(false);
      batchControllerRef.current = null;
    });
  };

  const closeBatchModal = () => {
    if (batchControllerRef.current) {
      batchControllerRef.current.abort();
      batchControllerRef.current = null;
    }
    setIsBatchRunning(false);
    setIsBatchModalOpen(false);
  };

  const toggleExpand = (variantId: string) => {
    setExpandedVariantIds((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) {
        next.delete(variantId);
      } else {
        next.add(variantId);
      }
      return next;
    });
  };

  const expandModel = (variantId: string) => {
    setExpandedVariantIds((prev) => {
      if (prev.has(variantId)) return prev;
      const next = new Set(prev);
      next.add(variantId);
      return next;
    });
  };

  const collapseModel = (variantId: string) => {
    setExpandedVariantIds((prev) => {
      if (!prev.has(variantId)) return prev;
      const next = new Set(prev);
      next.delete(variantId);
      return next;
    });
  };

  const toggleExpandAll = () => {
    setExpandedVariantIds((prev) => {
      if (prev.size >= catalog.length) {
        return new Set();
      }
      return new Set(catalog.map((c) => c.variantId));
    });
  };

  const navRows: NavRow[] = useMemo(() => {
    const rows: NavRow[] = [];
    const matchedSectionIds = new Set<string>();
    const q = filterText.trim().toLowerCase();

    for (const entry of catalog) {
      const entrySections = getSectionsForCatalogEntry(entry, models);
      for (const s of entrySections) {
        matchedSectionIds.add(s.sectionId);
      }

      const filteredSections = q
        ? entrySections.filter(
            (s) =>
              s.sectionId.toLowerCase().includes(q) ||
              s.model.toLowerCase().includes(q) ||
              entry.variantId.toLowerCase().includes(q) ||
              (s.alias && s.alias.toLowerCase().includes(q))
          )
        : entrySections;

      const matchesHeader =
        !q ||
        entry.variantId.toLowerCase().includes(q) ||
        entry.modelName.toLowerCase().includes(q) ||
        entry.family.toLowerCase().includes(q) ||
        filteredSections.length > 0;

      if (!matchesHeader) {
        continue;
      }

      // Auto-expand while actively filtering if child configurations match
      const isExpanded =
        expandedVariantIds.has(entry.variantId) || Boolean(q && filteredSections.length > 1);

      rows.push({
        type: 'model-header',
        entry,
        sections: filteredSections,
        isExpanded,
      });

      if (isExpanded && filteredSections.length > 0) {
        filteredSections.forEach((sec, idx) => {
          rows.push({
            type: 'child-section',
            section: sec,
            parentEntry: entry,
            siblingCount: filteredSections.length,
            siblingIndex: idx,
          });
        });
      }
    }

    // Include any standalone sections in `models` that weren't part of the scanned catalog
    for (const sec of Object.values(models)) {
      if (matchedSectionIds.has(sec.sectionId)) continue;
      if (
        !q ||
        sec.sectionId.toLowerCase().includes(q) ||
        sec.model.toLowerCase().includes(q) ||
        (sec.alias && sec.alias.toLowerCase().includes(q))
      ) {
        rows.push({
          type: 'standalone-section',
          section: sec,
        });
      }
    }

    return rows;
  }, [catalog, models, filterText, expandedVariantIds]);

  const setSearchMode = (active: boolean) => {
    setIsSearching(active);
    onEditingTextChange?.(active);
  };

  const innerWidth = Math.max(40, columns - 2);
  const logLineWidth = Math.max(20, innerWidth - 4);

  const effectiveInspectedIdx =
    isBatchRunning && autoFollowSection
      ? Math.min(currentRunningIdx, Math.max(0, batchSections.length - 1))
      : Math.min(inspectedIdx, Math.max(0, batchSections.length - 1));

  const inspectedSection = batchSections[effectiveInspectedIdx];
  const inspectedOutputLines = useMemo(() => {
    if (!inspectedSection) return [''];
    const secId = inspectedSection.sectionId;
    const raw =
      liveOutputs[secId] ??
      testStatuses[secId]?.lastResult?.combinedOutput ??
      '(Waiting in batch queue…)';
    return wrapTextToLines(raw, logLineWidth);
  }, [inspectedSection, liveOutputs, testStatuses, logLineWidth]);

  useInput(
    (input, key) => {
      // Handle Batch Test Runner Modal navigation
      if (isBatchModalOpen) {
        if (key.escape || input === 'q' || input === 'b' || input === 'c') {
          closeBatchModal();
          return;
        }
        if ((input === 'r' || input === 't') && !isBatchRunning && batchSections.length > 0) {
          startBatchTest(batchTitle, batchSections);
          return;
        }
        if (key.leftArrow && batchSections.length > 1) {
          setAutoFollowSection(false);
          setInspectedIdx((prev) => {
            const base = isBatchRunning && autoFollowSection ? currentRunningIdx : prev;
            return Math.max(0, base - 1);
          });
          setTestScrollOffset(0);
          setAutoFollowLog(false);
          return;
        }
        if (key.rightArrow && batchSections.length > 1) {
          setAutoFollowSection(false);
          setInspectedIdx((prev) => {
            const base = isBatchRunning && autoFollowSection ? currentRunningIdx : prev;
            return Math.min(batchSections.length - 1, base + 1);
          });
          setTestScrollOffset(0);
          setAutoFollowLog(false);
          return;
        }
        if (key.upArrow) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, inspectedOutputLines.length - 1) : prev;
            return Math.max(0, base - 1);
          });
        } else if (key.downArrow) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, inspectedOutputLines.length - 1) : prev;
            return Math.min(Math.max(0, inspectedOutputLines.length - 1), base + 1);
          });
        } else if (key.pageUp) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, inspectedOutputLines.length - 1) : prev;
            return Math.max(0, base - 10);
          });
        } else if (key.pageDown) {
          setAutoFollowLog(false);
          setTestScrollOffset((prev) => {
            const base = autoFollowLog ? Math.max(0, inspectedOutputLines.length - 1) : prev;
            return Math.min(Math.max(0, inspectedOutputLines.length - 1), base + 10);
          });
        } else if (input === 'g') {
          setAutoFollowLog(false);
          setTestScrollOffset(0);
        } else if (input === 'G') {
          setAutoFollowLog(true);
          setTestScrollOffset(Math.max(0, inspectedOutputLines.length - 1));
        }
        return;
      }

      if (selectedModelId || builderEntryId || isSearching) return;

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.max(0, navRows.length - 1), prev + 1));
      } else if (input === hotkeys.filter) {
        setSearchMode(true);
      } else if ((key.escape || input === 'q') && filterText) {
        setFilterText('');
        setSelectedIndex(0);
        syncSubScreenState(selectedModelId, builderEntryId, '', isBatchModalOpen);
      } else if (input === hotkeys.cycleDetailMode) {
        const nextMode = cycleModelDetailVisibility(detailMode);
        onUpdateTestSettings?.({
          ...testSettings,
          modelDetailVisibility: nextMode,
        });
      } else if (input === hotkeys.expandAll) {
        toggleExpandAll();
      } else if (input === hotkeys.testAll) {
        // Test ALL models and all configurations available!
        if (allOrderedSections.length > 0) {
          startBatchTest(
            `All Models & Configurations (${allOrderedSections.length} total)`,
            allOrderedSections
          );
        }
      } else if (input === hotkeys.testModel && navRows.length > 0) {
        // Test selected item:
        // - If on a Model row (model-header): tests ALL configurations of that model at once!
        // - If on a Configuration row (child-section / standalone-section): tests that configuration!
        const current = navRows[selectedIndex];
        if (!current) return;
        if (current.type === 'model-header') {
          const allModelSections = getSectionsForCatalogEntry(current.entry, models);
          if (allModelSections.length > 0) {
            startBatchTest(
              `Model [${current.entry.variantId}] (${allModelSections.length} config${allModelSections.length === 1 ? '' : 's'})`,
              allModelSections
            );
          }
        } else if (current.type === 'child-section' || current.type === 'standalone-section') {
          startBatchTest(`Configuration [${current.section.sectionId}]`, [current.section]);
        }
      } else if (input === hotkeys.testChild && navRows.length > 0) {
        // When on a child configuration row, [m] tests all configurations of its parent model at once
        const current = navRows[selectedIndex];
        if (!current) return;
        const targetEntry =
          current.type === 'model-header'
            ? current.entry
            : current.type === 'child-section'
            ? current.parentEntry
            : undefined;
        if (targetEntry) {
          const allModelSections = getSectionsForCatalogEntry(targetEntry, models);
          if (allModelSections.length > 0) {
            startBatchTest(
              `Model [${targetEntry.variantId}] (${allModelSections.length} config${allModelSections.length === 1 ? '' : 's'})`,
              allModelSections
            );
          }
        }
      } else if (input === ' ') {
        // Space toggles expand/collapse on the model (or parent model of a child row)
        const current = navRows[selectedIndex];
        if (!current) return;
        if (current.type === 'model-header') {
          toggleExpand(current.entry.variantId);
        } else if (current.type === 'child-section') {
          const parentId = current.parentEntry.variantId;
          const parentHeaderIdx = navRows.findIndex(
            (r) => r.type === 'model-header' && r.entry.variantId === parentId
          );
          collapseModel(parentId);
          if (parentHeaderIdx !== -1) {
            setSelectedIndex(parentHeaderIdx);
          }
        }
      } else if (key.rightArrow) {
        const current = navRows[selectedIndex];
        if (current?.type === 'model-header') {
          expandModel(current.entry.variantId);
        }
      } else if (key.leftArrow) {
        const current = navRows[selectedIndex];
        if (current?.type === 'model-header') {
          collapseModel(current.entry.variantId);
        } else if (current?.type === 'child-section') {
          const parentId = current.parentEntry.variantId;
          const parentHeaderIdx = navRows.findIndex(
            (r) => r.type === 'model-header' && r.entry.variantId === parentId
          );
          collapseModel(parentId);
          if (parentHeaderIdx !== -1) {
            setSelectedIndex(parentHeaderIdx);
          }
        }
      } else if (input === hotkeys.mixProfiles && navRows.length > 0) {
        // Open the Multi-Configuration / Mixture Builder UI for the selected model
        const current = navRows[selectedIndex];
        const targetEntry =
          current?.type === 'model-header'
            ? current.entry
            : current?.type === 'child-section'
            ? current.parentEntry
            : undefined;
        if (targetEntry) {
          setBuilderEntryId(targetEntry.variantId);
        }
      } else if ((key.return || input === hotkeys.edit) && navRows.length > 0) {
        const current = navRows[selectedIndex];
        if (!current) return;

        if (current.type === 'child-section' || current.type === 'standalone-section') {
          setSelectedModelId(current.section.sectionId);
        } else if (current.type === 'model-header') {
          if (current.sections.length === 0) {
            setBuilderEntryId(current.entry.variantId);
          } else if (current.sections.length === 1 && !current.isExpanded) {
            // Single configuration: Enter can open its editor directly (or Space/→ expands it)
            setSelectedModelId(current.sections[0].sectionId);
          } else {
            // Multiple configurations: Enter toggles expand/collapse so user can pick which configuration to edit
            toggleExpand(current.entry.variantId);
          }
        }
      } else if (input === hotkeys.toggleExport && navRows.length > 0) {
        // Toggle enable/disable for exported preset
        const current = navRows[selectedIndex];
        if (!current) return;
        if (current.type === 'child-section' || current.type === 'standalone-section') {
          onToggleSectionEnabled?.(current.section.sectionId);
        } else if (current.type === 'model-header') {
          const secIds = current.sections.map((s) => s.sectionId);
          onToggleModelEnabled?.(secIds);
        }
      } else if (input === hotkeys.deleteSection && navRows.length > 0) {
        const current = navRows[selectedIndex];
        if (current?.type === 'child-section' || current?.type === 'standalone-section') {
          onDeleteModel(current.section.sectionId);
          setSelectedIndex((prev) => Math.max(0, Math.min(prev, navRows.length - 2)));
        } else if (current?.type === 'model-header' && current.sections.length === 1) {
          onDeleteModel(current.sections[0].sectionId);
        }
      }
    },
    { isActive: !selectedModelId && !builderEntryId && !isSearching }
  );

  // 0. Batch / Single Test Runner Modal
  if (isBatchModalOpen && batchSections.length > 0) {
    const passedCount = batchSections.filter(
      (s) => getSectionTestStatus(s.sectionId, testStatuses) === 'passed'
    ).length;
    const failedCount = batchSections.filter(
      (s) => getSectionTestStatus(s.sectionId, testStatuses) === 'failed'
    ).length;

    const inspectedSecId = inspectedSection?.sectionId ?? '';
    const inspectedStatus = getSectionTestStatus(inspectedSecId, testStatuses);
    const inspectedCmd =
      liveCommands[inspectedSecId] ??
      testStatuses[inspectedSecId]?.lastResult?.commandLine ??
      '(Command will be built when test starts)';
    const inspectedPid =
      livePids[inspectedSecId] ?? testStatuses[inspectedSecId]?.lastResult?.pid;

    const wrappedCmdLines = wrapTextToLines(`Cmd: ${inspectedCmd}`, logLineWidth);
    const wrappedPromptLines = wrapTextToLines(
      `Prompt: "${testSettings.defaultPrompt}"`,
      logLineWidth
    );

    const bannerColor = isBatchRunning
      ? 'yellow'
      : failedCount > 0
      ? 'red'
      : passedCount > 0
      ? 'green'
      : 'cyan';

    const headerBannerRows =
      5 + wrappedCmdLines.length + wrappedPromptLines.length;
    const maxLogRows = Math.max(3, contentHeight - headerBannerRows - 4);

    const activeLineIndex =
      isBatchRunning && autoFollowLog
        ? Math.max(0, inspectedOutputLines.length - 1)
        : Math.min(testScrollOffset, Math.max(0, inspectedOutputLines.length - 1));

    const logWin = computeScrollWindow(inspectedOutputLines.length, activeLineIndex, maxLogRows);
    const visibleLogLines = inspectedOutputLines.slice(logWin.startIndex, logWin.endIndex);

    return (
      <Box
        flexDirection="column"
        paddingX={1}
        width={columns}
        height={contentHeight}
        overflowY="hidden"
        overflowX="hidden"
      >
        <Box
          borderStyle="double"
          borderColor={bannerColor}
          paddingX={1}
          flexDirection="column"
          width={innerWidth}
          flexShrink={0}
        >
          <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
            <Box gap={1} overflowX="hidden">
              <Text bold color={bannerColor} wrap="truncate-end">
                {isBatchRunning
                  ? `⏳ Running Test (${currentRunningIdx + 1}/${batchSections.length}): ${batchTitle}`
                  : failedCount === 0 && passedCount === batchSections.length
                  ? `✓ All Passed (${passedCount}/${batchSections.length}): ${batchTitle}`
                  : `✗ Finished (Passed: ${passedCount}, Failed: ${failedCount} / ${batchSections.length}): ${batchTitle}`}
              </Text>
            </Box>
            {!isNarrowTerminal(columns) && (
              <Box flexShrink={0}>
                <Text color="yellow" bold wrap="truncate-end">
                  {isBatchRunning
                    ? '[Esc/q] Stop & Return'
                    : '[t/r] Re-run │ [Esc/q] Back to Models'}
                </Text>
              </Box>
            )}
          </Box>

          {/* Horizontal strip of configurations in this test run with their ● status marks */}
          <Box gap={1} width={innerWidth - 2} overflowX="hidden">
            <Text color="gray" wrap="truncate-end">
              {batchSections.length > 1 ? '[←/→] Configs:' : 'Config:'}
            </Text>
            {batchSections.map((sec, idx) => {
              const st = getSectionTestStatus(sec.sectionId, testStatuses);
              const stColor = getTestStatusColor(st);
              const isInspected = idx === effectiveInspectedIdx;
              const secTps = testStatuses[sec.sectionId]?.avgTokensPerSec;
              const tpsSuffix = secTps !== undefined ? ` (${secTps.toFixed(1)} t/s)` : '';
              return (
                <Box key={sec.sectionId} flexShrink={0}>
                  <Text
                    bold={isInspected}
                    color={isInspected ? 'black' : 'white'}
                    backgroundColor={isInspected ? 'cyan' : undefined}
                    wrap="truncate-end"
                  >
                    {' '}
                  </Text>
                  <Text
                    bold
                    color={stColor}
                    backgroundColor={isInspected ? 'cyan' : undefined}
                  >
                    ●
                  </Text>
                  <Text
                    bold={isInspected}
                    color={isInspected ? 'black' : 'white'}
                    backgroundColor={isInspected ? 'cyan' : undefined}
                    wrap="truncate-end"
                  >
                    {` ${sec.sectionId}${tpsSuffix} `}
                  </Text>
                </Box>
              );
            })}
          </Box>

          <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
            <Box gap={1} overflowX="hidden">
              <Text color={getTestStatusColor(inspectedStatus)} bold>
                ●
              </Text>
              <Text bold color="white" wrap="truncate-end">
                Inspecting [{inspectedSecId}] ({effectiveInspectedIdx + 1}/{batchSections.length})
                {inspectedPid ? ` — PID: ${inspectedPid}` : ''}
              </Text>
              {(() => {
                const cmp = compareTokensPerSecond(
                  testStatuses[inspectedSecId]?.avgTokensPerSec,
                  testStatuses[inspectedSecId]?.previousAvgTokensPerSec
                );
                return (
                  <>
                    <Text color="yellow" bold wrap="truncate-end">
                      │ ⚡ {inspectedStatus === 'running' ? 'Measuring…' : cmp.formattedCurrent}
                    </Text>
                    {inspectedStatus !== 'running' && cmp.formattedDetailedComparison && (
                      <Text
                        bold={cmp.direction === 'better' || cmp.direction === 'worse'}
                        color={
                          cmp.direction === 'better'
                            ? 'green'
                            : cmp.direction === 'worse'
                            ? 'red'
                            : 'gray'
                        }
                        wrap="truncate-end"
                      >
                        {cmp.formattedDetailedComparison}
                      </Text>
                    )}
                  </>
                );
              })()}
            </Box>
            <Box gap={2} flexShrink={0}>
              <Text color="green" bold>
                ● Passed: {passedCount}
              </Text>
              <Text color="red" bold>
                ● Failed: {failedCount}
              </Text>
              <Text color="gray">
                ● Total: {batchSections.length}
              </Text>
            </Box>
          </Box>

          {/* Full multi-line command display */}
          {wrappedCmdLines.map((line, i) => (
            <Text key={`cmd-${i}`} color="gray" wrap="truncate-end">
              {line}
            </Text>
          ))}

          {/* Full multi-line prompt display */}
          {wrappedPromptLines.map((line, i) => (
            <Text key={`prompt-${i}`} color="cyan" wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>

        <Box
          flexDirection="column"
          paddingX={1}
          width={innerWidth}
          overflowY="hidden"
          overflowX="hidden"
        >
          <Box justifyContent="space-between" width={innerWidth - 2}>
            <Text bold underline wrap="truncate-end">
              llama cli Output for [{inspectedSecId}] (Line{' '}
              {inspectedOutputLines.length > 0 ? activeLineIndex + 1 : 0}/
              {inspectedOutputLines.length}):
            </Text>
            <Text color="gray" wrap="truncate-end">
              {batchSections.length > 1 ? '[←/→] Switch Config │ ' : ''}
              [↑/↓] Scroll Line │ [PgUp/PgDn] Page │ [g/G] Top/Bottom
            </Text>
          </Box>

          {logWin.hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↑ ({logWin.startIndex} more line(s) above — press [↑] or [g] to scroll up)
            </Text>
          )}

          {visibleLogLines.map((line, idx) => {
            const globalIdx = logWin.startIndex + idx;
            const isCursorLine = !autoFollowLog && globalIdx === activeLineIndex;
            const isErrorLine = /error|failed|exception|invalid|ggml_assert/i.test(line);

            return (
              <Text
                key={`${globalIdx}`}
                color={isErrorLine ? 'red' : isCursorLine ? 'cyan' : 'white'}
                bold={isCursorLine}
                wrap="truncate-end"
              >
                {isCursorLine ? '❯ ' : '  '}
                {line || ' '}
              </Text>
            );
          })}

          {logWin.hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↓ ({inspectedOutputLines.length - logWin.endIndex} more line(s) below — press [↓] or [G] to scroll down)
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  // 1. Per-Configuration Parameter Editor View
  if (selectedModelId && models[selectedModelId]) {
    const activeSection = models[selectedModelId];
    const matchedEntry = catalog.find((entry) =>
      getSectionsForCatalogEntry(entry, models).some((s) => s.sectionId === selectedModelId)
    );
    return (
      <ModelEditorView
        common={common}
        section={activeSection}
        isMoe={matchedEntry?.isMoe}
        testSettings={testSettings}
        sectionTestStatus={testStatuses[selectedModelId]}
        onUpdateTestStatus={onUpdateTestStatus}
        onChange={(updated) => onUpdateModel(selectedModelId, updated)}
        onBack={() => {
          setSelectedModelId(null);
          onEditingTextChange?.(false);
        }}
        onEditingTextChange={onEditingTextChange}
        contentHeight={contentHeight}
        columns={columns}
      />
    );
  }

  // 2. Intuitive Multi-Configuration Builder (enable/disable base, mmproj, mtp mixtures)
  const activeBuilderEntry = builderEntryId
    ? catalog.find((c) => c.variantId === builderEntryId)
    : undefined;

  if (activeBuilderEntry) {
    const entrySections = getSectionsForCatalogEntry(activeBuilderEntry, models);
    return (
      <ModelProfilesBuilderView
        entry={activeBuilderEntry}
        allModels={models}
        entrySections={entrySections}
        testStatuses={testStatuses}
        onTestAllModelConfigs={() => {
          if (entrySections.length > 0) {
            setBuilderEntryIdState(null);
            startBatchTest(
              `Model [${activeBuilderEntry.variantId}] (${entrySections.length} config${entrySections.length === 1 ? '' : 's'})`,
              entrySections
            );
          }
        }}
        onSaveSection={(secId, sec) => {
          onUpdateModel(secId, sec);
          expandModel(activeBuilderEntry.variantId);
        }}
        onRemoveSection={(secId) => onDeleteModel(secId)}
        onOpenSectionEditor={(secId) => {
          setBuilderEntryIdState(null);
          setSelectedModelIdState(secId);
          onSubScreenChange?.(true);
        }}
        onBack={() => {
          setBuilderEntryId(null);
          onEditingTextChange?.(false);
        }}
        onEditingTextChange={onEditingTextChange}
        contentHeight={contentHeight}
        columns={columns}
      />
    );
  }

  // 3. Collapsible / Expandable Models & Configurations List View
  const isNarrow = isNarrowTerminal(columns);
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, navRows.length - 1));
  const bottomBarRows = isSearching ? BOTTOM_TEXT_EDITOR_HEIGHT : 0;
  // In 'names-only' mode each model header is 1 line; otherwise 2 lines
  const linesPerModelRow = detailMode === 'names-only' ? 1 : 2;
  const maxVisibleRows = Math.max(2, Math.floor((contentHeight - 9 - bottomBarRows) / linesPerModelRow));
  const { startIndex, endIndex, hasMoreAbove, hasMoreBelow } = computeScrollWindow(
    navRows.length,
    safeSelectedIndex,
    maxVisibleRows
  );
  const visibleRows = navRows.slice(startIndex, endIndex);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={columns}
      height={contentHeight}
      justifyContent="space-between"
      overflowY="hidden"
      overflowX="hidden"
    >
      <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
        <Box
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          flexDirection="column"
          width={innerWidth}
          flexShrink={0}
        >
          <Box gap={2} overflowX="hidden" width={innerWidth - 4}>
            <Text bold color="cyan" wrap="truncate-end">
              Models ({catalog.length}) & Configs ({Object.keys(models).length})
            </Text>
            <Box gap={1} flexShrink={0}>
              <Text color="gray">● Not Ran</Text>
              <Text color="green">● Passed</Text>
              <Text color="red">● Failed</Text>
              <Text color="gray">│</Text>
              <Text color="green">[✓ Exported]</Text>
              <Text color="yellow">[+ Add]</Text>
              <Text color="#FFA500">[- Remove]</Text>
              <Text color="red">[✗ Excluded]</Text>
            </Box>
            {isSearching ? (
              <Text color="yellow" wrap="truncate-end">
                (typing filter in bottom bar…)
              </Text>
            ) : filterText ? (
              <Text color="yellow" wrap="truncate-end">
                Filter: &quot;{filterText}&quot; ([Esc/q] clear)
              </Text>
            ) : null}
          </Box>
          <Box overflowX="hidden" width={innerWidth - 4}>
            <Text color="gray" wrap="truncate-end">
              [{hotkeys.cycleDetailMode}] View:{detailMode === 'names-only' ? 'Names' : detailMode === 'names-and-configs' ? 'Configs' : 'Full'} │ [{hotkeys.toggleExport}] Toggle │ [Space] Expand │ [{hotkeys.mixProfiles}] Mix │ [Enter] Edit │ [{hotkeys.testModel}] Test │ [{hotkeys.testAll}] All │ [{hotkeys.filter}] Filter
            </Text>
          </Box>
        </Box>

        {hasMoreAbove && (
          <Text color="gray" dimColor wrap="truncate-end">
            ↑ ({startIndex} more row(s) above)
          </Text>
        )}

        {navRows.length === 0 ? (
          <Text color="gray" italic wrap="truncate-end">
            No model configurations found. Scan a directory in Tab 3 to populate models automatically.
          </Text>
        ) : (
          visibleRows.map((row, localIdx) => {
            const idx = startIndex + localIdx;
            const isSelected = idx === safeSelectedIndex;

            if (row.type === 'model-header') {
              const { entry, sections, isExpanded } = row;
              const hasAvailableVision = Boolean(entry.primaryMmprojPath);
              const hasAvailableDraft = Boolean(entry.primaryMtpPath);
              const isMultiConfig = sections.length > 1;
              const allModelSections = getSectionsForCatalogEntry(entry, models);
              const modelStatus = getModelAggregateTestStatus(allModelSections, testStatuses);
              const modelStatusColor = getTestStatusColor(modelStatus);

              const headerExportBadge = getModelHeaderExportBadge(
                allModelSections,
                disabledSectionIds,
                exportedSectionIds
              );
              const isAllModelDisabled = headerExportBadge.isAllDisabled;

              // Summarize active mixtures when collapsed
              const activeSummary = sections
                .map((s) => {
                  const k = getSectionCombinationKey(s);
                  const isSecDisabled = disabledSectionIds.includes(s.sectionId);
                  const prefix = isSecDisabled ? '~' : '';
                  if (k === 'vision+mtp') return `${prefix}Base+Vis+MTP`;
                  if (k === 'vision') return `${prefix}Base+Vis`;
                  if (k === 'mtp') return `${prefix}Base+MTP`;
                  return `${prefix}Base`;
                })
                .join(', ');

              return (
                <Box
                  key={`header-${entry.variantId}`}
                  flexDirection="column"
                  paddingX={1}
                  width={innerWidth}
                  overflowX="hidden"
                >
                  {/* Line 1: Model identity + capability badges */}
                  <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
                    <Box gap={1} overflowX="hidden">
                      <Text color={isSelected ? 'cyan' : 'white'} underline={isSelected} bold={isSelected}>
                        {isSelected ? '❯' : ' '} {isExpanded ? '▼' : '▶'}
                      </Text>
                      <Text color={headerExportBadge.color} underline={isSelected} bold>
                        {headerExportBadge.symbol}
                      </Text>
                      <Text color={modelStatusColor} underline={isSelected} bold>
                        ●
                      </Text>
                      <Text
                        color={
                          isAllModelDisabled
                            ? 'gray'
                            : isSelected
                            ? 'cyan'
                            : 'white'
                        }
                        underline={isSelected}
                        dimColor={isAllModelDisabled}
                        bold={isSelected}
                        wrap="truncate-end"
                      >
                        [{entry.family}] {entry.variantId}
                      </Text>
                    </Box>

                    <Box flexShrink={0} gap={1}>
                      {entry.isMoe && (
                        <Text color="yellow" underline={isSelected} bold wrap="truncate-end">
                          [MoE]
                        </Text>
                      )}
                      {hasAvailableVision && (
                        <Text color="magenta" underline={isSelected} wrap="truncate-end">
                          [mmproj]
                        </Text>
                      )}
                      {hasAvailableDraft && (
                        <Text color="blue" underline={isSelected} wrap="truncate-end">
                          [mtp]
                        </Text>
                      )}
                    </Box>
                  </Box>

                  {/* Line 2: Config summary, benchmark speed, and quick actions (hidden in 'names-only' mode) */}
                  {detailMode !== 'names-only' && (
                    <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
                      <Box gap={1} paddingLeft={6} overflowX="hidden">
                        {isMultiConfig ? (
                          <Text color="yellow" underline={isSelected} bold wrap="truncate-end">
                            ★ {sections.length} configs: {activeSummary}
                          </Text>
                        ) : sections.length === 1 ? (
                          <Text color="green" underline={isSelected} wrap="truncate-end">
                            1 config: {activeSummary}
                          </Text>
                        ) : (
                          <Text color="gray" underline={isSelected} italic wrap="truncate-end">
                            0 configs
                          </Text>
                        )}

                        {detailMode === 'full' &&
                          (() => {
                            if (allModelSections.length === 1) {
                              const st = testStatuses[allModelSections[0].sectionId];
                              if (st?.avgTokensPerSec !== undefined) {
                                const cmp = compareTokensPerSecond(
                                  st.avgTokensPerSec,
                                  st.previousAvgTokensPerSec
                                );
                                return (
                                  <>
                                    <Text color="yellow" underline={isSelected} bold wrap="truncate-end">
                                      ⚡{cmp.formattedCurrent}
                                    </Text>
                                    {cmp.direction !== 'none' && (
                                      <Text
                                        bold
                                        color={
                                          cmp.direction === 'better'
                                            ? 'green'
                                            : cmp.direction === 'worse'
                                            ? 'red'
                                            : 'gray'
                                        }
                                        underline={isSelected}
                                        wrap="truncate-end"
                                      >
                                        {cmp.formattedShortComparison}
                                      </Text>
                                    )}
                                  </>
                                );
                              }
                            } else if (allModelSections.length > 1) {
                              const measured = allModelSections
                                .map((s) => testStatuses[s.sectionId]?.avgTokensPerSec)
                                .filter((v): v is number => v !== undefined);
                              if (measured.length > 0) {
                                const maxTps = Math.max(...measured);
                                return (
                                  <Text color="yellow" underline={isSelected} bold wrap="truncate-end">
                                    ⚡best:{maxTps.toFixed(1)} t/s
                                  </Text>
                                );
                              }
                            }
                            return null;
                          })()}
                      </Box>

                      {!isNarrow && (
                        <Box flexShrink={0}>
                          <Text color="gray" underline={isSelected} wrap="truncate-end">
                            {isExpanded ? '[Space/← Collapse]' : '[Space/→ Expand]'} [{hotkeys.toggleExport}: Toggle] [{hotkeys.testModel}: Test All] [{hotkeys.mixProfiles}: Mix]
                          </Text>
                        </Box>
                      )}
                    </Box>
                  )}
                </Box>
              );
            }

            if (row.type === 'standalone-section') {
              const { section: sec } = row;
              const exportBadge = getSectionExportBadge(
                sec.sectionId,
                disabledSectionIds,
                exportedSectionIds
              );
              const isSecDisabled = exportBadge.isDisabled;
              const secStatus = getSectionTestStatus(sec.sectionId, testStatuses);
              const secStatusColor = getTestStatusColor(secStatus);
              return (
                <Box
                  key={`standalone-${sec.sectionId}`}
                  paddingX={1}
                  width={innerWidth}
                  gap={1}
                  overflowX="hidden"
                >
                  <Text color={isSelected ? 'cyan' : 'white'} underline={isSelected} bold={isSelected}>
                    {isSelected ? '❯' : ' '} •
                  </Text>
                  <Text color={exportBadge.color} underline={isSelected} bold>
                    {exportBadge.symbol}
                  </Text>
                  <Text color={secStatusColor} underline={isSelected} bold>
                    ●
                  </Text>
                  <Text
                    color={
                      isSecDisabled
                        ? 'gray'
                        : isSelected
                        ? 'cyan'
                        : 'white'
                    }
                    underline={isSelected}
                    dimColor={isSecDisabled}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    [{sec.sectionId}] — {truncateMiddle(sec.model, Math.max(20, innerWidth - 38))}
                  </Text>
                </Box>
              );
            }

            // row.type === 'child-section'
            const { section: sec, parentEntry, siblingCount, siblingIndex } = row;
            const exportBadge = getSectionExportBadge(
              sec.sectionId,
              disabledSectionIds,
              exportedSectionIds
            );
            const isSecDisabled = exportBadge.isDisabled;
            const draftActive = hasModelDraft(sec);
            const visionActive = hasMmproj(sec);
            const comboKey = getSectionCombinationKey(sec);
            const secStatus = getSectionTestStatus(sec.sectionId, testStatuses);
            const secStatusColor = getTestStatusColor(secStatus);

            const hasAvailableVision = Boolean(parentEntry.primaryMmprojPath);
            const hasAvailableDraft = Boolean(parentEntry.primaryMtpPath);

            const mixtureBadge =
              comboKey === 'vision+mtp'
                ? 'Base + Vision + MTP'
                : comboKey === 'vision'
                ? 'Base + Vision'
                : comboKey === 'mtp'
                ? 'Base + MTP'
                : 'Base Only';

            const treeBranch = siblingIndex === siblingCount - 1 ? '└─' : '├─';

            return (
              <Box
                key={`child-${sec.sectionId}`}
                flexDirection="column"
                paddingX={1}
                width={innerWidth}
                overflowX="hidden"
              >
                <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
                  <Box gap={1} paddingLeft={2} overflowX="hidden">
                    <Text color={isSelected ? 'cyan' : 'gray'} underline={isSelected} bold={isSelected}>
                      {isSelected ? '❯' : ' '} {treeBranch}
                    </Text>
                    <Text color={exportBadge.color} underline={isSelected} bold>
                      {exportBadge.symbol}
                    </Text>
                    <Text color={secStatusColor} underline={isSelected} bold>
                      ●
                    </Text>
                    <Text
                      color={
                        isSecDisabled
                          ? 'gray'
                          : isSelected
                          ? 'cyan'
                          : 'gray'
                      }
                      underline={isSelected}
                      dimColor={isSecDisabled}
                      bold={isSelected}
                      wrap="truncate-end"
                    >
                      [{sec.sectionId}]
                    </Text>

                    <Text
                      color={
                        comboKey === 'vision+mtp'
                          ? 'cyan'
                          : comboKey === 'vision'
                          ? 'magenta'
                          : comboKey === 'mtp'
                          ? 'blue'
                          : 'green'
                      }
                      underline={isSelected}
                      bold
                      wrap="truncate-end"
                    >
                      [{mixtureBadge}]
                    </Text>

                    {sec['ctx-size'] !== undefined ? (
                      <Text color="yellow" underline={isSelected} wrap="truncate-end">
                        ctx:{sec['ctx-size']}
                      </Text>
                    ) : common['ctx-size'] !== undefined && common['ctx-size'] !== '' ? (
                      <Text color="gray" underline={isSelected} italic wrap="truncate-end">
                        ctx:({common['ctx-size']})
                      </Text>
                    ) : null}
                    {sec['n-gpu-layers'] !== undefined ? (
                      <Text color="green" underline={isSelected} wrap="truncate-end">
                        ngl:{sec['n-gpu-layers']}
                      </Text>
                    ) : common['n-gpu-layers'] !== undefined && common['n-gpu-layers'] !== '' ? (
                      <Text color="gray" underline={isSelected} italic wrap="truncate-end">
                        ngl:({common['n-gpu-layers']})
                      </Text>
                    ) : null}
                    {sec['n-cpu-moe'] !== undefined && (
                      <Text color="yellow" underline={isSelected} wrap="truncate-end">
                        ncmoe:{sec['n-cpu-moe']}
                      </Text>
                    )}

                    {(() => {
                      const st = testStatuses[sec.sectionId];
                      if (st?.avgTokensPerSec === undefined) return null;
                      const cmp = compareTokensPerSecond(
                        st.avgTokensPerSec,
                        st.previousAvgTokensPerSec
                      );
                      return (
                        <>
                          <Text color="yellow" underline={isSelected} bold wrap="truncate-end">
                            ⚡{cmp.formattedCurrent}
                          </Text>
                          {cmp.direction !== 'none' && (
                            <Text
                              bold
                              color={
                                cmp.direction === 'better'
                                  ? 'green'
                                  : cmp.direction === 'worse'
                                  ? 'red'
                                  : 'gray'
                              }
                              underline={isSelected}
                              wrap="truncate-end"
                            >
                              {cmp.formattedShortComparison}
                            </Text>
                          )}
                        </>
                      );
                    })()}
                  </Box>

                  {!isNarrow && (
                    <Box flexShrink={0}>
                      <Text color="gray" underline={isSelected} wrap="truncate-end">
                        {isSecDisabled ? '[x: Enable Export]' : '[x: Disable Export]'} [Enter: Edit] [t: Test] [d: Del]
                      </Text>
                    </Box>
                  )}
                </Box>

                {isSelected && (
                  <Box paddingLeft={7} flexDirection="column" width={innerWidth - 2} overflowX="hidden">
                    <Text color="gray" wrap="truncate-end">
                      model = {truncateMiddle(sec.model, Math.max(24, innerWidth - 19))}
                    </Text>
                    {visionActive ? (
                      <Text color="magenta" wrap="truncate-end">
                        mmproj = {truncateMiddle(String(sec.mmproj), Math.max(24, innerWidth - 20))}
                      </Text>
                    ) : hasAvailableVision ? (
                      <Text color="gray" dimColor wrap="truncate-end">
                        mmproj = (disabled in this profile)
                      </Text>
                    ) : null}
                    {draftActive ? (
                      <Text color="blue" wrap="truncate-end">
                        model-draft = {truncateMiddle(String(sec['model-draft']), Math.max(24, innerWidth - 35))}
                        {sec['spec-draft-n-max'] !== undefined
                          ? ` (n-max=${sec['spec-draft-n-max']})`
                          : ''}
                      </Text>
                    ) : hasAvailableDraft ? (
                      <Text color="gray" dimColor wrap="truncate-end">
                        model-draft = (disabled in this profile)
                      </Text>
                    ) : null}
                  </Box>
                )}
              </Box>
            );
          })
        )}

        {hasMoreBelow && (
          <Text color="gray" dimColor wrap="truncate-end">
            ↓ ({navRows.length - endIndex} more row(s) below)
          </Text>
        )}
      </Box>

      {isSearching && (
        <BottomTextEditorBar
          label="Search / Filter Models"
          initialValue={filterText}
          placeholder="Type model name, quantization, or alias to filter..."
          columns={columns}
          onSubmit={(val) => {
            const trimmed = val.trim();
            setFilterText(trimmed);
            setSelectedIndex(0);
            setSearchMode(false);
            syncSubScreenState(selectedModelId, builderEntryId, trimmed, isBatchModalOpen);
          }}
          onCancel={() => {
            setSearchMode(false);
          }}
        />
      )}
    </Box>
  );
};
