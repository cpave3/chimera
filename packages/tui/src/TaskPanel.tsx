import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface TaskPanelProps {
  tasks: { content: string; status: string }[];
  /** Lines the panel may use, header included. */
  maxLines: number;
}

const GLYPH: Record<string, string> = { completed: '✔', in_progress: '◼' };
const PENDING_GLYPH = '◻';

/**
 * The model's task list while it works, from the task in progress onward:
 * what it is doing now and what comes next.
 */
export function TaskPanel({ tasks, maxLines }: TaskPanelProps): React.ReactElement | null {
  const theme = useTheme();
  if (tasks.length === 0 || maxLines < 2) return null;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const current = tasks.findIndex((task) => task.status !== 'completed');
  const room = maxLines - 1;
  // With everything done there is no "next": show the list from the top.
  const start = current < 0 ? 0 : current;
  const remaining = tasks.length - start;
  const shown = remaining > room ? room - 1 : remaining;
  const hidden = remaining - shown;

  return (
    <Box flexDirection="column">
      <Text color={theme.accent.secondary}>{`tasks ${completed}/${tasks.length}`}</Text>
      {tasks.slice(start, start + shown).map((task, offset) => {
        const active = task.status === 'in_progress';
        const done = task.status === 'completed';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tasks have no id; position is their identity
          <Text key={start + offset} color={active ? theme.text.primary : theme.text.muted}>
            <Text color={active ? theme.ui.accent : done ? theme.status.success : theme.text.muted}>
              {GLYPH[task.status] ?? PENDING_GLYPH}
            </Text>
            {` ${task.content}`}
          </Text>
        );
      })}
      {hidden > 0 && <Text color={theme.text.muted}>{`… ${hidden} more`}</Text>}
    </Box>
  );
}
