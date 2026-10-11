import type { QuestionAnswer, QuestionRequest, QuestionResolution } from '@chimera/core';
import { Box, Text, useInput } from 'ink';
import React, { useRef, useState } from 'react';
import { useFrame } from './frame';
import { useTheme } from './theme/ThemeProvider';

export interface QuestionDialogProps {
  request: QuestionRequest;
  onResolve: (resolution: QuestionResolution) => void;
}

const OWN_ANSWER = 'Type your own answer';

/**
 * The questions of one `ask_question` call, one at a time. The answers go
 * out together after the last one; Esc declines to answer any of them.
 */
export function QuestionDialog({ request, onResolve }: QuestionDialogProps): React.ReactElement {
  const theme = useTheme();
  const frame = useFrame('round');
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
  const [selected, setSelected] = useState(0);
  // null while the user picks from the list; the text so far while they type.
  const [typed, setTypedState] = useState<string | null>(null);
  // Keys can arrive faster than React renders; the ref always has the latest text.
  const typedRef = useRef<string | null>(null);
  const setTyped = (next: string | null) => {
    typedRef.current = next;
    setTypedState(next);
  };

  const answersRef = useRef<QuestionAnswer[]>([]);
  const question = request.questions[answers.length]!;
  // The options, and one more row for an answer of the user's own.
  const rowCount = question.options.length + 1;

  // Read through the ref: two answers can arrive before the first one renders.
  function answer(text: string, custom: boolean): void {
    const asked = request.questions[answersRef.current.length];
    if (!asked) return;
    const next = [...answersRef.current, { question: asked.question, answer: text, custom }];
    answersRef.current = next;
    if (next.length === request.questions.length) {
      onResolve({ status: 'answered', answers: next });
      return;
    }
    setAnswers(next);
    setSelected(0);
    setTyped(null);
  }

  function choose(row: number): void {
    const asked = request.questions[answersRef.current.length];
    if (!asked) return;
    const option = asked.options[row];
    if (option) answer(option.label, false);
    else if (row === asked.options.length) setTyped('');
  }

  useInput((input, key) => {
    const text = typedRef.current;
    if (text !== null) {
      if (key.return) {
        if (text.trim() !== '') answer(text.trim(), true);
      } else if (key.escape) {
        setTyped(null);
      } else if (key.backspace || key.delete) {
        setTyped(text.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setTyped(text + input);
      }
      return;
    }
    if (key.upArrow) setSelected((row) => (row + rowCount - 1) % rowCount);
    else if (key.downArrow) setSelected((row) => (row + 1) % rowCount);
    else if (key.return) choose(selected);
    else if (key.escape) onResolve({ status: 'cancelled' });
    else if (/^[1-9]$/.test(input)) choose(Number(input) - 1);
  });

  const total = request.questions.length;
  const position = total > 1 ? `${answers.length + 1} of ${total}` : '';
  const title = ['Question', position, question.header].filter(Boolean).join(' · ');
  const dim = theme.text.dim ?? theme.text.muted;

  return (
    <Box flexDirection="column" borderStyle={frame} borderColor={theme.ui.accent} paddingX={1}>
      <Text color={theme.ui.accent} bold>
        {title}
      </Text>
      <Text color={theme.text.primary}>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {question.options.map((option, row) => {
          const active = typed === null && row === selected;
          return (
            <Text key={option.label} wrap="truncate">
              <Text color={active ? theme.ui.accent : dim}>{active ? '› ' : '  '}</Text>
              <Text color={active ? theme.text.primary : theme.text.muted} bold={active}>
                {`${row + 1}. ${option.label}`}
              </Text>
              {option.description && <Text color={dim}>{`  ${option.description}`}</Text>}
            </Text>
          );
        })}
        {typed === null ? (
          <Text>
            <Text color={selected === rowCount - 1 ? theme.ui.accent : dim}>
              {selected === rowCount - 1 ? '› ' : '  '}
            </Text>
            <Text
              color={selected === rowCount - 1 ? theme.text.primary : theme.text.muted}
              bold={selected === rowCount - 1}
            >
              {`${rowCount}. ${OWN_ANSWER}`}
            </Text>
          </Text>
        ) : (
          <Text>
            <Text color={theme.ui.accent}>{'› '}</Text>
            <Text color={theme.text.primary}>{`${typed}\x1b[7m \x1b[27m`}</Text>
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={dim}>
          {typed === null
            ? '↑↓ move · enter or a number to answer · esc to skip the questions'
            : 'enter to answer · esc back to the options'}
        </Text>
      </Box>
    </Box>
  );
}
