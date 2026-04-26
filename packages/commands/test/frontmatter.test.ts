import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter';

describe('parseFrontmatter', () => {
  it('parses a simple description line', () => {
    const parsed = parseFrontmatter('---\ndescription: Hi there\n---\nBody');
    expect(parsed.frontmatter).toEqual({ description: 'Hi there' });
    expect(parsed.body).toBe('Body');
  });

  it('returns the whole input as body when no frontmatter fence', () => {
    const parsed = parseFrontmatter('Just a template.');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('Just a template.');
  });

  it('preserves meaningful whitespace in the body', () => {
    const body = '  indented\n\ntwo blank lines\n';
    const parsed = parseFrontmatter(`---\ndescription: x\n---\n${body}`);
    expect(parsed.body).toBe(body);
  });

  it('unquotes single- and double-quoted values', () => {
    const parsed = parseFrontmatter("---\na: \"hi\"\nb: 'lo'\n---\n");
    expect(parsed.frontmatter).toEqual({ a: 'hi', b: 'lo' });
  });

  it('ignores comment and blank lines inside frontmatter', () => {
    const parsed = parseFrontmatter('---\n\n# a comment\ndescription: x\n---\n');
    expect(parsed.frontmatter).toEqual({ description: 'x' });
  });

  it('treats an unterminated fence as a body', () => {
    const parsed = parseFrontmatter('---\ndescription: x\nno close');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('---\ndescription: x\nno close');
  });
});
