// Stands in for `chimera run --json` in tests: prints the events of a canned
// run, chosen by FAKE_CHIMERA_SCENARIO, without calling a model.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const scenario = process.env.FAKE_CHIMERA_SCENARIO ?? 'echo';

emit({ type: 'session_started', sessionId: 'fake-session' });

if (scenario === 'echo') {
  emit({
    type: 'tool_call_start',
    callId: 'call-1',
    name: 'echo',
    args: { argv: process.argv.slice(2), home: process.env.HOME, cwd: process.cwd() },
    target: 'host',
  });
  process.stderr.write('a warning on stderr\n');
  process.stdout.write('a line that is not JSON\n');
  emit({ type: 'run_finished', reason: 'stop' });
} else if (scenario === 'permission') {
  emit({
    type: 'permission_request',
    requestId: 'request-1',
    tool: 'bash',
    target: 'host',
    command: 'sudo rm -rf /',
  });
  setInterval(() => {}, 1000);
} else if (scenario === 'hang') {
  setInterval(() => {}, 1000);
} else if (scenario === 'solve-single-line') {
  const source = readFileSync('src/config.js', 'utf8');
  emit({
    type: 'tool_call_start',
    callId: 'call-1',
    name: 'edit',
    args: { path: 'src/config.js' },
    target: 'host',
  });
  writeFileSync('src/config.js', source.replace('timeoutMs: 5000', 'timeoutMs: 8000'));
  emit({ type: 'tool_call_result', callId: 'call-1', result: { replacements: 1 }, durationMs: 1 });
  emit({ type: 'step_finished', stepNumber: 1, finishReason: 'tool-calls' });
  emit({ type: 'assistant_text_done', text: 'The timeout is now 8000 ms.' });
  emit({ type: 'step_finished', stepNumber: 2, finishReason: 'stop' });
  emit({ type: 'run_finished', reason: 'stop' });
} else if (scenario === 'leave-process') {
  // A background command that outlives the run and holds its stdout open.
  spawn('sleep', ['30'], { stdio: 'inherit' });
  emit({ type: 'run_finished', reason: 'stop' });
  process.exit(0);
} else if (scenario === 'do-nothing') {
  emit({ type: 'assistant_text_done', text: 'I could not find the file.' });
  emit({ type: 'run_finished', reason: 'stop' });
}
