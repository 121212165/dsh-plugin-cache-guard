import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, median, renderHealth, promptTokens, DEFAULT_HEALTH_OPTIONS, type UsagePoint } from '../src/cache-health.ts';

/** A step with a healthy prefix cache: 90k of the prompt hits, 2k is new. */
const stable = (turn: number): UsagePoint => ({
  turn,
  step: turn,
  at: `2026-09-28T0${turn}:00:00.000Z`,
  uncachedInput: 2_000,
  cacheRead: 90_000,
  cacheWrite: 0,
  output: 500,
});

const point = (turn: number, uncachedInput: number, cacheRead = 90_000, cacheWrite = 0): UsagePoint => ({
  turn,
  step: turn,
  at: `2026-09-28T0${turn}:00:00.000Z`,
  uncachedInput,
  cacheRead,
  cacheWrite,
  output: 500,
});

const stableRun = (count = 9): UsagePoint[] => Array.from({ length: count }, (_, index) => stable(index + 1));

/** 92,000 = the prompt size of the previous step, so a rewrite re-bills exactly that. */
const PREVIOUS_PROMPT = 2_000 + 90_000;

test('median is plain and even-length aware', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1]), 2.5);
  assert.equal(median([]), 0);
});

test('a stable prefix produces no spikes', () => {
  const health = analyze(Array.from({ length: 10 }, (_, index) => point(index + 1, 2000)), DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.rewrites.length, 0);
  assert.equal(health.growth.length, 0);
  assert.equal(health.verdict, 'stable');
  assert.equal(health.points, 10);
});

test('a prefix rewrite: cacheRead collapses and the previous prompt comes back uncached', () => {
  const turns = stableRun();
  // the real signature observed in dsh session logs: cacheRead falls to a
  // block-aligned residue (128, not 0) while uncached ≈ the whole prior prompt
  turns.push(point(10, PREVIOUS_PROMPT, 128));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.rewrites.length, 1);
  assert.equal(health.growth.length, 0);
  const [rewrite] = health.rewrites;
  assert.equal(rewrite!.turn, 10);
  assert.equal(rewrite!.cacheRead, 128);
  assert.equal(rewrite!.cacheBaseline, 90_000);
  assert.equal(rewrite!.previousPrompt, PREVIOUS_PROMPT);
  assert.ok(rewrite!.excessTokens > 60_000);
  assert.equal(health.verdict, 'watch');
});

test('a long turn with an intact cache is growth, not instability', () => {
  const turns = stableRun();
  // a big tool result or a long paste: uncached jumps, the prefix still hits
  turns.push(point(10, PREVIOUS_PROMPT, 90_000));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.rewrites.length, 0, 'a cache hit must never be reported as a prefix rewrite');
  assert.equal(health.growth.length, 1);
  assert.equal(health.wastedTokens, 0);
  assert.equal(health.verdict, 'stable');
});

test('a provider that reports no cache is not accused of rewriting', () => {
  const turns = Array.from({ length: 9 }, (_, index) => point(index + 1, 2_000, 500));
  turns.push(point(10, 40_000, 0));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.rewrites.length, 0, 'cacheBaseline below collapseMinBaseline is noise, not a collapse');
  assert.equal(health.growth.length, 1);
});

test('prompt tokens are the three disjoint input buckets', () => {
  assert.equal(promptTokens(point(1, 1_000, 20_000, 500)), 21_500);
});

test('baseline slides: sustained growth becomes the new normal and stops being reported', () => {
  const turns = [
    ...Array.from({ length: 10 }, (_, index) => point(index + 1, 2_000, 90_000)),
    ...Array.from({ length: 10 }, (_, index) => point(index + 11, 20_000, 90_000)),
  ];
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.rewrites.length, 0, 'the prefix kept hitting throughout, so nothing was re-billed');
  assert.ok(health.growth.length > 0);
  // once the trailing window fills with the new 20k normal, reporting stops
  assert.ok(health.growth.every((event) => event.index <= 13), JSON.stringify(health.growth.map((event) => event.index)));
  assert.equal(health.verdict, 'stable');
});

