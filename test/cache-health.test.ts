import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, median, renderHealth, DEFAULT_HEALTH_OPTIONS, type UsagePoint } from '../src/cache-health.ts';

const point = (turn: number, uncachedInput: number, cacheRead = 90_000): UsagePoint => ({
  turn,
  at: `2026-09-28T0${turn}:00:00.000Z`,
  uncachedInput,
  cacheRead,
  output: 500,
});

test('median is plain and even-length aware', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1]), 2.5);
  assert.equal(median([]), 0);
});

test('a stable prefix produces no spikes', () => {
  const health = analyze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((turn) => point(turn, 2000)), DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.spikes.length, 0);
  assert.equal(health.verdict, 'stable');
  assert.equal(health.points, 10);
});

test('a prefix rewrite shows up as a spike against the trailing baseline', () => {
  const turns = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((turn) => point(turn, 2000));
  turns.push(point(10, 90_000)); // full context re-billed: the whole prefix changed
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.spikes.length, 1);
  assert.equal(health.spikes[0]!.turn, 10);
  assert.ok(health.spikes[0]!.excessTokens > 60_000);
  assert.equal(health.verdict, 'unstable');
});

test('baseline slides: sustained high turns become the new normal', () => {
  const turns = Array.from({ length: 20 }, (_, index) => point(index + 1, index < 10 ? 2000 : 20_000));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.ok(health.spikes.length > 0);
  assert.ok(health.spikes.length < 20);
  // once the trailing window fills with the new 20k normal, spike detection stops
  assert.ok(health.spikes.every((spike) => spike.turn <= 16));
});

test('wasted share and small-traffic edge cases stay out of trouble', () => {
  assert.equal(analyze([]).verdict, 'stable');
  assert.equal(analyze([point(1, 0, 0)]).hitRate, 0);
  const health = analyze([...Array.from({ length: 9 }, (_, index) => point(index + 1, 1000)), point(10, 100_000)]);
  assert.ok(health.wastedShare > 0.85);
});

test('render mentions the turns and the fix hint on unstable verdicts', () => {
  const turns = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((turn) => point(turn, 2000));
  turns.push(point(10, 90_000));
  const text = renderHealth(analyze(turns, DEFAULT_HEALTH_OPTIONS));
  assert.ok(text.includes('第 10 轮'));
  assert.ok(text.includes('多付'));
  assert.ok(text.includes('系统提示'));
  assert.ok(renderHealth(analyze([])).includes('还没有'));
});
