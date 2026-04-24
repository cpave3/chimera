import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter';

describe('parseFrontmatter', () => {
  it('parses a simple description line', () => {
    const r = parseFrontmatter('---\ndescription: Hi there\n---\nBody');
    expect(r.frontmatter).toEqual({ description: 'Hi there' });
    expect(r.body).toBe('Body');
  });

  it('returns the whole input as body when no frontmatter fence', () => {
    const r = parseFrontmatter('Just a template.');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('Just a template.');
  });

  it('preserves meaningful whitespace in the body', () => {
    const body = '  indented\n\ntwo blank lines\n';
    const r = parseFrontmatter(`---\ndescription: x\n---\n${body}`);
    expect(r.body).toBe(body);
  });

  it('unquotes single- and double-quoted values', () => {
    const r = parseFrontmatter("---\na: \"hi\"\nb: 'lo'\n---\n");
    expect(r.frontmatter).toEqual({ a: 'hi', b: 'lo' });
  });

  it('ignores comment and blank lines inside frontmatter', () => {
    const r = parseFrontmatter('---\n\n# a comment\ndescription: x\n---\n');
    expect(r.frontmatter).toEqual({ description: 'x' });
  });

  it('treats an unterminated fence as a body', () => {
    const r = parseFrontmatter('---\ndescription: x\nno close');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('---\ndescription: x\nno close');
  });
});
