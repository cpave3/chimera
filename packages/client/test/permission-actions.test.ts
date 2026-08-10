import { expect, it, vi } from 'vitest';
import { ChimeraClient } from '../src/client';

it('sends deny feedback as one atomic permission action', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  const client = new ChimeraClient({ baseUrl: 'http://chimera.test', fetch: fetchImpl });

  await client.resolvePermissionAction('ses_123' as never, 'req_123', {
    decision: 'deny',
    feedback: 'Use the project-local cache instead',
  });

  expect(fetchImpl).toHaveBeenCalledWith(
    'http://chimera.test/v1/sessions/ses_123/permissions/req_123',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        decision: 'deny',
        feedback: 'Use the project-local cache instead',
      }),
    }),
  );
});
