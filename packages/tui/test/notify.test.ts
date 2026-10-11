import { describe, expect, it } from 'vitest';
import { decideNotification, FocusTracker, notificationSequence } from '../src/notify';

describe('decideNotification', () => {
  it('sends nothing when notifications are off', () => {
    expect(
      decideNotification({ setting: 'off', reason: 'approval', focus: 'unfocused', runMs: 0 }),
    ).toBe('none');
  });

  it('rings the bell for every event when set to bell', () => {
    for (const reason of ['run_finished', 'approval', 'input'] as const) {
      expect(decideNotification({ setting: 'bell', reason, focus: 'focused', runMs: 0 })).toBe(
        'bell',
      );
    }
  });

  it('notifies when the terminal lost focus', () => {
    expect(
      decideNotification({
        setting: 'auto',
        reason: 'run_finished',
        focus: 'unfocused',
        runMs: 500,
      }),
    ).toBe('desktop');
  });

  it('stays quiet while the user looks at the terminal', () => {
    for (const reason of ['run_finished', 'approval', 'input'] as const) {
      expect(decideNotification({ setting: 'auto', reason, focus: 'focused', runMs: 60_000 })).toBe(
        'none',
      );
    }
  });

  it('asks for attention when it cannot tell whether the terminal has focus', () => {
    const unknown = { setting: 'auto', focus: 'unknown' } as const;
    expect(decideNotification({ ...unknown, reason: 'approval', runMs: 0 })).toBe('desktop');
    expect(decideNotification({ ...unknown, reason: 'input', runMs: 0 })).toBe('desktop');
    expect(decideNotification({ ...unknown, reason: 'run_finished', runMs: 9_000 })).toBe('none');
    expect(decideNotification({ ...unknown, reason: 'run_finished', runMs: 10_000 })).toBe(
      'desktop',
    );
  });
});

describe('notificationSequence', () => {
  it('is a bell, with an OSC 9 message for a desktop notification', () => {
    expect(notificationSequence('bell', 'run finished')).toBe('\x07');
    expect(notificationSequence('desktop', 'run finished')).toBe('\x07\x1b]9;run finished\x07');
    expect(notificationSequence('none', 'run finished')).toBe('');
  });

  it('keeps control characters out of the message', () => {
    expect(notificationSequence('desktop', 'a\x07b\x1b]0;c\nd')).toBe('\x07\x1b]9;ab]0;c d\x07');
  });
});

describe('FocusTracker', () => {
  it('knows nothing until the terminal reports', () => {
    const tracker = new FocusTracker();
    expect(tracker.focus).toBe('unknown');
    tracker.report(false);
    expect(tracker.focus).toBe('unfocused');
    tracker.report(true);
    expect(tracker.focus).toBe('focused');
  });
});
