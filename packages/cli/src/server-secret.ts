let captured = false;
let secret: string | undefined;

export function readServerSecret(): string | undefined {
  if (!captured) {
    secret = process.env.CHIMERA_SERVER_SECRET || undefined;
    delete process.env.CHIMERA_SERVER_SECRET;
    captured = true;
  }
  return secret;
}

export function withServerSecret(url: string, secret: string | undefined): string {
  return secret
    ? `${url.replace(/\/$/, '')}/${encodeURIComponent(secret).replaceAll('*', '%2A')}`
    : url;
}
