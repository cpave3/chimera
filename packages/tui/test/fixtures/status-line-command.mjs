// A status line script for the tests: what it prints depends on the payload's model id.
import { appendFileSync } from 'node:fs';

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  const payload = JSON.parse(input);
  const id = payload.model.id;
  if (process.env.STATUS_LOG) appendFileSync(process.env.STATUS_LOG, `${id}\n`);
  if (id.startsWith('slow'))
    await new Promise((resolve) => setTimeout(resolve, Number(id.slice(4))));
  if (id === 'fail') {
    process.stdout.write('half written');
    process.exit(3);
  }
  process.stdout.write(
    `model ${id} · ${payload.chimera.mode} · ${process.env.COLUMNS} cols\nsecond row\n`,
  );
});
