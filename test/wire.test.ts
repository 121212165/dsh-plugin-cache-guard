/**
 * Wire-level (assembly layer) tests for cache-guard: mount the real apply()
 * against a scripted cordis context and drive the session/event usage stream,
 * the agent/request pass-through, and the tools/post-execute advisory
 * injection end to end. Template: dsh-plugin-quota/test/harness.ts.
 * @module test/wire
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../src/plugin.ts';

interface Listener { event: string; callback: (...args: unknown[]) => unknown }

interface CapturedCommand { name: string; handler: (...args: unknown[]) => unknown }

interface CapturedToolDef { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }

interface Ctx {
  logger: (name: string) => Record<string, unknown>;
  on: (event: string, callback: (...args: unknown[]) => unknown) => void;
  commands: { register: (definition: CapturedCommand) => void };
  tools: { register: (definition: CapturedToolDef) => void };
}

/** Schema defaults only apply through the host — restate them for direct apply(). */
const baseConfig = {
  enabled: true,
  window: 8,
  factor: 2.5,
  floorTokens: 1500,
  collapseRatio: 0.25,
  collapseMinBaseline: 2000,
  rebillShare: 0.6,
  adviseModel: true,
};

function makeCtx() {
  const commands: CapturedCommand[] = [];
  const tools: CapturedToolDef[] = [];
  const listeners: Listener[] = [];
  const logs: string[] = [];
  const ctx: Ctx = {
    logger() {
      return { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message), debug() {} };
    },
    on(event: string, callback: (...args: unknown[]) => unknown) {
      listeners.push({ event, callback });
    },
    commands: { register(definition: CapturedCommand) { commands.push(definition); } },
    tools: { register(definition: CapturedToolDef) { tools.push(definition); } },
  };
  const command = (name: string): CapturedCommand => {
    const found = commands.find((candidate) => candidate.name === name);
    assert.ok(found, `command ${name} was never registered`);
    return found;
  };
  const tool = (name: string): CapturedToolDef => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, `tool ${name} was never registered`);
    return found;
  };
  const listener = (event: string): Listener => {
    const found = listeners.find((candidate) => candidate.event === event);
    assert.ok(found, `${event} listener was never registered`);
    return found;
  };
  return { ctx: ctx as unknown, commands, tools, listeners, logs, command, tool, listener };
}

function emitUsage(listeners: Listener[], sessionId: string, turn: number, uncached: number, cacheRead: number): void {
  const message = listeners.find((candidate) => candidate.event === 'session/event')!;
  message.callback(
    { id: sessionId },
    { type: 'assistant/message', data: { turn, usage: { inputTokens: uncached, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 120 } } },
  );
}

test('disabled config mounts nothing', () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { ...baseConfig, enabled: false });
  assert.equal(wired.commands.length, 0);
  assert.equal(wired.tools.length, 0);
  assert.equal(wired.listeners.length, 0);
  assert.ok(wired.logs.some((line) => line.includes('disabled by config')), `disable notice logged: ${wired.logs.join('|')}`);
});

test('mount wires the agent/request pass-through, usage stream, advisory injection, disposal, command and tool surfaces', () => {
  const wired = makeCtx();
  apply(wired.ctx as never, baseConfig);
  assert.deepEqual(
    wired.listeners.map((candidate) => candidate.event),
    ['agent/request', 'session/event', 'tools/post-execute', 'session/disposed'],
  );
  assert.equal(wired.command('cache').name, 'cache');
  assert.equal(wired.tool('cache_status').name, 'cache_status');
  assert.ok(wired.logs.some((line) => line.startsWith('mounted · window=')), `mount notice logged: ${wired.logs.join('|')}`);
});

test('agent/request middleware passes through both fulfillment and rejection', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, baseConfig);
  const middleware = wired.listener('agent/request').callback;

  const fulfilled = await (middleware({}, async () => ({ model: 'deepseek/chat' })) as Promise<{ model: string }>);
  assert.deepEqual(fulfilled, { model: 'deepseek/chat' }, 'the resolved call config survives the guard');

  await assert.rejects(middleware({}, async () => { throw new Error('boom'); }) as Promise<unknown>, /boom/, 'rejections propagate, never swallowed');
});

