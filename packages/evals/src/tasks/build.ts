import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project, runTests } from './checks';
import type { EvalTask } from './types';

const todoFiles = project({
  'src/todo-store.js': `export function createStore() {
  return { todos: [], nextId: 1 };
}

export function addTodo(store, title) {
  const todo = { id: store.nextId, title, done: false };
  store.nextId += 1;
  store.todos.push(todo);
  return todo;
}

export function completeTodo(store, id) {
  const todo = store.todos.find((candidate) => candidate.id === id);
  if (todo) todo.done = true;
  return todo;
}

export function listTodos(store) {
  return [...store.todos];
}
`,
  'src/format.js': `export function formatTodo(todo) {
  return todo.done ? \`- \${todo.title} (done)\` : \`- \${todo.title}\`;
}
`,
  'src/index.js': `export { formatTodo } from './format.js';
export { addTodo, completeTodo, createStore, listTodos } from './todo-store.js';
`,
  'test/todo.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTodo, completeTodo, createStore, formatTodo, listTodos } from '../src/index.js';

test('a new todo is listed and not done', () => {
  const store = createStore();
  addTodo(store, 'Buy milk');
  assert.equal(listTodos(store).length, 1);
  assert.equal(listTodos(store)[0].done, false);
});

test('a completed todo is formatted as done', () => {
  const store = createStore();
  const todo = addTodo(store, 'Buy milk');
  completeTodo(store, todo.id);
  assert.equal(formatTodo(todo), '- Buy milk (done)');
});
`,
});

export const BUILD_TASKS: EvalTask[] = [
  {
    id: 'add-feature',
    category: 'build',
    probes: 'A feature that touches three files and one existing test, from a five-part request.',
    prompt: [
      'Add a priority to todos.',
      "addTodo(store, title, priority) takes an optional priority of 'low', 'normal' or 'high'. The default is 'normal'. Store it on the todo as `priority`.",
      'listTodos(store) must return high todos first, then normal, then low. Todos with the same priority keep the order in which they were added.',
      "formatTodo(todo) must show the priority in square brackets before the title: '- [high] Buy milk', and '- [high] Buy milk (done)' when done.",
      'Update the existing tests for the new format and run them.',
    ].join('\n'),
    files: todoFiles,
    check: ({ workspace }) =>
      runTests(workspace, {
        '.eval-check/todo.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTodo, completeTodo, createStore, formatTodo, listTodos } from '../src/index.js';

test('the default priority is normal', () => {
  const store = createStore();
  assert.equal(addTodo(store, 'Buy milk').priority, 'normal');
});

test('todos are listed by priority, then in the order added', () => {
  const store = createStore();
  addTodo(store, 'first low', 'low');
  addTodo(store, 'first normal');
  addTodo(store, 'first high', 'high');
  addTodo(store, 'second low', 'low');
  addTodo(store, 'second high', 'high');
  assert.deepEqual(
    listTodos(store).map((todo) => todo.title),
    ['first high', 'second high', 'first normal', 'first low', 'second low'],
  );
});

test('the priority is in the formatted todo', () => {
  const store = createStore();
  const todo = addTodo(store, 'Buy milk', 'high');
  assert.equal(formatTodo(todo), '- [high] Buy milk');
  completeTodo(store, todo.id);
  assert.equal(formatTodo(todo), '- [high] Buy milk (done)');
});
`,
      }),
    solve: (workspace) => {
      writeFileSync(
        join(workspace, 'src/todo-store.js'),
        `const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export function createStore() {
  return { todos: [], nextId: 1 };
}

export function addTodo(store, title, priority = 'normal') {
  const todo = { id: store.nextId, title, done: false, priority };
  store.nextId += 1;
  store.todos.push(todo);
  return todo;
}

export function completeTodo(store, id) {
  const todo = store.todos.find((candidate) => candidate.id === id);
  if (todo) todo.done = true;
  return todo;
}

export function listTodos(store) {
  return [...store.todos].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.id - b.id,
  );
}
`,
      );
      writeFileSync(
        join(workspace, 'src/format.js'),
        `export function formatTodo(todo) {
  const text = \`- [\${todo.priority}] \${todo.title}\`;
  return todo.done ? \`\${text} (done)\` : text;
}
`,
      );
      return undefined;
    },
  },
];
