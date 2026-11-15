import { expect, it, vi } from 'vitest';
import { InteractiveWarnings } from '../src/interactive-warnings';

it('delivers each warning once to the current terminal owner across startup and exit', () => {
  const stderr = vi.fn();
  const transcript = vi.fn();
  const warnings = new InteractiveWarnings(stderr);
  warnings.report('startup');
  expect(stderr).not.toHaveBeenCalled();
  warnings.connect(transcript);
  warnings.report('mounted');
  warnings.disconnect();
  warnings.disconnect();
  warnings.report('shutdown');
  expect(transcript.mock.calls).toEqual([['startup'], ['mounted']]);
  expect(stderr.mock.calls).toEqual([['shutdown']]);
});

it('flushes startup diagnostics to stderr when no UI could mount', () => {
  const stderr = vi.fn();
  const warnings = new InteractiveWarnings(stderr);
  warnings.report('cannot start session: fix the hook');
  warnings.disconnect();
  warnings.disconnect();
  expect(stderr.mock.calls).toEqual([['cannot start session: fix the hook']]);
});