test('usage events feed /cache and cache_status health; an empty session renders cold', () => {
  const wired = makeCtx();
  apply(wired.ctx as never, baseConfig);
  emitUsage(wired.listeners, 'sess-a', 1, 300, 9000);
  emitUsage(wired.listeners, 'sess-a', 2, 400, 11_000);

  const panel = wired.command('cache').handler({ agent: { session: { id: 'sess-a' } } }) as { kind: string; text: string };
  assert.equal(panel.kind, 'success');
  assert.ok(panel.text.includes('缓存命中率'), panel.text);
  assert.ok(panel.text.includes('2 步'), panel.text);
  assert.ok(panel.text.includes('✅ 前缀稳定'), panel.text);
  assert.ok(panel.text.includes('没有前缀重写'), panel.text);

  const unknown = wired.command('cache').handler({ agent: { session: { id: 'sess-none' } } }) as { text: string };
  assert.equal(unknown.text, '还没有 usage 数据。', 'an unseen session renders cold, not a crash');
});

test('a prefix rewrite is detected, announced once via tools/post-execute, and never twice', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, baseConfig);
  // 8 steady steps (uncached baseline 500, cached 12k) then a re-billed spike
  for (let turn = 1; turn <= 8; turn++) emitUsage(wired.listeners, 'sess-g', turn, 500, 12_000);
  emitUsage(wired.listeners, 'sess-g', 9, 9000, 500);

  const advisory = wired.listener('tools/post-execute').callback;
  const downstream = {};
  const wrapped = await advisory({ agent: { session: { id: 'sess-g' } } }, undefined, () => downstream) as { additionalContexts?: { content: { type: string; text: string }[] }[] };
  const texts = wrapped.additionalContexts?.map((message) => message.content.map((part) => part.text).join('\n')) ?? [];
  assert.ok(texts.some((text) => text.includes('缓存健康提示')), `advisory injected: ${texts.join('|')}`);
  assert.ok(texts.some((text) => text.includes('前缀重写')), texts.join('|'));

  // the same rewrite must not be re-announced on every later step
  const second = await advisory({ agent: { session: { id: 'sess-g' } } }, undefined, () => downstream) as unknown;
  assert.equal(second, downstream, 'advisory is one-shot per rewrite');
});

test('adviseModel: false keeps the analysis but never injects into the tool stream', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { ...baseConfig, adviseModel: false });
  for (let turn = 1; turn <= 8; turn++) emitUsage(wired.listeners, 'sess-h', turn, 500, 12_000);
  emitUsage(wired.listeners, 'sess-h', 9, 9000, 500);

  const panel = wired.command('cache').handler({ agent: { session: { id: 'sess-h' } } }) as { text: string };
  assert.ok(panel.text.includes('前缀重写'), `analysis still available: ${panel.text}`);

  const downstream = {};
  const passthrough = await wired.listener('tools/post-execute').callback({ agent: { session: { id: 'sess-h' } } }, undefined, () => downstream);
  assert.equal(passthrough, downstream, 'no additionalContexts when adviseModel is off');
});

test('cache_status reads the same per-session ledger as /cache; session/disposed clears it', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, baseConfig);
  emitUsage(wired.listeners, 'sess-t', 1, 300, 9000);

  const toolText = await wired.tool('cache_status').execute({}, { agent: { session: { id: 'sess-t' } } });
  assert.ok(toolText.includes('缓存命中率'), toolText);

  wired.listener('session/disposed').callback({ id: 'sess-t' });
  const cold = wired.command('cache').handler({ agent: { session: { id: 'sess-t' } } }) as { text: string };
  assert.equal(cold.text, '还没有 usage 数据。', 'disposed session forgot its points');
});
