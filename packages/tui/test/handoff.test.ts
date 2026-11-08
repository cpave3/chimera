import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, settle, text, userMessage } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** An editor that stays open until the test closes it. */
function heldEditor() {
  let close: (text: string) => void = () => {};
  const openInEditor = () =>
    new Promise<{ ok: true; text: string }>((resolve) => {
      close = (edited) => resolve({ ok: true, text: edited });
    });
  return { openInEditor, close: (edited: string) => close(edited) };
}

describe.each([
  ['inline', 'inline' as const],
  ['fullscreen', 'fullscreen' as const],
])('while the editor owns the terminal (%s layout)', (_name, layout) => {
  it('draws nothing, and draws again from scratch when it closes', async () => {
    const editor = heldEditor();
    mounted = await mount({ layout, openInEditor: editor.openInEditor });
    await mounted.event(userMessage('hello'), text('streaming answer'));
    await mounted.keys('draft\x07');
    mounted.term.takeOutput();
    // The run goes on streaming and the spinner ticks behind the editor.
    await mounted.event(text(' and more'));
    await settle(200);
    expect(mounted.term.takeOutput()).toBe('');
    editor.close('edited');
    await settle(100);
    expect(mounted.screen()).toContain('streaming answer and more');
    expect(mounted.screen()).toContain('› edited');
  });
});
