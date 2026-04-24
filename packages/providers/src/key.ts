const ENV_PREFIX = 'env:';

export interface KeyResolver {
  (): string;
}

/**
 * Build a resolver for an apiKey spec. `env:VAR` references process.env at call
 * time; plain strings are returned as-is (a warning is logged at resolver-build
 * time). The resolver throws if the env var is unset when called.
 */
export function buildKeyResolver(
  apiKey: string,
  opts: { warn?: (msg: string) => void; providerId: string },
): KeyResolver {
  if (apiKey.startsWith(ENV_PREFIX)) {
    const varName = apiKey.slice(ENV_PREFIX.length);
    return () => {
      const v = process.env[varName];
      if (v === undefined || v === '') {
        throw new Error(
          `API key env var '${varName}' is not set (referenced by provider '${opts.providerId}').`,
        );
      }
      return v;
    };
  }
  opts.warn?.(
    `Provider '${opts.providerId}' has a plain-string apiKey. Prefer 'env:VAR_NAME' references; plain strings are not logged but are saved to config in plaintext.`,
  );
  return () => apiKey;
}
