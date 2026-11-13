import * as path from 'node:path';
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  OrganizationPlan,
  OrganizationResult,
  ScanResult,
} from '../../types/index.js';
import { computeScrollWindow, truncateMiddle } from '../hooks/useTerminalSize.js';

export interface ScanOrganizeViewProps {
  scanResult: ScanResult;
  plan: OrganizationPlan;
  isBusy: boolean;
  onRescan: () => Promise<void>;
  onExecuteOrganize: () => Promise<OrganizationResult>;
  onSubScreenChange?: (inSubScreen: boolean) => void;
  contentHeight: number;
  columns: number;
}

type SubView = 'groups' | 'preview-plan' | 'confirm-organize';

export const ScanOrganizeView: React.FC<ScanOrganizeViewProps> = ({
  scanResult,
  plan,
  isBusy,
  onRescan,
  onExecuteOrganize,
  onSubScreenChange,
  contentHeight,
  columns,
}) => {
  const [subView, setSubViewState] = useState<SubView>('groups');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lastResult, setLastResult] = useState<OrganizationResult | null>(null);

  const setSubView = (next: SubView) => {
    setSubViewState(next);
    onSubScreenChange?.(next !== 'groups');
  };

  const pendingMoves = plan.operations.filter((op) => op.status === 'pending');
  const alreadyOrganized = plan.operations.filter((op) => op.status === 'already-organized');

  useInput(
    (input, key) => {
      if (isBusy) return;

      if (subView === 'confirm-organize') {
        if (input === 'y' || input === 'Y' || key.return) {
          void onExecuteOrganize().then((res) => {
            setLastResult(res);
            setSubView('groups');
            setSelectedIndex(0);
          });
        } else if (input === 'n' || input === 'N' || input === 'q' || key.escape) {
          setSubView('preview-plan');
        }
        return;
      }

      if (subView === 'preview-plan' && (key.escape || input === 'q' || input === 'b')) {
        setSubView('groups');
        setSelectedIndex(0);
        return;
      }

      const maxItems =
        subView === 'groups'
          ? Math.max(0, scanResult.groups.length - 1)
          : Math.max(0, plan.operations.length - 1);

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(maxItems, prev + 1));
      } else if (input === 'p') {
        setSubView(subView === 'groups' ? 'preview-plan' : 'groups');
        setSelectedIndex(0);
      } else if (input === 'r') {
        setLastResult(null);
        void onRescan();
      } else if (input === 'o') {
        if (pendingMoves.length > 0) {
          setSubView('confirm-organize');
        }
      }
    },
    { isActive: true }
  );

  const innerWidth = Math.max(40, columns - 2);

  // Calculate how many rows are available for the scrollable list
  const selectedGroup = scanResult.groups[selectedIndex];
  const expandedExtraRows =
    subView === 'groups' && selectedGroup
      ? selectedGroup.variants.length +
        selectedGroup.mmprojFiles.length +
        selectedGroup.mtpFiles.length
      : 0;

  const reservedRows =
    4 + // Summary bar + section header
    (lastResult ? 3 : 0) +
    (subView === 'confirm-organize' ? 6 : 0) +
    (scanResult.orphanAuxFiles.length > 0 && subView === 'groups' ? 3 : 0) +
    expandedExtraRows +
    2; // Scroll indicators

  const maxVisibleListItems = Math.max(2, contentHeight - reservedRows);

  const groupsWindow = computeScrollWindow(
    scanResult.groups.length,
    selectedIndex,
    maxVisibleListItems
  );
  const visibleGroups = scanResult.groups.slice(groupsWindow.startIndex, groupsWindow.endIndex);

  const planWindow = computeScrollWindow(
    plan.operations.length,
    selectedIndex,
    Math.max(3, contentHeight - 7)
  );
  const visibleOps = plan.operations.slice(planWindow.startIndex, planWindow.endIndex);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={columns}
      height={contentHeight}
      overflowY="hidden"
      overflowX="hidden"
    >
      {/* Summary Bar */}
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        justifyContent="space-between"
        width={innerWidth}
        flexShrink={0}
      >
        <Box gap={2} overflowX="hidden">
          <Text wrap="truncate-end">
            GGUFs: <Text bold>{scanResult.files.length}</Text>
          </Text>
          <Text wrap="truncate-end">
            Groups: <Text bold color="cyan">{scanResult.groups.length}</Text>
          </Text>
          <Text wrap="truncate-end">
            Pending:{' '}
            <Text bold color={pendingMoves.length > 0 ? 'yellow' : 'green'}>
              {pendingMoves.length}
            </Text>
          </Text>
          <Text wrap="truncate-end">
            Organized: <Text bold color="green">{alreadyOrganized.length}</Text>
          </Text>
          {plan.conflicts.length > 0 && (
            <Text color="red" bold wrap="truncate-end">
              Conflicts: {plan.conflicts.length}
            </Text>
          )}
          {scanResult.orphanAuxFiles.length > 0 && (
            <Text color="magenta" bold wrap="truncate-end">
              Unpaired: {scanResult.orphanAuxFiles.length}
            </Text>
          )}
        </Box>

        <Box flexShrink={0}>
          <Text color="gray" wrap="truncate-end">
            [p] {subView === 'groups' ? 'Dry-Run Plan' : 'Groups'} │ [r] Rescan │ [o] Organize
          </Text>
        </Box>
      </Box>

      {lastResult && (
        <Box
          borderStyle="round"
          borderColor={lastResult.errors.length > 0 ? 'red' : 'green'}
          paddingX={1}
          width={innerWidth}
          flexShrink={0}
        >
          <Text color={lastResult.errors.length > 0 ? 'red' : 'green'} wrap="truncate-end">
            ✓ Organization complete: {lastResult.movedCount} moved, {lastResult.skippedCount} skipped,{' '}
            {lastResult.removedDirsCount} empty dirs cleaned up
            {lastResult.errors.length > 0 ? `, ${lastResult.errors.length} errors` : ''}.
          </Text>
        </Box>
      )}

      {subView === 'confirm-organize' && (
        <Box
          borderStyle="double"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
          width={innerWidth}
          flexShrink={0}
        >
          <Text bold color="yellow" wrap="truncate-end">
            ⚠ Confirm In-Place Directory Organization ({pendingMoves.length} file moves)
          </Text>
          <Text wrap="truncate-end">
            Target tree: <Text color="cyan">{`<family>/<model-name>/<quantization>/`}</Text> (shared{' '}
            <Text color="magenta">mmproj</Text> & <Text color="blue">mtp</Text> at{' '}
            <Text color="cyan">{`<family>/<model-name>/`}</Text>).
          </Text>
          <Box>
            <Text bold color="green" wrap="truncate-end">
              [Y / Enter] Confirm & Move Files
            </Text>
            <Text color="gray"> │ </Text>
            <Text bold color="red" wrap="truncate-end">
              [N / Esc] Cancel
            </Text>
          </Box>
        </Box>
      )}

      {subView === 'groups' && (
        <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
          <Box justifyContent="space-between" width={innerWidth}>
            <Text bold underline wrap="truncate-end">
              Discovered Model Families & Paired Auxiliary Files (mmproj / mtp):
            </Text>
            {scanResult.groups.length > 0 && (
              <Text color="gray" wrap="truncate-end">
                [{selectedIndex + 1}/{scanResult.groups.length}] [↑/↓] Scroll
              </Text>
            )}
          </Box>

          {groupsWindow.hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↑ ({groupsWindow.startIndex} more model group(s) above)
            </Text>
          )}

          {scanResult.groups.length === 0 ? (
            <Text color="gray" italic wrap="truncate-end">
              No GGUF models found in {scanResult.rootDir}.
            </Text>
          ) : (
            visibleGroups.map((group, localIdx) => {
              const idx = groupsWindow.startIndex + localIdx;
              const isSelected = idx === selectedIndex;
              return (
                <Box
                  key={`${group.family}::${group.modelName}`}
                  flexDirection="column"
                  paddingX={1}
                  width={innerWidth}
                  overflowX="hidden"
                >
                  <Box gap={1} width={innerWidth - 2} overflowX="hidden">
                    <Text color={isSelected ? 'cyan' : 'white'} bold wrap="truncate-end">
                      {isSelected ? '❯' : ' '} [{group.family}] {group.modelName}
                    </Text>
                    <Text color="gray" wrap="truncate-end">
                      ({group.variants.length} quant{group.variants.length === 1 ? '' : 's'})
                    </Text>
                    {group.mmprojFiles.length > 0 && (
                      <Text color="magenta" bold wrap="truncate-end">
                        [+mmproj]
                      </Text>
                    )}
                    {group.mtpFiles.length > 0 && (
                      <Text color="blue" bold wrap="truncate-end">
                        [+model-draft/mtp]
                      </Text>
                    )}
                  </Box>

                  {isSelected && (
                    <Box flexDirection="column" paddingLeft={3} width={innerWidth - 2} overflowX="hidden">
                      {group.variants.map((v) => (
                        <Box key={v.id} gap={1} overflowX="hidden">
                          <Text color="green" wrap="truncate-end">
                            • Quant {v.quantization}:
                          </Text>
                          <Text wrap="truncate-end">
                            {truncateMiddle(v.primaryFile.fileName, Math.max(20, innerWidth - 42))}
                          </Text>
                          {v.allShardFiles.length > 1 && (
                            <Text color="yellow" wrap="truncate-end">
                              ({v.allShardFiles.length} shards)
                            </Text>
                          )}
                          <Text color="gray" wrap="truncate-end">
                            → [{v.id}]
                          </Text>
                        </Box>
                      ))}
                      {group.mmprojFiles.map((mm) => (
                        <Box key={mm.filePath} gap={1} overflowX="hidden">
                          <Text color="magenta" wrap="truncate-end">
                            • Shared mmproj:
                          </Text>
                          <Text wrap="truncate-end">
                            {truncateMiddle(mm.fileName, Math.max(20, innerWidth - 25))}
                          </Text>
                        </Box>
                      ))}
                      {group.mtpFiles.map((mtp) => (
                        <Box key={mtp.filePath} gap={1} overflowX="hidden">
                          <Text color="blue" wrap="truncate-end">
                            • Shared model-draft (MTP):
                          </Text>
                          <Text wrap="truncate-end">
                            {truncateMiddle(mtp.fileName, Math.max(20, innerWidth - 35))}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              );
            })
          )}

          {groupsWindow.hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↓ ({scanResult.groups.length - groupsWindow.endIndex} more model group(s) below)
            </Text>
          )}

          {scanResult.orphanAuxFiles.length > 0 && (
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="magenta"
              paddingX={1}
              width={innerWidth}
              flexShrink={0}
            >
              <Text bold color="magenta" wrap="truncate-end">
                Unpaired Auxiliary Files ({scanResult.orphanAuxFiles.length}):
              </Text>
              {scanResult.orphanAuxFiles.slice(0, 2).map((orf) => (
                <Text key={orf.filePath} color="gray" wrap="truncate-end">
                  • [{orf.role}] {orf.fileName}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {subView === 'preview-plan' && (
        <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
          <Box justifyContent="space-between" width={innerWidth}>
            <Text bold underline wrap="truncate-end">
              Dry-Run Directory Organization Plan ({`<family>/<model-name>/<quantization>/`}):
            </Text>
            <Text color="yellow" bold wrap="truncate-end">
              [{selectedIndex + 1}/{ Math.max(1, plan.operations.length) }] {pendingMoves.length > 0 ? 'Press [o] to execute moves' : 'All organized'}
            </Text>
          </Box>

          {planWindow.hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↑ ({planWindow.startIndex} more above)
            </Text>
          )}

          {plan.operations.length === 0 ? (
            <Text color="gray" wrap="truncate-end">
              No operations planned.
            </Text>
          ) : (
            visibleOps.map((op, localIdx) => {
              const idx = planWindow.startIndex + localIdx;
              const isSelected = idx === selectedIndex;
              const relSrc = path.relative(scanResult.rootDir, op.sourcePath);
              const relDest = path.relative(scanResult.rootDir, op.destinationPath);
              const statusColor =
                op.status === 'already-organized'
                  ? 'green'
                  : op.status === 'conflict'
                  ? 'red'
                  : 'yellow';
              const pathBudget = Math.max(18, Math.floor((innerWidth - 32) / 2));

              return (
                <Box
                  key={`${op.sourcePath}->${op.destinationPath}`}
                  flexDirection="column"
                  width={innerWidth}
                  overflowX="hidden"
                >
                  <Box gap={1} width={innerWidth} overflowX="hidden">
                    <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                      {isSelected ? '❯' : ' '}
                    </Text>
                    <Text color={statusColor} bold wrap="truncate-end">
                      [{op.status.toUpperCase()}]
                    </Text>
                    <Text color="gray" wrap="truncate-end">
                      ({op.role})
                    </Text>
                    <Text wrap="truncate-end">{truncateMiddle(relSrc, pathBudget)}</Text>
                    <Text color="cyan">→</Text>
                    <Text color="green" wrap="truncate-end">
                      {truncateMiddle(relDest, pathBudget)}
                    </Text>
                  </Box>
                  {isSelected && op.errorMessage && (
                    <Box paddingLeft={4}>
                      <Text color="red" wrap="truncate-end">
                        ⚠ {op.errorMessage}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })
          )}

          {planWindow.hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↓ ({plan.operations.length - planWindow.endIndex} more below)
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
};