test('a cache that never comes back is reported, then the baseline absorbs it', () => {
  const turns = [
    ...Array.from({ length: 10 }, (_, index) => point(index + 1, 2_000, 90_000)),
    ...Array.from({ length: 10 }, (_, index) => point(index + 11, 20_000, 128)),
  ];
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  // the first cold step is compaction (92k of prompt vanished, only 20k came back),
  // the following ones re-bill the whole live prompt uncached: that is the waste
  assert.ok(health.rewrites.length > 0, 'a persistently cold prefix is exactly what this plugin is for');
  assert.ok(health.rewrites.every((rewrite) => rewrite.index <= 13), JSON.stringify(health.rewrites.map((r) => r.index)));
  assert.ok(health.rewrites.length < 9, 'reporting must stop once the new normal fills the window');
  const [first] = health.growth;
  assert.equal(first!.cacheCollapsed, true, 'the skipped step collapsed but was not a full re-bill');
  assert.ok(!renderHealth(health).includes('缓存仍命中'), 'compaction must not be described as a cache hit');
});

test('cache writes count toward the prompt, and the window is echoed', () => {
  const turns = Array.from({ length: 10 }, (_, index) => point(index + 1, 1_000, 3_000, 6_000));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.hitRate, 0.3, '3k read of a 10k prompt, the 6k write is neither a hit nor uncached');
  assert.equal(health.window, DEFAULT_HEALTH_OPTIONS.window);
  const wide = analyze(turns, { ...DEFAULT_HEALTH_OPTIONS, window: 4 });
  assert.equal(wide.window, 4);
});

test('verdict keeps the session history while recency reports that it stopped', () => {
  const turns = stableRun();
  for (let index = 0; index < 3; index++) turns.push(point(10 + index, PREVIOUS_PROMPT, 128));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.equal(health.rewrites.length, 3);
  assert.equal(health.verdict, 'unstable');
  assert.equal(health.recentRewrites, 3);
  // the breaks age out of the trailing window, but the session still reports them
  const later = analyze([...turns, ...Array.from({ length: 8 }, (_, index) => point(13 + index, 2_000))], DEFAULT_HEALTH_OPTIONS);
  assert.equal(later.rewrites.length, 3);
  assert.equal(later.recentRewrites, 0);
  assert.equal(later.verdict, 'unstable');
  assert.ok(later.wastedShare > 0.5, 'the money is still reported even though it settled');
  assert.ok(renderHealth(later).includes('抖动已停'), renderHealth(later));
});

test('rewrites already reported keep their index as the session grows', () => {
  const turns = stableRun();
  turns.push(point(10, PREVIOUS_PROMPT, 128));
  const first = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  const second = analyze([...turns, point(11, 2_000), point(12, 2_000)], DEFAULT_HEALTH_OPTIONS);
  assert.deepEqual(
    first.rewrites.map((rewrite) => [rewrite.index, rewrite.turn]),
    second.rewrites.map((rewrite) => [rewrite.index, rewrite.turn]),
  );
});

test('wasted share and small-traffic edge cases stay out of trouble', () => {
  assert.equal(analyze([]).verdict, 'stable');
  assert.equal(analyze([point(1, 0, 0)]).hitRate, 0);
  const turns = stableRun();
  turns.push(point(10, 100_000, 128));
  const health = analyze(turns, DEFAULT_HEALTH_OPTIONS);
  assert.ok(health.wastedShare > 0.5);
});

test('render names the step, shows the collapse, and stops blaming the model', () => {
  const turns = stableRun();
  turns.push(point(10, PREVIOUS_PROMPT, 128));
  const text = renderHealth(analyze(turns, DEFAULT_HEALTH_OPTIONS));
  assert.ok(text.includes('第 10 轮第 10 步'), text);
  assert.ok(text.includes('塌到'), text);
  assert.ok(text.includes('多付'), text);
  assert.ok(text.includes('runtime-context'), text);
  assert.ok(!text.includes('请停止'), 'the model is usually not the one mutating the prefix');
  assert.ok(renderHealth(analyze([])).includes('还没有'));
  const grown = renderHealth(analyze([...stableRun(), point(10, PREVIOUS_PROMPT, 90_000)], DEFAULT_HEALTH_OPTIONS));
  assert.ok(grown.includes('没有前缀重写'), grown);
});
