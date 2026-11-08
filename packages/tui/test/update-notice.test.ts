import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, settle } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('update notices', () => {
  it('shows the notice once as a dim row and the state in the update item', async () => {
    mounted = await mount({ statusLine: { rows: [{ left: ['model'], right: ['update'] }] } });
    mounted.handle.updateStatus('v1.2.0 installed, restart', 'updated to v1.2.0, restart to use');
    await settle();
    const screen = mounted.screen();
    expect(screen).toContain('   note  updated to v1.2.0, restart to use');
    expect(screen).toMatch(/╰─ manticore\/gpt ─+ v1\.2\.0 installed, restart ─╯/);
  });

  it('says a release is available in ask mode', async () => {
    mounted = await mount({ layout: 'inline', statusLine: { rows: [{ left: ['update'] }] } });
    mounted.handle.updateStatus('v1.2.0 available', 'v1.2.0 available · chimera update');
    await settle();
    expect(mounted.term.history()).toContain('   note  v1.2.0 available · chimera update');
  });

  it('leaves the item out while there is nothing to say', async () => {
    mounted = await mount({ statusLine: { rows: [{ left: ['update'], right: ['model'] }] } });
    expect(mounted.screen()).toMatch(/╰─+ manticore\/gpt ─╯|╰─ +manticore/);
    expect(mounted.screen()).not.toContain('available');
  });
});
