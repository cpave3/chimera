import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';

export interface StartOptions {
  app: Hono;
  port?: number;
  host?: string;
}

export interface ChimeraServer {
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<ChimeraServer> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    process.stderr.write(
      `warning: chimera server binding to non-loopback address '${host}'. ` +
        'No auth is enforced; anyone with network access can control the agent.\n',
    );
  }
  const requestedPort = opts.port ?? 0;

  return new Promise<ChimeraServer>((resolve, reject) => {
    let server: ServerType | undefined;
    try {
      server = serve({ fetch: opts.app.fetch, port: requestedPort, hostname: host }, (info) => {
        const port = info.port;
        resolve({
          url: `http://${host}:${port}`,
          port,
          host,
          close: () =>
            new Promise<void>((r) => {
              server?.close(() => r());
            }),
        });
      });
      server.on('error', (err: unknown) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}
