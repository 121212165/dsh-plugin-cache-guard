/** Replays the frozen usage corpus through the old single-gate rule and the
 * current three-gate rule, so the accuracy claim in the README is checkable
 * without a dsh install or this machine's session history.
 *
 * The corpus holds only the token buckets and turn/step indices of real
 * `assistant/message` events — no prompt or completion text.
 * Run: node test/replay-real-sessions.mjs */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as LIB from '../lib/cache-health.js';
import * as SRC from '../src/cache-health.ts';

const { analyze, median, DEFAULT_HEALTH_OPTIONS } = LIB;

const corpus = JSON.parse(fs.readFileSync(new URL('./replay-corpus.json', import.meta.url), 'utf8'));

/** The v0.1.0 rule, verbatim: size gate only, cacheRead never consulted. */
function legacySpikes(points, options = DEFAULT_HEALTH_OPTIONS) {
  const spikes = [];
  const recent = [];
  for (const point of points) {
    const value = Math.max(0, point.uncachedInput);
    if (recent.length >= Math.max(1, options.window)) {
      const allowance = median(recent) * options.factor + options.floorTokens;
      if (value > allowance && value > options.floorTokens) spikes.push({ index: points.indexOf(point), uncachedInput: value });
    }
    recent.push(value);
    if (recent.length > Math.max(1, options.window)) recent.shift();
  }
  return spikes;
}

let legacyTotal = 0, rewriteTotal = 0, growthTotal = 0, falsePositives = 0, missed = 0;
const rows = [];
for (const session of corpus.sessions) {
  const points = session.points.map((point) => ({ ...point, at: '' }));
  const legacy = legacySpikes(points);
  const health = analyze(points, DEFAULT_HEALTH_OPTIONS);
  const flagged = new Set(legacy.map((spike) => spike.index));
  const rewrites = health.rewrites.map((rewrite) => rewrite.index);
  // every rewrite must also have tripped the old rule: the new gates only narrow it
  const lost = rewrites.filter((index) => !flagged.has(index)).length;
  const accused = legacy.filter((spike) => !rewrites.includes(spike.index)).length;
  legacyTotal += legacy.length;
  rewriteTotal += rewrites.length;
  growthTotal += health.growth.length;
  falsePositives += accused;
  missed += lost;
  if (legacy.length || rewrites.length) rows.push(`${session.id}  ${String(points.length).padStart(3)} steps | old flagged ${String(legacy.length).padStart(2)} | rewrites ${String(rewrites.length).padStart(2)} | growth-only ${String(health.growth.length).padStart(2)} | old-not-a-rewrite ${accused} | rewrites the old rule missed ${lost} | wasted ${health.wastedTokens.toLocaleString()}`);
}

console.log(rows.join('\n'));
console.log(`\ncorpus: ${corpus.sessions.length} sessions / ${corpus.sessions.reduce((n, s) => n + s.points.length, 0)} usage records (${corpus.capturedAt})`);
console.log(`old single-gate rule: ${legacyTotal} accusations`);
console.log(`three-gate rule:      ${rewriteTotal} rewrites + ${growthTotal} growth-only = ${rewriteTotal + growthTotal} (the ${falsePositives} cache-intact ones are no longer accusations)`);
assert.equal(missed, 0, 'the new rule must not lose a rewrite the old rule caught');
assert.equal(rewriteTotal + growthTotal, legacyTotal, 'the two rules must partition the same candidate set');

// the compiled artifact must behave exactly like the source it was built from
for (const session of corpus.sessions) {
  const points = session.points.map((point) => ({ ...point, at: '' }));
  assert.deepEqual(SRC.analyze(points, SRC.DEFAULT_HEALTH_OPTIONS), analyze(points, DEFAULT_HEALTH_OPTIONS), `src/lib divergence in ${session.id}`);
}
console.log('\nsrc and lib agree on every session in the corpus');
console.log(`narrowing: ${falsePositives}/${legacyTotal} accusations withdrawn, 0 genuine rewrites lost`);
