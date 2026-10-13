import { describe, expect, it } from 'vitest';
import { matchesCommandPrefix } from '../src/command-prefix';

describe('matchesCommandPrefix', () => {
  it('matches complete leading tokens rather than string prefixes', async () => {
    await expect(matchesCommandPrefix('legato plan /tmp/project', 'legato')).resolves.toBe(true);
    await expect(matchesCommandPrefix('legato plan /tmp/project', 'legato plan')).resolves.toBe(
      true,
    );
    await expect(matchesCommandPrefix('legato-other plan', 'legato')).resolves.toBe(false);
    await expect(matchesCommandPrefix('legato planner', 'legato plan')).resolves.toBe(false);
    await expect(matchesCommandPrefix('legato', 'legato plan')).resolves.toBe(false);
  });

  it('compares decoded literal quotes, escapes, and slash arguments', async () => {
    for (const [command, prefix] of [
      ['legato "plan" /tmp/project', "legato 'plan'"],
      ["legato 'a b' /tmp/project", 'legato a\\ b'],
      ['legato pl"an"', 'legato plan'],
      ['"legato" plan', 'legato plan'],
      ['legato "a\\$b"', "legato 'a$b'"],
      ['legato "a\\nb"', "legato 'a\\nb'"],
      ['legato \\*', "legato '*'"],
      ['legato /tmp/project/file', 'legato /tmp/project/file'],
      ['legato "" extra', "legato ''"],
    ]) {
      await expect(matchesCommandPrefix(command, prefix), command).resolves.toBe(true);
    }
    await expect(
      matchesCommandPrefix('legato /tmp/project-other', 'legato /tmp/project'),
    ).resolves.toBe(false);
  });

  it('fails closed on anything other than one literal invocation, on either side', async () => {
    for (const unsafe of [
      '',
      '  ',
      'legato; echo unsafe',
      'legato && echo unsafe',
      'legato || echo unsafe',
      'legato | cat',
      'legato &',
      'legato;',
      'legato\necho unsafe',
      'legato > /tmp/output',
      'legato 2>&1',
      'legato < /tmp/input',
      'legato <<EOF\ntext\nEOF',
      'legato <<<text',
      'legato $(echo unsafe)',
      'legato `echo unsafe`',
      'legato <(echo unsafe)',
      'legato >(cat)',
      'legato $HOME',
      `legato "\${HOME}"`,
      'legato $((1 + 2))',
      'legato *.md',
      'legato file?',
      'legato [ab]',
      'legato {a,b}',
      'legato ~',
      'legato x=~',
      'NAME=value legato',
      '(legato)',
      '{ legato; }',
      'if true; then legato; fi',
      'for x in a; do legato; done',
      'legato() { echo unsafe; }',
      '[[ legato ]]',
      '((1))',
      'legato # comment',
      'legato "unterminated',
      "legato 'unterminated",
      'legato |',
      'legato \\',
      "legato $'plan'",
      'legato $"plan"',
      'legato\0unsafe',
    ]) {
      await expect(matchesCommandPrefix(unsafe, 'legato'), unsafe).resolves.toBe(false);
      await expect(matchesCommandPrefix(unsafe, unsafe), unsafe).resolves.toBe(false);
      await expect(matchesCommandPrefix('legato plan', unsafe), unsafe).resolves.toBe(false);
    }
  });

  it('rejects shell and execution wrappers even when the prefix explicitly names them', async () => {
    for (const wrapper of [
      'bash',
      'sh',
      'dash',
      'zsh',
      'ksh',
      'fish',
      'csh',
      'tcsh',
      'env',
      'sudo',
      'doas',
      'su',
      'eval',
      'exec',
      'command',
      'builtin',
      'source',
      '.',
      'nohup',
      'nice',
      'ionice',
      'timeout',
      'setsid',
      'xargs',
      'time',
      'busybox',
      'ash',
      'mksh',
      'yash',
      'rbash',
      'rksh',
      'rzsh',
      'stdbuf',
      'chroot',
      'runuser',
      'runcon',
      'setpriv',
      'unshare',
      'nsenter',
      'flock',
      'watch',
      'parallel',
      'ssh',
    ]) {
      for (const executable of [wrapper, `/usr/bin/${wrapper}`, `"${wrapper}"`]) {
        await expect(matchesCommandPrefix(`${executable} legato plan`, executable)).resolves.toBe(
          false,
        );
      }
    }
  });
});
