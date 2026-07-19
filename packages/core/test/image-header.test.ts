import { describe, expect, it } from 'vitest';
import { readImageDimensions } from '../src/image-header';

/**
 * Real 7x3 images produced by ImageMagick, one per format chimera accepts.
 * Non-square so a transposed width/height cannot pass.
 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAcAAAADAQMAAABlDYeGAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcQABQjFfu/7AAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0xNlQwMDoyMDozNSswMDowMGS/hBsAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMTZUMDA6MjA6MzUrMDA6MDAV4jynAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTE2VDAwOjIwOjM1KzAwOjAwQvcdeAAAAAtJREFUCNdjYAABAAAGAAFm9MlsAAAAAElFTkSuQmCC';

const JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAcDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==';

const GIF = 'R0lGODlhBwADAPAAAP8AAAAAACH5BAAAAAAALAAAAAAHAAMAAAIEhI+pBQA7';
const BMP =
  'Qk3SAAAAAAAAAIoAAAB8AAAABwAAAAMAAAABABgAAAAAAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnOPwvUoUbgeFR6F6wEzMzMTZmZmJmZmZgaZmZkJPQrXAyhcjzIAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAAAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAAAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA';

// WebP is three different containers wearing one extension.
const WEBP_LOSSY =
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoHAAMAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=';
const WEBP_LOSSLESS = 'UklGRhwAAABXRUJQVlA4TA8AAAAvBoAAAAcQ/Y/+ByKi/wEA';
const WEBP_EXTENDED =
  'UklGRsAAAABXRUJQVlA4WAoAAAACAAAABgAAAgAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAYAAAIAAGQAAAJWUDggMAAAANABAJ0BKgcAAwACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAABgAAAgAAZAAAAFZQOCAwAAAA0AEAnQEqBwADAAIANCWgAnS6AfgAA7AA/vDEC/8guWF1yNf/ID/kB/yA//jyAAAA';

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

describe('readImageDimensions', () => {
  it('reads dimensions from a PNG', () => {
    expect(readImageDimensions(bytes(PNG))).toEqual({ width: 7, height: 3 });
  });

  it('reads dimensions from a JPEG', () => {
    expect(readImageDimensions(bytes(JPEG))).toEqual({ width: 7, height: 3 });
  });

  it('reads dimensions from a GIF', () => {
    expect(readImageDimensions(bytes(GIF))).toEqual({ width: 7, height: 3 });
  });

  it('reads dimensions from a lossy WebP', () => {
    expect(readImageDimensions(bytes(WEBP_LOSSY))).toEqual({ width: 7, height: 3 });
  });

  it('reads dimensions from a lossless WebP', () => {
    expect(readImageDimensions(bytes(WEBP_LOSSLESS))).toEqual({ width: 7, height: 3 });
  });

  it('reads canvas dimensions from an extended WebP', () => {
    expect(readImageDimensions(bytes(WEBP_EXTENDED))).toEqual({ width: 7, height: 3 });
  });

  it('reads dimensions from a BMP', () => {
    expect(readImageDimensions(bytes(BMP))).toEqual({ width: 7, height: 3 });
  });

  it('returns undefined for an unrecognised format', () => {
    expect(readImageDimensions(new Uint8Array(64))).toBeUndefined();
    expect(readImageDimensions(new TextEncoder().encode('not an image at all, just text'))).toBe(
      undefined,
    );
  });

  it('returns undefined for a truncated header rather than reading past the end', () => {
    for (const fixture of [PNG, JPEG, GIF, WEBP_LOSSY, WEBP_LOSSLESS, WEBP_EXTENDED, BMP]) {
      expect(readImageDimensions(bytes(fixture).slice(0, 8))).toBeUndefined();
    }
  });
});
