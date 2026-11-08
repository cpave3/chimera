#!/usr/bin/env node
// A fake OpenAI-compatible model server for end-to-end tests of the built CLI.
//
// It answers POST /v1/chat/completions with a streamed reply chosen from a
// script: a JSON array of steps. Each request takes the first step whose
// `when` (a substring of the last user or tool message) matches, or the next
// unused step without `when`. A step is either { "text": "..." } or
// { "tool": "name", "args": { ... } }. A step with "repeat": true is never
// used up, and "{last}" in its text is the message it answers. With no step
// left it answers "done".
//
// Usage: node fake-model-server.mjs <script.json> [port]
// Prints "listening <port>" on stdout once it is ready.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [scriptPath, portArgument = '0'] = process.argv.slice(2);
const steps = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [];
const used = new Set();
let callCount = 0;

function lastMessageText(messages) {
  const last = messages.at(-1);
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) return last.content.map((part) => part.text ?? '').join('');
  return '';
}

function pick(messages) {
  const lastText = lastMessageText(messages);
  for (const [index, step] of steps.entries()) {
    if (used.has(index)) continue;
    if (step.when !== undefined && !lastText.includes(step.when)) continue;
    if (!step.repeat) used.add(index);
    return step.text ? { ...step, text: step.text.replaceAll('{last}', lastText) } : step;
  }
  return { text: 'done' };
}

function chunk(response, delta, finishReason = null) {
  const body = {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  response.write(`data: ${JSON.stringify(body)}\n\n`);
}

const server = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  request.on('data', (data) => {
    raw += data;
  });
  request.on('end', async () => {
    const body = JSON.parse(raw);
    const step = pick(body.messages ?? []);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step.tool) {
      callCount += 1;
      chunk(response, {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${callCount}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
          },
        ],
      });
      chunk(response, {}, 'tool_calls');
    } else {
      const text = step.text ?? 'done';
      const pieces = step.pieces ?? 1;
      const size = Math.ceil(text.length / pieces);
      chunk(response, { role: 'assistant', content: '' });
      for (let offset = 0; offset < text.length; offset += size) {
        chunk(response, { content: text.slice(offset, offset + size) });
        if (step.pieceDelayMs)
          await new Promise((resolve) => setTimeout(resolve, step.pieceDelayMs));
      }
      chunk(response, {}, 'stop');
    }
    response.write(
      `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
});

server.listen(Number(portArgument), '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
