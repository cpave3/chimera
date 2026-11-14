import { expect, it } from 'vitest';
import { mount, settle } from './harness';

it('renders mod failures as one status line and mod output in scrollback without raw terminal writes', async () => {
  const app = await mount();
  try {
    app.handle.modLog('1 mod failed – chimera mod list', { to: 'status' });
    app.handle.modLog('integration ready', { to: 'scrollback' });
    await settle();
    expect(app.screen()).toContain('1 mod failed');
    expect(app.screen()).toContain('integration ready');
    app.handle.modLog('reporter connected', { to: 'status' });
    await settle();
    expect(app.screen()).toContain('reporter connected');
    expect(app.screen()).not.toContain('1 mod failed');
  } finally {
    await app.unmount();
  }
});
