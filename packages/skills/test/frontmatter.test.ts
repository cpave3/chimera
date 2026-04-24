import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter';

describe('parseFrontmatter', () => {
  it('returns empty frontmatter when no --- fence exists', () => {
    const { frontmatter, body } = parseFrontmatter('just a body');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just a body');
  });

  it('parses flat key:value pairs', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: pdf\ndescription: hello\n---\nbody',
    );
    expect(frontmatter).toEqual({ name: 'pdf', description: 'hello' });
  });

  it('strips surrounding quotes', () => {
    const { frontmatter } = parseFrontmatter(
      "---\nname: pdf\ndescription: \"hi there\"\n---",
    );
    expect(frontmatter['description']).toBe('hi there');
  });

  it('supports folded block scalars (>-): multi-line joined by spaces', () => {
    const src = [
      '---',
      'name: pdf',
      'description: >-',
      '  First line',
      '  second line',
      '---',
    ].join('\n');
    expect(parseFrontmatter(src).frontmatter['description']).toBe(
      'First line second line',
    );
  });

  it('supports literal block scalars (|): preserves newlines', () => {
    const src = [
      '---',
      'name: pdf',
      'description: |',
      '  line 1',
      '  line 2',
      '---',
    ].join('\n');
    expect(parseFrontmatter(src).frontmatter['description']).toBe('line 1\nline 2');
  });

  it('block scalar ends at the next non-indented key', () => {
    const src = [
      '---',
      'description: >-',
      '  first',
      '  second',
      'version: 1.0.0',
      '---',
    ].join('\n');
    const fm = parseFrontmatter(src).frontmatter;
    expect(fm['description']).toBe('first second');
    expect(fm['version']).toBe('1.0.0');
  });

  it('body is everything after the closing fence', () => {
    const { body } = parseFrontmatter('---\nname: x\n---\nhello\nworld');
    expect(body).toBe('hello\nworld');
  });
});
