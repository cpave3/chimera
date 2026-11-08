import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount } from './harness';

const SHIFT_ENTER = '\x1b[13;2u';
const ALT_ENTER = '\x1b\r';
const BACKSPACE = '\x7f';
const UP = '\x1b[A';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** The prompt box's input rows, between its top and bottom borders. */
function promptRows(screen: string[]): string[] {
  const top = screen.findLastIndex((row) => row.startsWith('╭─'));
  const bottom = screen.findLastIndex((row) => row.startsWith('╰─'));
  return screen.slice(top + 1, bottom).map((row) => row.replace(/^│ (.*?) *│$/, '$1'));
}

describe('multi-line input', () => {
  it('turns a trailing backslash and Enter into a newline instead of sending', async () => {
    mounted = await mount();
    await mounted.keys('hello\\\r');

    expect(mounted.session.sent).toEqual([]);
    expect(promptRows(mounted.term.screen())).toEqual(['› hello', '']);
  });

  it('sends the text on a plain Enter', async () => {
    mounted = await mount();
    await mounted.keys('hello world\r');

    expect(mounted.session.sent).toEqual(['hello world']);
  });

  it('inserts a newline on a linefeed, Shift+Enter and Alt+Enter without sending', async () => {
    mounted = await mount();
    await mounted.keys('one');
    await mounted.keys('\n');
    await mounted.keys('two');
    await mounted.keys(SHIFT_ENTER);
    await mounted.keys('three');
    await mounted.keys(ALT_ENTER);
    await mounted.keys('four');

    expect(mounted.session.sent).toEqual([]);
    expect(promptRows(mounted.term.screen())).toEqual(['› one', '  two', '  three', '  four']);
  });

  it('sends a message of several lines intact', async () => {
    mounted = await mount();
    await mounted.keys('first\\\rsecond\r');

    expect(mounted.session.sent).toEqual(['first\nsecond']);
  });

  it('joins the lines again on Backspace after a backslash and Enter', async () => {
    mounted = await mount();
    await mounted.keys('hello\\\r');
    await mounted.keys(BACKSPACE);

    expect(promptRows(mounted.term.screen())).toEqual(['› hello']);
    expect(mounted.session.sent).toEqual([]);
  });

  it('recalls the last message on Up at an empty prompt', async () => {
    mounted = await mount();
    await mounted.keys('recallme\r');
    await mounted.keys(UP);

    expect(promptRows(mounted.term.screen())).toEqual(['› recallme']);
  });

  it('hands the text to the editor on Ctrl+G and takes back what it returns', async () => {
    const opened: string[] = [];
    mounted = await mount({
      openInEditor: async ({ initialText }) => {
        opened.push(initialText);
        return { ok: true, text: 'after edit' };
      },
    });
    await mounted.keys('before');
    await mounted.keys('\x07');

    expect(opened).toEqual(['before']);
    expect(promptRows(mounted.term.screen())).toEqual(['› after edit']);
  });
});
