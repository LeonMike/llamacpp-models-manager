import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  AppTestSettings,
  CommonPresetConfig,
  ModelPresetSection,
  OrganizationPlan,
  OrganizationResult,
  PresetConfigDocument,
  ScanResult,
  SectionTestStatus,
} from '../types/index.js';
import { scanModelsDirectory } from '../core/scanner.js';
import { createOrganizationPlan, executeOrganizationPlan } from '../core/organizer.js';
import {
  ALL_CONFIGS_AVAILABLE_FILENAME,
  computeInitialDisabledSectionIds,
  createEmptyPresetDocument,
  loadAllConfigsAvailableFile,
  loadPresetFile,
  mergePresetWithAllConfigs,
  saveAllConfigsAvailableFile,
  savePresetFile,
  syncPresetWithScan,
} from '../core/preset-config.js';
import {
  DEFAULT_APP_TEST_SETTINGS,
  loadAppTestSettings,
  loadSectionTestStatuses,
  saveAppTestSettings,
  saveSectionTestStatuses,
} from '../core/model-tester.js';
import { ActiveTab, Header, HEADER_HEIGHT } from './components/Header.js';
import { ScanOrganizeView } from './components/ScanOrganizeView.js';
import { CommonConfigView } from './components/CommonConfigView.js';
import { ModelListView } from './components/ModelListView.js';
import { AppSettingsView } from './components/AppSettingsView.js';
import { ServerView } from './components/ServerView.js';
import {
  appendBoundedLogLines,
  DEFAULT_MAX_SERVER_LOG_LINES,
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  RunningLlamaServeController,
  ServerLogVerbosity,
  ServerStateSnapshot,
  startLlamaServeProcess,
} from '../core/server-runner.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';

export interface AppProps {
  modelsDir: string;
  presetPath: string;
  initialTab?: ActiveTab;
}

