import { Box, Text, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface SudoPasswordModalProps {
  status: 'checking' | 'password' | 'validating';
  error?: string;
  onSubmit: (password: Uint8Array) => void;
  onCancel: () => void;
}

export function SudoPasswordModal(props: SudoPasswordModalProps): React.ReactElement {
  const passwordRef = useRef(new Uint8Array());
  const [passwordLength, setPasswordLength] = useState(0);
  const theme = useTheme();

  useEffect(
    () => () => {
      passwordRef.current.fill(0);
      passwordRef.current = new Uint8Array();
    },
    [],
  );

  useInput((input, key) => {
    if (props.status !== 'password') return;
    if (key.escape) {
      clearPassword();
      props.onCancel();
      return;
    }
    if (key.return) {
      if (passwordRef.current.length === 0) return;
      const submitted = passwordRef.current;
      passwordRef.current = new Uint8Array();
      setPasswordLength(0);
      props.onSubmit(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      const next = passwordRef.current.slice(0, -1);
      passwordRef.current.fill(0);
      passwordRef.current = next;
      setPasswordLength(next.length);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const encoded = new TextEncoder().encode(input);
      const next = new Uint8Array(passwordRef.current.length + encoded.length);
      next.set(passwordRef.current);
      next.set(encoded, passwordRef.current.length);
      passwordRef.current.fill(0);
      encoded.fill(0);
      passwordRef.current = next;
      setPasswordLength(next.length);
    }
  });

  function clearPassword(): void {
    passwordRef.current.fill(0);
    passwordRef.current = new Uint8Array();
    setPasswordLength(0);
  }

  let message: React.ReactNode;
  if (props.status === 'checking') {
    message = <Text>Checking cached sudo credentials…</Text>;
  } else if (props.status === 'validating') {
    message = <Text>Validating sudo credentials…</Text>;
  } else {
    message = (
      <>
        <Text>Enter your sudo password (Enter to submit, Esc to cancel):</Text>
        <Text>{'•'.repeat(passwordLength)}</Text>
      </>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.status.error} padding={1}>
      <Text color={theme.status.error} bold>
        Sudo authentication
      </Text>
      {props.error ? <Text color={theme.status.error}>{props.error}</Text> : null}
      {message}
      <Text color={theme.text.muted}>The password stays in this local process.</Text>
    </Box>
  );
}
