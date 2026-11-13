import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  buildLlamaServeCommandArgs,
  DEFAULT_MAX_SERVER_LOG_LINES,
  ServerLogVerbosity,
  ServerStateSnapshot,
} from '../../core/server-runner.js';
import {
  computeScrollWindow,
  isNarrowTerminal,
  truncateMiddle,
  wrapTextToLines,
} from '../hooks/useTerminalSize.js';

export interface ServerViewProps {
  presetPath: string;
  serveCommand?: string;
  hasUnsavedChanges: boolean;
  serverState: ServerStateSnapshot;
  logLines: string[];
  verbosity: ServerLogVerbosity;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onToggleVerbosity: () => void;
  onClearLogs: () => void;
  contentHeight: number;
  columns: number;
}

export const ServerView: React.FC<ServerViewProps> = ({
  presetPath,
  serveCommand = 'llama serve',
  hasUnsavedChanges,
  serverState,
  logLines,
  verbosity,
  onStart,
  onStop,
  onRestart,
  onToggleVerbosity,
  onClearLogs,
  contentHeight,
  columns,
}) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);

  const innerWidth = Math.max(40, columns - 2);
  const isNarrow = isNarrowTerminal(columns);
  const isRunningOrStarting =
    serverState.status === 'running' ||
    serverState.status === 'starting' ||
    serverState.status === 'stopping';

  const commandSpec = useMemo(
    () => buildLlamaServeCommandArgs(presetPath, serveCommand),
    [presetPath, serveCommand]
  );

  const wrappedLogLines = useMemo(() => {
    const lineWidth = Math.max(24, innerWidth - 4);
    const out: string[] = [];
    for (const line of logLines) {
      out.push(...wrapTextToLines(line, lineWidth));
    }
    return out;
  }, [logLines, innerWidth]);

  const maxLogRows = Math.max(4, contentHeight - 9);
  const totalLines = wrappedLogLines.length;
  const effectiveIndex = autoFollow
    ? Math.max(0, totalLines - 1)
    : Math.min(scrollOffset, Math.max(0, totalLines - 1));

  const win = computeScrollWindow(totalLines, effectiveIndex, maxLogRows);
  const visibleLines = wrappedLogLines.slice(win.startIndex, win.endIndex);

  useInput((input, key) => {
    if (input === 's' || key.return) {
      if (isRunningOrStarting) {
        onStop();
      } else {
        setAutoFollow(true);
        onStart();
      }
    } else if (input === 'r') {
      setAutoFollow(true);
      onRestart();
    } else if (input === 'v') {
      onToggleVerbosity();
    } else if (input === 'c') {
      setScrollOffset(0);
      setAutoFollow(true);
      onClearLogs();
    } else if (key.upArrow) {
      setAutoFollow(false);
      setScrollOffset((prev) =>
        Math.max(0, (autoFollow ? Math.max(0, totalLines - 1) : prev) - 1)
      );
    } else if (key.downArrow) {
      const next = Math.min(
        Math.max(0, totalLines - 1),
        (autoFollow ? totalLines - 1 : scrollOffset) + 1
      );
      setScrollOffset(next);
      if (next >= totalLines - 1) {
        setAutoFollow(true);
      }
    } else if (key.pageUp) {
      setAutoFollow(false);
      setScrollOffset((prev) =>
        Math.max(0, (autoFollow ? Math.max(0, totalLines - 1) : prev) - maxLogRows)
      );
    } else if (key.pageDown) {
      const next = Math.min(
        Math.max(0, totalLines - 1),
        (autoFollow ? totalLines - 1 : scrollOffset) + maxLogRows
      );
      setScrollOffset(next);
      if (next >= totalLines - 1) {
        setAutoFollow(true);
      }
    } else if (input === 'g') {
      setAutoFollow(false);
      setScrollOffset(0);
    } else if (input === 'G') {
      setAutoFollow(true);
      setScrollOffset(Math.max(0, totalLines - 1));
    }
  });

  const statusBadge = (() => {
    switch (serverState.status) {
      case 'running':
        return {
          color: 'green' as const,
          label: `● Running${serverState.pid ? ` (PID: ${serverState.pid})` : ''}`,
        };
      case 'starting':
        return {
          color: 'yellow' as const,
          label: `● Starting${serverState.pid ? ` (PID: ${serverState.pid})` : ''}...`,
        };
      case 'stopping':
        return {
          color: 'yellow' as const,
          label: `● Stopping${serverState.pid ? ` (PID: ${serverState.pid})` : ''}...`,
        };
      case 'error':
        return {
          color: 'red' as const,
          label: `● Error${serverState.exitCode !== undefined ? ` (Exit: ${serverState.exitCode ?? 'err'})` : ''}`,
        };
      default:
        return { color: 'gray' as const, label: '● Stopped' };
    }
  })();

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={columns}
      height={contentHeight}
      overflowY="hidden"
      overflowX="hidden"
    >
      {/* Header / Controls */}
      <Box
        borderStyle="single"
        borderColor={serverState.status === 'running' ? 'green' : serverState.status === 'error' ? 'red' : 'cyan'}
        paddingX={1}
        flexDirection="column"
        width={innerWidth}
        flexShrink={0}
      >
        <Box justifyContent="space-between" width={innerWidth - 4} overflowX="hidden">
          <Box gap={2} overflowX="hidden">
            <Text bold color={statusBadge.color} wrap="truncate-end">
              {statusBadge.label}
            </Text>
            {serverState.listeningUrl && (
              <Text bold color="cyan" wrap="truncate-end">
                URL: {serverState.listeningUrl}
              </Text>
            )}
            <Text color="gray" wrap="truncate-end">
              Verbosity: {verbosity === 'minimal' ? 'Minimal' : 'All'} (Ring: {logLines.length}/{DEFAULT_MAX_SERVER_LOG_LINES})
            </Text>
          </Box>
          {hasUnsavedChanges && (
            <Box flexShrink={0}>
              <Text color="yellow" bold wrap="truncate-end">
                ⚠ Unsaved changes ([Ctrl+S] to apply)
              </Text>
            </Box>
          )}
        </Box>

        <Box justifyContent="space-between" width={innerWidth - 4} overflowX="hidden">
          <Text color="gray" wrap="truncate-end">
            Cmd: {truncateMiddle(commandSpec.displayCommand, Math.max(24, innerWidth - (isNarrow ? 10 : 62)))}
          </Text>
          <Box flexShrink={0}>
            <Text color="gray" wrap="truncate-end">
              [{isRunningOrStarting ? 's/Enter: Stop' : 's/Enter: Start'}] [r: Restart] [v: Verbosity] [c: Clear]
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Bounded Log Viewport */}
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
        flexGrow={1}
        width={innerWidth}
        overflowY="hidden"
        overflowX="hidden"
      >
        {win.hasMoreAbove && (
          <Text color="gray" dimColor wrap="truncate-end">
            ↑ ({win.startIndex} more line(s) above — [↑/g] scroll)
          </Text>
        )}

        {visibleLines.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color="gray" italic wrap="truncate-end">
              Server is {serverState.status}. Press [s] or [Enter] to start `{commandSpec.command}` with {truncateMiddle(presetPath, Math.max(20, innerWidth - 45))}.
            </Text>
            <Text color="gray" dimColor wrap="truncate-end">
              Minimal verbosity mode filters noisy tensor-loading output and caps logs at {DEFAULT_MAX_SERVER_LOG_LINES} lines to keep memory usage bounded.
            </Text>
          </Box>
        ) : (
          visibleLines.map((line, idx) => {
            const globalIdx = win.startIndex + idx;
            const isErrorLine = /\b(error|err|fatal|failed|oom|out of memory)\b/i.test(line);
            const isUrlOrReady = /\b(listening|ready|http server)\b|https?:\/\//i.test(line);
            return (
              <Text
                key={`srv-log-${globalIdx}`}
                color={isErrorLine ? 'red' : isUrlOrReady ? 'green' : 'white'}
                wrap="truncate-end"
              >
                {line}
              </Text>
            );
          })
        )}

        {win.hasMoreBelow && (
          <Text color="gray" dimColor wrap="truncate-end">
            ↓ ({totalLines - win.endIndex} more line(s) below — [↓/G] follow tail)
          </Text>
        )}
      </Box>
    </Box>
  );
};

