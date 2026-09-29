import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const refreshLocks = new Map<string, Promise<void>>();
const CALLBACK_PORT = 3119;
type Credentials = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

export class McpAuth implements OAuthClientProvider {
  private verifier = '';
  private authorizationUrl?: URL;
  private callbackUrl?: URL;
  private readonly key: string;
  private readonly file: string;
  private readonly stateValue = randomBytes(32).toString('hex');

  constructor(
    readonly name: string,
    readonly resourceUrl: string,
    private readonly options: { directory?: string; clientId?: string; callbackPort?: number } = {},
  ) {
    const parsed = new URL(resourceUrl);
    if (
      parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )
    ) {
      throw new Error('MCP OAuth requires HTTPS or a loopback HTTP URL');
    }
    this.key = createHash('sha256')
      .update(JSON.stringify([name, resourceUrl]))
      .digest('hex');
    this.file = join(
      options.directory ?? join(homedir(), '.chimera', 'mcp-auth'),
      `${this.key}.json`,
    );
  }

  get redirectUrl(): URL {
    return (
      this.callbackUrl ??
      new URL(`http://localhost:${this.options.callbackPort ?? CALLBACK_PORT}/callback`)
    );
  }
  get clientMetadata() {
    return {
      client_name: 'Chimera',
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    };
  }
  state(): string {
    return this.stateValue;
  }
  private async load(): Promise<Credentials> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  private async save(credentials: Credentials): Promise<void> {
    const directory = join(this.file, '..');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temp = join(directory, `.${this.key}.${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(temp, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.options.clientId) return { client_id: this.options.clientId };
    const client = (await this.load()).client;
    if (
      this.callbackUrl &&
      client?.redirect_uris &&
      !client.redirect_uris.includes(String(this.callbackUrl))
    ) {
      return undefined;
    }
    return client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    const credentials = await this.load();
    if (credentials.client?.client_id !== client.client_id) delete credentials.tokens;
    credentials.client = client;
    await this.save(credentials);
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const previous = refreshLocks.get(this.key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const credentials = await this.load();
        credentials.tokens = tokens;
        await this.save(credentials);
      });
    refreshLocks.set(this.key, next);
    try {
      await next;
    } finally {
      if (refreshLocks.get(this.key) === next) refreshLocks.delete(this.key);
    }
  }
  redirectToAuthorization(url: URL): void {
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      throw new Error('MCP authorization endpoint must use HTTPS or loopback HTTP');
    }
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
  async logout(): Promise<void> {
    try {
      await unlink(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async login(options: {
    onUrl: (url: string) => void;
    onCallback?: () => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<void> {
    const callback = createServer();
    const callbackPort = this.options.callbackPort ?? CALLBACK_PORT;
    try {
      await new Promise<void>((resolve, reject) => {
        callback.once('error', reject);
        callback.listen(callbackPort, '127.0.0.1', resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(
          `MCP login callback port ${callbackPort} is in use; close the other login and retry`,
        );
      }
      throw error;
    }
    this.callbackUrl = new URL(`http://localhost:${callbackPort}/callback`);
    const fetchWithTimeout: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
    try {
      const info = await discoverOAuthServerInfo(this.resourceUrl, { fetchFn: fetchWithTimeout });
      const metadata = info.authorizationServerMetadata;
      if (
        !metadata ||
        new URL(metadata.issuer).href !== new URL(info.authorizationServerUrl).href
      ) {
        throw new Error('MCP authorization issuer mismatch');
      }
      for (const endpoint of [
        metadata.authorization_endpoint,
        metadata.token_endpoint,
        metadata.registration_endpoint,
      ]) {
        if (!endpoint) continue;
        const target = new URL(endpoint);
        if (
          target.protocol !== 'https:' &&
          !(
            target.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
          )
        ) {
          throw new Error('MCP authorization endpoint must use HTTPS or loopback HTTP');
        }
      }
      const first = await auth(this, { serverUrl: this.resourceUrl, fetchFn: fetchWithTimeout });
      if (first === 'AUTHORIZED') return;
      const url = this.authorizationUrl;
      if (!url) throw new Error('MCP authorization URL unavailable');
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error('MCP login timed out')),
          options.timeoutMs ?? 120_000,
        );
        let finished = false;
        const abort = () => finish(new Error('MCP login cancelled'));
        const finish = (error?: Error, value?: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve(value as string);
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        callback.on('request', (request, response) => {
          const incoming = new URL(request.url ?? '/', this.callbackUrl);
          if (incoming.pathname !== '/callback') {
            response.writeHead(404).end();
            return;
          }
          const failure = incoming.searchParams.get('error');
          const valid = incoming.searchParams.get('state') === this.stateValue;
          response
            .writeHead(valid && !failure ? 200 : 400, { 'content-type': 'text/plain' })
            .end(
              valid && !failure
                ? 'Callback received. Check the terminal for the login result.'
                : 'Login failed. Return to the terminal.',
            );
          if (valid && !failure && incoming.searchParams.has('code')) options.onCallback?.();
          finish(
            !valid
              ? new Error('MCP login state mismatch')
              : failure
                ? new Error('MCP login denied')
                : undefined,
            incoming.searchParams.get('code') ?? undefined,
          );
        });
        try {
          options.onUrl(url.toString());
        } catch {
          finish(new Error('MCP login could not show authorization URL'));
        }
        if (options.signal?.aborted) abort();
      });
      if (!code) throw new Error('MCP authorization code missing');
      if (
        (await auth(this, {
          serverUrl: this.resourceUrl,
          authorizationCode: code,
          fetchFn: fetchWithTimeout,
        })) !== 'AUTHORIZED'
      )
        throw new Error('MCP login failed');
    } finally {
      await new Promise<void>((resolve) => callback.close(() => resolve()));
      this.callbackUrl = undefined;
    }
  }
}
