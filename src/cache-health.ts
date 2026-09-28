/** Pure cache-health analytics over dsh assistant/message usage streams.
 *
 * The economics: DeepSeek bills cached input at a fraction of uncached input.
 * When the prompt prefix is stable, uncachedInput per turn is small (new tokens
 * only) and cacheRead dominates. When something upstream rewrites the prefix
 * (a system-prompt plugin rendering a clock, a reordered tool list, a mutated
 * instruction block), uncachedInput spikes to the full context size — every
 * turn pays full price again. This module detects those spikes against a
 * trailing baseline and estimates the wasted share, in tokens only: pricing is
 * price-aware's job, attribution is this one's. */

export interface UsagePoint {
  turn: number;
  at: string;
  uncachedInput: number;
  cacheRead: number;
  output: number;
}

export interface Spike {
  turn: number;
  at: string;
  uncachedInput: number;
  baseline: number; // trailing median before this point
  excessTokens: number; // uncached above the baseline allowance
}

export interface CacheHealth {
  points: number;
  /** cacheRead / (cacheRead + uncachedInput), 0 when nothing was sent */
  hitRate: number;
  spikes: Spike[];
  wastedTokens: number; // summed excess over all spikes
  wastedShare: number; // wasted / total uncached, 0 when no uncached traffic
  verdict: 'stable' | 'watch' | 'unstable';
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface HealthOptions {
  /** trailing window for the per-turn uncached baseline */
  window: number;
  /** a turn is a spike when uncached exceeds baseline × factor (+ absolute floor) */
  factor: number;
  floorTokens: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = { window: 8, factor: 2.5, floorTokens: 1500 };

export function analyze(points: UsagePoint[], options: HealthOptions = DEFAULT_HEALTH_OPTIONS): CacheHealth {
  const spikes: Spike[] = [];
  let cacheRead = 0;
  let uncached = 0;
  const recent: number[] = [];
  for (const point of points) {
    cacheRead += Math.max(0, point.cacheRead);
    const value = Math.max(0, point.uncachedInput);
    uncached += value;
    if (recent.length >= Math.max(1, options.window)) {
      const baseline = median(recent);
      const allowance = baseline * options.factor + options.floorTokens;
      if (value > allowance && value > options.floorTokens) {
        spikes.push({ turn: point.turn, at: point.at, uncachedInput: value, baseline: Math.round(baseline), excessTokens: value - Math.round(allowance) });
      }
    }
    recent.push(value);
    if (recent.length > Math.max(1, options.window)) recent.shift();
  }
  const hitRate = cacheRead + uncached > 0 ? cacheRead / (cacheRead + uncached) : 0;
  const wastedTokens = spikes.reduce((total, spike) => total + spike.excessTokens, 0);
  const wastedShare = uncached > 0 ? wastedTokens / uncached : 0;
  const verdict = spikes.length >= 3 || wastedShare > 0.35 ? 'unstable' : spikes.length > 0 || wastedShare > 0.15 ? 'watch' : 'stable';
  return { points: points.length, hitRate, spikes, wastedTokens, wastedShare, verdict };
}

export function renderHealth(health: CacheHealth): string {
  if (!health.points) return '还没有 usage 数据。';
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const head = `缓存命中率 ${pct(health.hitRate)} · ${health.points} 轮 · 判定: ${VERDICT_LABEL[health.verdict]}`;
  if (!health.spikes.length) return head;
  const lines = health.spikes.slice(-5).map((spike) => `  第 ${spike.turn} 轮: 未缓存输入 ${spike.uncachedInput.toLocaleString()} tok（基线 ${spike.baseline.toLocaleString()}）→ 多付 ${spike.excessTokens.toLocaleString()} tok`);
  return `${head}\n疑似前缀抖动的轮次:\n${lines.join('\n')}\n多付合计 ≈ ${health.wastedTokens.toLocaleString()} tok（占未缓存输入 ${pct(health.wastedShare)}）。检查系统提示/工具列表在这几轮是否被改写。`;
}

const VERDICT_LABEL: Record<CacheHealth['verdict'], string> = { stable: '✅ 前缀稳定', watch: '⚠ 观察到抖动', unstable: '❌ 前缀不稳定' };
