import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  ModelCatalogEntry,
  ModelCombinationSlot,
  ModelPresetSection,
  SectionTestStatus,
} from '../../types/index.js';
import {
  createSectionForSlot,
  getAvailableCombinationSlots,
  getSectionCombinationKey,
  hasMmproj,
  hasModelDraft,
  sanitizeDraftOptions,
} from '../../core/preset-config.js';
import {
  compareTokensPerSecond,
  getModelAggregateTestStatus,
  getSectionTestStatus,
  getTestStatusColor,
} from '../../core/model-tester.js';
import { computeScrollWindow, isNarrowTerminal, truncateMiddle } from '../hooks/useTerminalSize.js';
import { BottomTextEditorBar } from './BottomTextEditorBar.js';

export interface ModelProfilesBuilderViewProps {
  entry: ModelCatalogEntry;
  allModels: Record<string, ModelPresetSection>;
  entrySections: ModelPresetSection[];
  testStatuses?: Record<string, SectionTestStatus>;
  onTestAllModelConfigs?: () => void;
  onSaveSection: (sectionId: string, section: ModelPresetSection) => void;
  onRemoveSection: (sectionId: string) => void;
  onOpenSectionEditor: (sectionId: string) => void;
  onBack: () => void;
  onEditingTextChange?: (editing: boolean) => void;
  contentHeight: number;
  columns: number;
}

type BuilderMode = 'slots' | 'custom-builder';
type CustomBuilderField = 'sectionId' | 'mmproj' | 'mtp' | 'create';