export const App: React.FC<AppProps> = ({
  modelsDir,
  presetPath,
  initialTab = 'models-config',
}) => {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [activeTab, setActiveTabState] = useState<ActiveTab>(initialTab);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [plan, setPlan] = useState<OrganizationPlan | null>(null);
  const [presetDoc, setPresetDoc] = useState<PresetConfigDocument>(createEmptyPresetDocument());
  const [exportedSectionIds, setExportedSectionIds] = useState<string[]>([]);
  const [testSettings, setTestSettings] = useState<AppTestSettings>(DEFAULT_APP_TEST_SETTINGS);
  const [testStatuses, setTestStatuses] = useState<Record<string, SectionTestStatus>>({});
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isBusy, setIsBusy] = useState(true);
  const [isEditingText, setIsEditingText] = useState(false);
  const [isInSubScreen, setIsInSubScreen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>('Scanning models directory...');

  // Background llama serve state (persists across tab switches during this session)
  const [serverState, setServerState] = useState<ServerStateSnapshot>({ status: 'stopped' });
  const [serverLogs, setServerLogs] = useState<string[]>([]);
  const [serverVerbosity, setServerVerbosity] = useState<ServerLogVerbosity>('minimal');
  const serverVerbosityRef = useRef<ServerLogVerbosity>('minimal');
  serverVerbosityRef.current = serverVerbosity;
  const serverControllerRef = useRef<RunningLlamaServeController | null>(null);

  useEffect(() => {
    return () => {
      serverControllerRef.current?.killImmediate();
      serverControllerRef.current = null;
    };
  }, []);

  const handleStartServer = useCallback(() => {
    if (
      serverState.status === 'running' ||
      serverState.status === 'starting' ||
      serverState.status === 'stopping'
    ) {
      return;
    }
    setServerLogs([]);
    const ctrl = startLlamaServeProcess({
      presetPath,
      serveCommand: testSettings.serveCommand ?? 'llama serve',
      serveHost: testSettings.serveHost ?? DEFAULT_SERVE_HOST,
      servePort: testSettings.servePort ?? DEFAULT_SERVE_PORT,
      verbosity: serverVerbosityRef.current,
      maxLogLines: DEFAULT_MAX_SERVER_LOG_LINES,
      onStateChange: (snapshot) => {
        setServerState(snapshot);
        if (snapshot.status === 'stopped' || snapshot.status === 'error') {
          serverControllerRef.current = null;
        }
      },
      onLogLine: (line) => {
        setServerLogs((prev) =>
          appendBoundedLogLines(
            prev,
            line,
            serverVerbosityRef.current,
            DEFAULT_MAX_SERVER_LOG_LINES
          )
        );
      },
    });
    serverControllerRef.current = ctrl;
    setStatusMessage(`Starting llama serve with ${presetPath}...`);
  }, [
    presetPath,
    serverState.status,
    testSettings.serveCommand,
    testSettings.serveHost,
    testSettings.servePort,
  ]);

  const handleStopServer = useCallback(async () => {
    const ctrl = serverControllerRef.current;
    if (!ctrl) return;
    setStatusMessage(`Stopping llama serve (PID: ${ctrl.pid ?? '?'})...`);
    await ctrl.stop();
    serverControllerRef.current = null;
    setStatusMessage('llama serve stopped.');
  }, []);

  const handleRestartServer = useCallback(async () => {
    const ctrl = serverControllerRef.current;
    if (ctrl) {
      setStatusMessage('Restarting llama serve...');
      await ctrl.stop();
      serverControllerRef.current = null;
    }
    setServerLogs([]);
    const nextCtrl = startLlamaServeProcess({
      presetPath,
      serveCommand: testSettings.serveCommand ?? 'llama serve',
      serveHost: testSettings.serveHost ?? DEFAULT_SERVE_HOST,
      servePort: testSettings.servePort ?? DEFAULT_SERVE_PORT,
      verbosity: serverVerbosityRef.current,
      maxLogLines: DEFAULT_MAX_SERVER_LOG_LINES,
      onStateChange: (snapshot) => {
        setServerState(snapshot);
        if (snapshot.status === 'stopped' || snapshot.status === 'error') {
          serverControllerRef.current = null;
        }
      },
      onLogLine: (line) => {
        setServerLogs((prev) =>
          appendBoundedLogLines(
            prev,
            line,
            serverVerbosityRef.current,
            DEFAULT_MAX_SERVER_LOG_LINES
          )
        );
      },
    });
    serverControllerRef.current = nextCtrl;
    setStatusMessage(`Restarted llama serve with ${presetPath}.`);
  }, [presetPath, testSettings.serveCommand, testSettings.serveHost, testSettings.servePort]);

  const setActiveTab = (nextTab: ActiveTab) => {
    setActiveTabState(nextTab);
    setIsInSubScreen(false);
  };

  const refreshScanAndPreset = useCallback(
    async (preserveUnsavedDoc?: PresetConfigDocument) => {
      setIsBusy(true);
      setStatusMessage('Scanning GGUF headers and building organization plan...');
      try {
        const [scanned, allConfigsDoc, exportedDoc, loadedSettings, loadedStatuses] =
          await Promise.all([
            scanModelsDirectory(modelsDir),
            preserveUnsavedDoc
              ? Promise.resolve(createEmptyPresetDocument())
              : loadAllConfigsAvailableFile(modelsDir),
            preserveUnsavedDoc
              ? Promise.resolve(createEmptyPresetDocument())
              : loadPresetFile(presetPath),
            loadAppTestSettings(presetPath),
            loadSectionTestStatuses(presetPath),
          ]);
        const orgPlan = await createOrganizationPlan(scanned);
        const baseDoc = preserveUnsavedDoc
          ? preserveUnsavedDoc
          : mergePresetWithAllConfigs(allConfigsDoc, exportedDoc);
        const syncedDoc = syncPresetWithScan(scanned, baseDoc, { useOrganizedPaths: false });
        if (!preserveUnsavedDoc) {
          syncedDoc.disabledSectionIds = computeInitialDisabledSectionIds(
            syncedDoc,
            allConfigsDoc,
            exportedDoc
          );
          setExportedSectionIds(Object.keys(exportedDoc.models));
        }

        setScanResult(scanned);
        setPlan(orgPlan);
        setPresetDoc(syncedDoc);
        if (!preserveUnsavedDoc) {
          setTestSettings(loadedSettings);
          setTestStatuses(loadedStatuses);
        }
        setStatusMessage(
          `Found ${scanned.files.length} GGUF file(s) across ${scanned.groups.length} model group(s).`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMessage(`Error scanning directory: ${msg}`);
      } finally {
        setIsBusy(false);
      }
    },
    [modelsDir, presetPath]
  );

  useEffect(() => {
    void refreshScanAndPreset();
  }, [refreshScanAndPreset]);

  const handleSavePreset = useCallback(async () => {
    try {
      const disabledSet = new Set(presetDoc.disabledSectionIds ?? []);
      const allSectionIds = Object.keys(presetDoc.models);
      const nextExportedIds = allSectionIds.filter((id) => !disabledSet.has(id));
      const totalCount = allSectionIds.length;
      const exportedCount = nextExportedIds.length;

      await Promise.all([
        savePresetFile(presetPath, presetDoc, { excludeDisabled: true }),
        saveAllConfigsAvailableFile(modelsDir, presetDoc),
        saveAppTestSettings(presetPath, testSettings),
      ]);
      setExportedSectionIds(nextExportedIds);
      setHasUnsavedChanges(false);
      setStatusMessage(
        `Saved ${exportedCount}/${totalCount} active model(s) to ${presetPath} and all ${totalCount} configs to ${ALL_CONFIGS_AVAILABLE_FILENAME}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Failed to save preset: ${msg}`);
    }
  }, [modelsDir, presetPath, presetDoc, testSettings]);

  const handleExecuteOrganize = useCallback(async (): Promise<OrganizationResult> => {
    if (!plan) {
      return { movedCount: 0, skippedCount: 0, removedDirsCount: 0, errors: [] };
    }
    setIsBusy(true);
    setStatusMessage('Organizing GGUF files in-place...');
    try {
      const result = await executeOrganizationPlan(plan);
      // Rescan after moving so all file paths reflect the new organized tree
      const rescanned = await scanModelsDirectory(modelsDir);
      const newPlan = await createOrganizationPlan(rescanned);
      const synced = syncPresetWithScan(rescanned, presetDoc, { useOrganizedPaths: false });

      setScanResult(rescanned);
      setPlan(newPlan);
      setPresetDoc(synced);
      setHasUnsavedChanges(true);
      setStatusMessage(
        `Organized ${result.movedCount} file(s). Press Ctrl+S to save updated paths to ${presetPath}.`
      );
      return result;
    } finally {
      setIsBusy(false);
    }
  }, [plan, modelsDir, presetDoc, presetPath]);

  useInput((input, key) => {
    // Allow Ctrl+S from anywhere to save the preset file and app settings
    if (key.ctrl && input === 's') {
      void handleSavePreset();
      return;
    }

    if (isEditingText) {
      return;
    }

    // Only exit the application on 'q' when at the top-level menu (not inside a sub-screen)
    if (input === 'q') {
      if (!isInSubScreen) {
        exit();
      }
      return;
    }

    if (key.tab) {
      const order: ActiveTab[] = [
        'models-config',
        'common-config',
        'scan-organize',
        'app-settings',
        'llama-serve',
      ];
      const step = key.shift ? -1 : 1;
      const nextIdx = (order.indexOf(activeTab) + step + order.length) % order.length;
      setActiveTab(order[nextIdx]);
      return;
    }

    if (!isInSubScreen) {
      if (input === '1') {
        setActiveTab('models-config');
      } else if (input === '2') {
        setActiveTab('common-config');
      } else if (input === '3') {
        setActiveTab('scan-organize');
      } else if (input === '4') {
        setActiveTab('app-settings');
      } else if (input === '5') {
        setActiveTab('llama-serve');
      }
    }
  });

  const handleUpdateCommon = (updatedCommon: CommonPresetConfig) => {
    setPresetDoc((prev) => ({
      ...prev,
      common: updatedCommon,
    }));
    setHasUnsavedChanges(true);
  };

  const handleUpdateModel = (sectionId: string, updatedSection: ModelPresetSection) => {
    setPresetDoc((prev) => ({
      ...prev,
      models: {
        ...prev.models,
        [sectionId]: updatedSection,
      },
    }));
    setHasUnsavedChanges(true);
  };

  const handleToggleSectionEnabled = (sectionId: string) => {
    setPresetDoc((prev) => {
      const disabledSet = new Set(prev.disabledSectionIds ?? []);
      if (disabledSet.has(sectionId)) {
        disabledSet.delete(sectionId);
      } else {
        disabledSet.add(sectionId);
      }
      return {
        ...prev,
        disabledSectionIds: Array.from(disabledSet),
      };
    });
    setHasUnsavedChanges(true);
  };

  const handleToggleModelEnabled = (sectionIds: string[], targetState?: boolean) => {
    if (sectionIds.length === 0) return;
    setPresetDoc((prev) => {
      const disabledSet = new Set(prev.disabledSectionIds ?? []);
      // If targetState is provided: true = enable all (remove from disabledSet), false = disable all (add to disabledSet)
      // Otherwise toggle: if any is enabled, disable all; if all are disabled, enable all
      const allDisabled = sectionIds.every((id) => disabledSet.has(id));
      const shouldEnable = targetState !== undefined ? targetState : allDisabled;

      for (const id of sectionIds) {
        if (shouldEnable) {
          disabledSet.delete(id);
        } else {
          disabledSet.add(id);
        }
      }
      return {
        ...prev,
        disabledSectionIds: Array.from(disabledSet),
      };
    });
    setHasUnsavedChanges(true);
  };

  const handleDeleteModel = (sectionId: string) => {
    setPresetDoc((prev) => {
      const nextModels = { ...prev.models };
      delete nextModels[sectionId];
      return {
        ...prev,
        models: nextModels,
      };
    });
    setTestStatuses((prev) => {
      if (!(sectionId in prev)) return prev;
      const next = { ...prev };
      delete next[sectionId];
      return next;
    });
    setHasUnsavedChanges(true);
  };

  const handleUpdateTestStatus = useCallback(
    (
      sectionId: string,
      statusOrUpdater:
        | SectionTestStatus
        | ((prevStatus: SectionTestStatus | undefined) => SectionTestStatus)
    ) => {
      setTestStatuses((prev) => {
        const nextEntry =
          typeof statusOrUpdater === 'function'
            ? statusOrUpdater(prev[sectionId])
            : statusOrUpdater;
        const next = {
          ...prev,
          [sectionId]: nextEntry,
        };
        if (nextEntry.status === 'passed' || nextEntry.status === 'failed') {
          void saveSectionTestStatuses(presetPath, next);
        }
        return next;
      });
    },
    [presetPath]
  );

  const handleUpdateTestSettings = (updatedSettings: AppTestSettings) => {
    setTestSettings(updatedSettings);
    void saveAppTestSettings(presetPath, updatedSettings);
    setStatusMessage(
      `Updated test runner settings (Command: "${updatedSettings.testCommand}", Prompt: "${updatedSettings.defaultPrompt}")`
    );
  };

  // Reserve 1 row safety margin at bottom so terminal doesn't auto-scroll the fixed top Header off-screen
  const viewportRows = Math.max(12, rows - 1);
  const contentHeight = Math.max(6, viewportRows - HEADER_HEIGHT);

  const disabledIds = presetDoc.disabledSectionIds ?? [];
  const totalModelCount = Object.keys(presetDoc.models).length;
  const enabledModelCount = Math.max(0, totalModelCount - disabledIds.length);

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={viewportRows}
      overflowY="hidden"
      overflowX="hidden"
    >
      <Header
        activeTab={activeTab}
        modelsDir={modelsDir}
        presetPath={presetPath}
        modelCount={enabledModelCount}
        totalModelCount={totalModelCount}
        hasUnsavedChanges={hasUnsavedChanges}
        isServerRunning={serverState.status === 'running' || serverState.status === 'starting'}
        statusMessage={statusMessage}
        columns={columns}
      />

      {isBusy || !scanResult || !plan ? (
        <Box padding={1} width={columns} height={contentHeight}>
          <Text color="yellow" wrap="truncate-end">
            ⏳ Working... {statusMessage}
          </Text>
        </Box>
      ) : (
        <Box width={columns} height={contentHeight} overflowY="hidden" overflowX="hidden">
          {activeTab === 'scan-organize' && (
            <ScanOrganizeView
              scanResult={scanResult}
              plan={plan}
              isBusy={isBusy}
              onRescan={() => refreshScanAndPreset(presetDoc)}
              onExecuteOrganize={handleExecuteOrganize}
              onSubScreenChange={setIsInSubScreen}
              contentHeight={contentHeight}
              columns={columns}
            />
          )}

          {activeTab === 'common-config' && (
            <CommonConfigView
              common={presetDoc.common}
              onChange={handleUpdateCommon}
              onEditingTextChange={setIsEditingText}
              onSubScreenChange={setIsInSubScreen}
              contentHeight={contentHeight}
              columns={columns}
            />
          )}

          {activeTab === 'models-config' && (
            <ModelListView
              scanResult={scanResult}
              common={presetDoc.common}
              models={presetDoc.models}
              disabledSectionIds={presetDoc.disabledSectionIds ?? []}
              exportedSectionIds={exportedSectionIds}
              testSettings={testSettings}
              onUpdateTestSettings={handleUpdateTestSettings}
              testStatuses={testStatuses}
              onUpdateTestStatus={handleUpdateTestStatus}
              onToggleSectionEnabled={handleToggleSectionEnabled}
              onToggleModelEnabled={handleToggleModelEnabled}
              onUpdateModel={handleUpdateModel}
              onDeleteModel={handleDeleteModel}
              onEditingTextChange={setIsEditingText}
              onSubScreenChange={setIsInSubScreen}
              contentHeight={contentHeight}
              columns={columns}
            />
          )}

          {activeTab === 'app-settings' && (
            <AppSettingsView
              settings={testSettings}
              onChange={handleUpdateTestSettings}
              onEditingTextChange={setIsEditingText}
              contentHeight={contentHeight}
              columns={columns}
            />
          )}

          {activeTab === 'llama-serve' && (
            <ServerView
              presetPath={presetPath}
              serveCommand={testSettings.serveCommand ?? 'llama serve'}
              serveHost={testSettings.serveHost ?? DEFAULT_SERVE_HOST}
              servePort={testSettings.servePort ?? DEFAULT_SERVE_PORT}
              hasUnsavedChanges={hasUnsavedChanges}
              serverState={serverState}
              logLines={serverLogs}
              verbosity={serverVerbosity}
              onStart={handleStartServer}
              onStop={() => void handleStopServer()}
              onRestart={() => void handleRestartServer()}
              onToggleVerbosity={() =>
                setServerVerbosity((prev) => (prev === 'minimal' ? 'all' : 'minimal'))
              }
              onClearLogs={() => setServerLogs([])}
              contentHeight={contentHeight}
              columns={columns}
            />
          )}
        </Box>
      )}
    </Box>
  );
};
