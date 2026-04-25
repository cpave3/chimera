/**
 * Local image tag produced by `chimera sandbox build` (or the `pnpm
 * sandbox:build` shortcut). Until a published GHCR registry exists
 * (tracked in spec.md §20), this is the default image — `start()`
 * auto-builds it on first use if it's missing.
 */
export const LOCAL_DEV_IMAGE = 'chimera-sandbox:dev';

/**
 * The default image reference used when the user does not pass
 * `--sandbox-image`. Returns `chimera-sandbox:dev` regardless of CLI
 * version while we have no published image. Once GHCR ownership is
 * decided this can switch to a versioned remote tag.
 */
export function defaultImageRef(_chimeraVersion: string): string {
  return LOCAL_DEV_IMAGE;
}

/** True if `ref` is the bundled local image (eligible for auto-build). */
export function isLocalDevImage(ref: string): boolean {
  return ref === LOCAL_DEV_IMAGE;
}
