import React from 'react';
import { Box, Text } from 'ink';
import { truncateMiddle } from '../hooks/useTerminalSize.js';

export type ActiveTab =
  | 'models-config'
  | 'common-config'
  | 'scan-organize'
  | 'app-settings'
  | 'llama-serve';

export interface HeaderProps {
  activeTab: ActiveTab;
  modelsDir: string;
  presetPath: string;
  modelCount: number;
  totalModelCount?: number;
  hasUnsavedChanges: boolean;
  isServerRunning?: boolean;
  statusMessage?: string | null;
  columns: number;
}

const TABS: Array<{ id: ActiveTab; label: string; shortcut: string }> = [
  { id: 'models-config', label: '1. Models Config', shortcut: '1' },
  { id: 'common-config', label: '2. [*] Common Settings', shortcut: '2' },
  { id: 'scan-organize', label: '3. Scan & Organize', shortcut: '3' },
  { id: 'app-settings', label: '4. Test & App Settings', shortcut: '4' },
  { id: 'llama-serve', label: '5. llama serve', shortcut: '5' },
];

export const HEADER_HEIGHT = 5;

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  modelsDir,
  presetPath,
  modelCount,
  totalModelCount,
  hasUnsavedChanges,
  isServerRunning = false,
  statusMessage,
  columns,
}) => {
  const maxPathLen = Math.max(12, Math.floor((columns - 58) / 2));

  const modelCountDisplay =
    totalModelCount !== undefined && totalModelCount !== modelCount
      ? `${modelCount}/${totalModelCount} active`
      : `${modelCount}`;

  return (
    <Box flexDirection="column" width={columns} height={HEADER_HEIGHT} flexShrink={0}>
      {/* Row 1-3: Top bordered title & path bar */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        justifyContent="space-between"
        width={columns}
      >
        <Box overflowX="hidden">
          <Text bold color="cyan" wrap="truncate-end">
            🦙 llamacpp-ui-manager
          </Text>
          <Text color="gray"> │ </Text>
          <Text wrap="truncate-end">
            Dir: <Text color="yellow">{truncateMiddle(modelsDir, maxPathLen)}</Text>
          </Text>
          <Text color="gray"> │ </Text>
          <Text wrap="truncate-end">
            Preset: <Text color="green">{truncateMiddle(presetPath, maxPathLen)}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text wrap="truncate-end">
            Models: <Text bold>{modelCountDisplay}</Text>
          </Text>
          {isServerRunning && (
            <Text color="green" bold wrap="truncate-end">
              {' '}
              [● Serve]
            </Text>
          )}
          {hasUnsavedChanges && (
            <Text color="yellow" bold wrap="truncate-end">
              {' '}
              [● Unsaved - Ctrl+S]
            </Text>
          )}
        </Box>
      </Box>

      {/* Row 4: Fixed Menu Bar */}
      <Box justifyContent="space-between" paddingX={1} width={columns}>
        <Box gap={1} overflowX="hidden">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <Box key={tab.id} flexShrink={0}>
                <Text
                  bold={isActive}
                  color={isActive ? 'black' : 'white'}
                  backgroundColor={isActive ? 'cyan' : undefined}
                  wrap="truncate-end"
                >
                  {` [${tab.shortcut}] ${tab.label} `}
                </Text>
              </Box>
            );
          })}
        </Box>
        {columns >= 145 && (
          <Box flexShrink={0}>
            <Text color="gray" wrap="truncate-end">
              [Tab/S-Tab/1-5] View │ [Ctrl+S] Save │ [q] Quit
            </Text>
          </Box>
        )}
      </Box>

      {/* Row 5: Single-line Status Bar */}
      <Box paddingX={1} width={columns} height={1}>
        <Text color="green" wrap="truncate-end">
          {statusMessage ? `ℹ ${statusMessage}` : ' '}
        </Text>
      </Box>
    </Box>
  );
};