export const ModelProfilesBuilderView: React.FC<ModelProfilesBuilderViewProps> = ({
  entry,
  allModels,
  entrySections,
  testStatuses = {},
  onTestAllModelConfigs,
  onSaveSection,
  onRemoveSection,
  onOpenSectionEditor,
  onBack,
  onEditingTextChange,
  contentHeight,
  columns,
}) => {
  const slots = useMemo(() => getAvailableCombinationSlots(entry), [entry]);
  const hasVisionAvailable = Boolean(entry.primaryMmprojPath);
  const hasDraftAvailable = Boolean(entry.primaryMtpPath);

  const [mode, setMode] = useState<BuilderMode>('slots');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Custom profile builder state
  const [customFieldIndex, setCustomFieldIndex] = useState(0);
  const [isTypingId, setIsTypingId] = useState(false);
  const [renamingSection, setRenamingSection] = useState<ModelPresetSection | null>(null);
  const [customId, setCustomId] = useState(`${entry.variantId}-custom`);
  const [customUseVision, setCustomUseVision] = useState(hasVisionAvailable);
  const [customUseDraft, setCustomUseDraft] = useState(hasDraftAvailable);

  const customFields: CustomBuilderField[] = useMemo(() => {
    const list: CustomBuilderField[] = ['sectionId'];
    if (hasVisionAvailable) list.push('mmproj');
    if (hasDraftAvailable) list.push('mtp');
    list.push('create');
    return list;
  }, [hasVisionAvailable, hasDraftAvailable]);

  // Map each standard combination slot key to the first matching section (if enabled)
  const slotToSectionMap = useMemo(() => {
    const map = new Map<ModelCombinationSlot['key'], ModelPresetSection>();
    for (const sec of entrySections) {
      const key = getSectionCombinationKey(sec);
      if (!map.has(key)) {
        map.set(key, sec);
      }
    }
    return map;
  }, [entrySections]);

  // Combined list of rows in 'slots' mode: first all standard combination slots, then any extra custom sections
  const extraSections = useMemo(() => {
    const standardIds = new Set(Array.from(slotToSectionMap.values()).map((s) => s.sectionId));
    return entrySections.filter((s) => !standardIds.has(s.sectionId));
  }, [entrySections, slotToSectionMap]);

  const totalSlotRows = slots.length + extraSections.length;

  const updateTyping = (typing: boolean) => {
    setIsTypingId(typing);
    onEditingTextChange?.(typing);
  };

  const toggleSlot = (slot: ModelCombinationSlot) => {
    const existing = slotToSectionMap.get(slot.key);
    if (existing) {
      // Prevent deleting the very last configuration of a model so it never disappears completely unless user wants
      if (entrySections.length <= 1) {
        return;
      }
      onRemoveSection(existing.sectionId);
    } else {
      const template = entrySections[0];
      const created = createSectionForSlot(entry, slot, allModels, undefined, template);
      onSaveSection(created.sectionId, created);
    }
  };

  useInput(
    (input, key) => {
      if (mode === 'custom-builder') {
        if (isTypingId) {
          return;
        }

        if (key.escape || input === 'q' || input === 'b') {
          setMode('slots');
          return;
        }

        if (key.upArrow) {
          setCustomFieldIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setCustomFieldIndex((prev) => Math.min(customFields.length - 1, prev + 1));
        } else if (input === ' ' || key.return) {
          const activeField = customFields[customFieldIndex];
          if (activeField === 'sectionId') {
            updateTyping(true);
          } else if (activeField === 'mmproj' && hasVisionAvailable) {
            setCustomUseVision((prev) => !prev);
          } else if (activeField === 'mtp' && hasDraftAvailable) {
            setCustomUseDraft((prev) => !prev);
          } else if (activeField === 'create') {
            const trimmedId = customId.trim() || `${entry.variantId}-custom`;
            const template = entrySections[0];
            const newSection: ModelPresetSection = template
              ? {
                  ...template,
                  sectionId: trimmedId,
                  model: entry.modelPath,
                  custom: { ...template.custom },
                }
              : {
                  sectionId: trimmedId,
                  model: entry.modelPath,
                  custom: {},
                };

            if (customUseVision && entry.primaryMmprojPath) {
              newSection.mmproj = entry.primaryMmprojPath;
            } else {
              delete newSection.mmproj;
            }

            if (customUseDraft && entry.primaryMtpPath) {
              newSection['model-draft'] = entry.primaryMtpPath;
              if (newSection['spec-type'] === undefined) {
                newSection['spec-type'] = 'draft-mtp';
              }
            } else {
              delete newSection['model-draft'];
            }

            sanitizeDraftOptions(newSection);
            onSaveSection(newSection.sectionId, newSection);
            setMode('slots');
          }
        }
        return;
      }

      // 'slots' mode
      if (renamingSection) {
        return;
      }

      if (key.escape || input === 'q' || input === 'b') {
        onBack();
        return;
      }

      if (input === 't' && entrySections.length > 0 && onTestAllModelConfigs) {
        onTestAllModelConfigs();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.max(0, totalSlotRows - 1), prev + 1));
      } else if (input === 'n' || input === 'a') {
        setCustomId(`${entry.variantId}-profile-${entrySections.length + 1}`);
        setCustomUseVision(hasVisionAvailable);
        setCustomUseDraft(hasDraftAvailable);
        setCustomFieldIndex(0);
        setMode('custom-builder');
      } else if (input === ' ') {
        if (selectedIndex < slots.length) {
          toggleSlot(slots[selectedIndex]);
        } else {
          const extraSec = extraSections[selectedIndex - slots.length];
          if (extraSec && entrySections.length > 1) {
            onRemoveSection(extraSec.sectionId);
            setSelectedIndex((prev) => Math.max(0, prev - 1));
          }
        }
      } else if (input === 'r') {
        const targetSec =
          selectedIndex < slots.length
            ? slotToSectionMap.get(slots[selectedIndex].key)
            : extraSections[selectedIndex - slots.length];
        if (targetSec) {
          setRenamingSection(targetSec);
          onEditingTextChange?.(true);
        }
      } else if (key.return || input === 'e') {
        if (selectedIndex < slots.length) {
          const slot = slots[selectedIndex];
          let existing = slotToSectionMap.get(slot.key);
          if (!existing) {
            // Enable & open immediately for configuration
            const template = entrySections[0];
            existing = createSectionForSlot(entry, slot, allModels, undefined, template);
            onSaveSection(existing.sectionId, existing);
          }
          onOpenSectionEditor(existing.sectionId);
        } else {
          const extraSec = extraSections[selectedIndex - slots.length];
          if (extraSec) {
            onOpenSectionEditor(extraSec.sectionId);
          }
        }
      }
    },
    { isActive: !isTypingId && !renamingSection }
  );

  const innerWidth = Math.max(40, columns - 2);
  const maxVisibleRows = Math.max(3, contentHeight - 9);
  const { startIndex, endIndex, hasMoreAbove, hasMoreBelow } = computeScrollWindow(
    totalSlotRows,
    selectedIndex,
    maxVisibleRows
  );

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={columns}
      height={contentHeight}
      overflowY="hidden"
      overflowX="hidden"
    >
      {/* Top Header Banner */}
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
        width={innerWidth}
        flexShrink={0}
      >
        <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
          <Box gap={1} overflowX="hidden">
            <Text
              color={getTestStatusColor(getModelAggregateTestStatus(entrySections, testStatuses))}
              bold
            >
              ●
            </Text>
            <Text bold color="cyan" wrap="truncate-end">
              🎛 Configuration Profiles for: {entry.variantId}
            </Text>
            <Text color="yellow" bold wrap="truncate-end">
              ({entrySections.length} active configuration{entrySections.length === 1 ? '' : 's'})
            </Text>
          </Box>
          {!isNarrowTerminal(columns) && (
            <Box flexShrink={0} gap={1}>
              {entrySections.length > 0 && (
                <Text color="black" backgroundColor="green" bold wrap="truncate-end">
                  {' [t] ▶ Test All Model Configs '}
                </Text>
              )}
              <Text color="yellow" bold wrap="truncate-end">
                [Esc / q] Back to Models
              </Text>
            </Box>
          )}
        </Box>

        <Box gap={2} width={innerWidth - 2} overflowX="hidden">
          <Text color="gray" wrap="truncate-end">
            Available Elements:
          </Text>
          <Text color="green" bold wrap="truncate-end">
            [✓ Base: {entry.quantization}]
          </Text>
          {hasVisionAvailable ? (
            <Text color="magenta" bold wrap="truncate-end">
              [✓ Vision mmproj available]
            </Text>
          ) : (
            <Text color="gray" wrap="truncate-end">
              [✗ No mmproj]
            </Text>
          )}
          {hasDraftAvailable ? (
            <Text color="blue" bold wrap="truncate-end">
              [✓ Draft / MTP available]
            </Text>
          ) : (
            <Text color="gray" wrap="truncate-end">
              [✗ No MTP]
            </Text>
          )}
        </Box>
      </Box>

      {mode === 'custom-builder' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginTop={1}
          width={innerWidth}
          overflowX="hidden"
        >
          <Text bold color="yellow" wrap="truncate-end">
            ➕ Create Custom Model Configuration Profile ([Esc / q] Cancel)
          </Text>
          <Text color="gray" wrap="truncate-end">
            Toggle which elements (mmproj / mtp) to include in this preset configuration:
          </Text>

          {customFields.map((field, idx) => {
            const isSel = idx === customFieldIndex;
            if (field === 'sectionId') {
              return (
                <Box key="sectionId" paddingX={1} marginTop={1}>
                  <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                    {isSel ? '❯ ' : '  '}Preset Section Name:{' '}
                  </Text>
                  <Text color="yellow" bold>
                    [{customId}{isTypingId ? '█' : ''}]
                  </Text>
                  <Text color="gray">
                    {' '}
                    {isTypingId ? '(Enter to finish typing)' : '(Press Enter/Space to edit name)'}
                  </Text>
                </Box>
              );
            }
            if (field === 'mmproj') {
              return (
                <Box key="mmproj" paddingX={1}>
                  <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                    {isSel ? '❯ ' : '  '}Include Vision Projector (mmproj):{' '}
                  </Text>
                  <Text color={customUseVision ? 'magenta' : 'gray'} bold>
                    {customUseVision ? '[✓ ENABLED]' : '[  DISABLED]'}
                  </Text>
                  <Text color="gray"> (Space to toggle)</Text>
                </Box>
              );
            }
            if (field === 'mtp') {
              return (
                <Box key="mtp" paddingX={1}>
                  <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                    {isSel ? '❯ ' : '  '}Include Draft / MTP Model (model-draft):{' '}
                  </Text>
                  <Text color={customUseDraft ? 'blue' : 'gray'} bold>
                    {customUseDraft ? '[✓ ENABLED]' : '[  DISABLED]'}
                  </Text>
                  <Text color="gray"> (Space to toggle)</Text>
                </Box>
              );
            }
            return (
              <Box key="create" paddingX={1} marginTop={1}>
                <Text
                  color={isSel ? 'black' : 'green'}
                  backgroundColor={isSel ? 'green' : undefined}
                  bold
                >
                  {isSel ? ' ❯ [Enter / Space] Create Configuration Profile ' : '   [Create Configuration Profile] '}
                </Text>
              </Box>
            );
          })}

          {isTypingId && (
            <Box marginTop={1}>
              <BottomTextEditorBar
                label="Preset Section Name"
                initialValue={customId}
                placeholder="Enter custom preset section ID..."
                columns={columns}
                onSubmit={(val) => {
                  if (val.trim()) {
                    setCustomId(val.trim());
                  }
                  updateTyping(false);
                }}
                onCancel={() => updateTyping(false)}
              />
            </Box>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" width={innerWidth} overflowY="hidden" overflowX="hidden">
          <Box justifyContent="space-between" paddingX={1} width={innerWidth}>
            <Text color="gray" wrap="truncate-end">
              [Space] Enable/Disable │ [Enter/e] Configure │ [r] Rename │ [n] Add Custom Profile
            </Text>
          </Box>

          {hasMoreAbove && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↑ ({startIndex} more above)
            </Text>
          )}

          {Array.from({ length: endIndex - startIndex }, (_, localIdx) => {
            const rowIdx = startIndex + localIdx;
            const isSelected = rowIdx === selectedIndex;

            if (rowIdx < slots.length) {
              const slot = slots[rowIdx];
              const activeSec = slotToSectionMap.get(slot.key);
              const isEnabled = Boolean(activeSec);
              const sectionName = activeSec ? activeSec.sectionId : slot.defaultSectionId;

              return (
                <Box
                  key={slot.key}
                  flexDirection="column"
                  paddingX={1}
                  width={innerWidth}
                  overflowX="hidden"
                >
                  <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
                    <Box gap={1} overflowX="hidden">
                      <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                        {isSelected ? '❯' : ' '}
                      </Text>
                      <Text color={isEnabled ? 'green' : 'gray'} bold={isEnabled}>
                        {isEnabled ? '[✓ ENABLED] ' : '[  DISABLED]'}
                      </Text>
                      <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} wrap="truncate-end">
                        {slot.label}
                      </Text>
                      <Text
                        color={getTestStatusColor(
                          activeSec
                            ? getSectionTestStatus(activeSec.sectionId, testStatuses)
                            : 'untested'
                        )}
                        bold
                      >
                        ●
                      </Text>
                      <Text color="yellow" wrap="truncate-end">
                        → [{sectionName}]
                      </Text>
                      {activeSec &&
                        testStatuses[activeSec.sectionId]?.avgTokensPerSec !== undefined && (
                          <Text color="yellow" bold wrap="truncate-end">
                            ⚡
                            {
                              compareTokensPerSecond(
                                testStatuses[activeSec.sectionId]?.avgTokensPerSec,
                                testStatuses[activeSec.sectionId]?.previousAvgTokensPerSec
                              ).formattedCurrent
                            }{' '}
                            {
                              compareTokensPerSecond(
                                testStatuses[activeSec.sectionId]?.avgTokensPerSec,
                                testStatuses[activeSec.sectionId]?.previousAvgTokensPerSec
                              ).formattedShortComparison
                            }
                          </Text>
                        )}
                    </Box>

                    <Box gap={1} flexShrink={0}>
                      <Text color="green">[Base]</Text>
                      <Text color={slot.useMmproj ? 'magenta' : 'gray'} bold={slot.useMmproj}>
                        {slot.useMmproj ? '[+mmproj]' : '[-mmproj]'}
                      </Text>
                      <Text color={slot.useMtp ? 'blue' : 'gray'} bold={slot.useMtp}>
                        {slot.useMtp ? '[+mtp]' : '[-mtp]'}
                      </Text>
                    </Box>
                  </Box>

                  {isSelected && isEnabled && activeSec && (
                    <Box paddingLeft={4} gap={2} overflowX="hidden">
                      <Text color="gray" wrap="truncate-end">
                        Press [Enter/e] to edit [{activeSec.sectionId}] parameters (ctx, ngl, sampling
                        {slot.useMtp ? ', draft/MTP options' : ''})
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            }

            const extraSec = extraSections[rowIdx - slots.length];
            if (!extraSec) return null;
            const useV = hasMmproj(extraSec);
            const useD = hasModelDraft(extraSec);

            return (
              <Box
                key={extraSec.sectionId}
                flexDirection="column"
                paddingX={1}
                width={innerWidth}
                overflowX="hidden"
              >
                <Box justifyContent="space-between" width={innerWidth - 2} overflowX="hidden">
                  <Box gap={1} overflowX="hidden">
                    <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                      {isSelected ? '❯' : ' '}
                    </Text>
                    <Text color="green" bold>
                      [✓ CUSTOM]  
                    </Text>
                    <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} wrap="truncate-end">
                      Custom Profile
                    </Text>
                    <Text
                      color={getTestStatusColor(
                        getSectionTestStatus(extraSec.sectionId, testStatuses)
                      )}
                      bold
                    >
                      ●
                    </Text>
                    <Text color="yellow" bold wrap="truncate-end">
                      → [{extraSec.sectionId}]
                    </Text>
                  </Box>

                  <Box gap={1} flexShrink={0}>
                    <Text color="green">[Base]</Text>
                    <Text color={useV ? 'magenta' : 'gray'} bold={useV}>
                      {useV ? '[+mmproj]' : '[-mmproj]'}
                    </Text>
                    <Text color={useD ? 'blue' : 'gray'} bold={useD}>
                      {useD ? '[+mtp]' : '[-mtp]'}
                    </Text>
                  </Box>
                </Box>
                {isSelected && (
                  <Box paddingLeft={4} overflowX="hidden">
                    <Text color="gray" wrap="truncate-end">
                      {truncateMiddle(`Press [Enter/e] to edit [${extraSec.sectionId}] or [Space] to remove`, innerWidth - 6)}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}

          {hasMoreBelow && (
            <Text color="gray" dimColor wrap="truncate-end">
              ↓ ({totalSlotRows - endIndex} more below)
            </Text>
          )}
        </Box>
      )}

      {renamingSection && (
        <Box marginTop={1}>
          <BottomTextEditorBar
            label={`Rename [${renamingSection.sectionId}]`}
            initialValue={renamingSection.sectionId}
            placeholder="Enter new model / configuration name..."
            columns={columns}
            onSubmit={(val) => {
              const sanitized = val.replace(/[\[\]]/g, '').trim();
              if (sanitized && sanitized !== renamingSection.sectionId) {
                onSaveSection(renamingSection.sectionId, {
                  ...renamingSection,
                  sectionId: sanitized,
                });
              }
              setRenamingSection(null);
              onEditingTextChange?.(false);
            }}
            onCancel={() => {
              setRenamingSection(null);
              onEditingTextChange?.(false);
            }}
          />
        </Box>
      )}
    </Box>
  );
};

