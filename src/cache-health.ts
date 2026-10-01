/** Pure cache-health analytics over dsh assistant/message usage streams.
 *
 * The economics: DeepSeek bills cached input at a fraction of uncached input.
 * When the prompt prefix is stable, uncached input per step is small (new tokens
 * only) and cacheRead dominates. When something upstream rewrites the prefix (a
 * system-prompt plugin rendering a clock, a reordered tool list, a mutated
 * instruction block), the whole prior prompt is re-billed uncached — every step
 * pays full price again.
 *
 * dsh reports the three input buckets disjointly (see @deepseek-ai/dsh-llm
 * TokenUsage): `uncachedInput` is uncached only, cached input sits in
 * `cacheRead`/`cacheWrite`, and prompt size is their sum. That distinction is
 * what makes a spike interpretable, because two shapes look identical in
 * `uncachedInput` alone:
 *
 *   big tool result / long paste  uncachedInput jumps, cacheRead stays put
 *   prefix actually rewritten     uncachedInput jumps, cacheRead collapses to a
 *                                 block-aligned residue and the jump is roughly
 *                                 the previous prompt size
 *
 * So a rewrite needs three gates: the size gate (over the trailing allowance),
 * the shape gate (cacheRead collapsed against its own baseline), and the
 * attribution gate (the re-billed amount is a large share of the previous
 * prompt). Passing only the size gate is a growth event: normal long work, not
 * instability, and not wasted money. Detected in tokens only — pricing is
 * price-aware's job, attribution is this one's. */

export interface UsagePoint {
  turn: number;
  step: number;
  at: string;
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** A step where the prefix was re-billed: all three gates passed. */
export interface Rewrite {
  /** index into the analyzed point array, stable as the session grows */
  index: number;
  turn: number;
  step: number;
  at: string;
  uncachedInput: number;
  baseline: number; // trailing median uncached input before this point
  excessTokens: number; // uncached above the baseline allowance
  cacheRead: number; // cacheRead observed on this step
  cacheBaseline: number; // trailing median cacheRead before this point
  previousPrompt: number; // prompt size of the previous step
}

/** A step that only got big: over the size gate, but not a full re-bill. */
export interface Growth {
  index: number;
  turn: number;
  step: number;
  uncachedInput: number;
  baseline: number;
  cacheRead: number;
  /** true when cacheRead did collapse but the re-bill attribution failed */
  cacheCollapsed: boolean;
}

export interface CacheHealth {
  points: number;
  /** the window `analyze` actually used, so renderers can speak in the same units */
  window: number;
  /** cacheRead / prompt tokens summed over the session, 0 when nothing was sent */
  hitRate: number;
  rewrites: Rewrite[];
  growth: Growth[];
  wastedTokens: number; // summed excess over rewrites only
  wastedShare: number; // wasted / total uncached, 0 when no uncached traffic
  /** rewrites inside the trailing window; 0 means the breaks have stopped */
  recentRewrites: number;
  verdict: 'stable' | 'watch' | 'unstable';
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Prompt tokens billed for a step: the three disjoint input buckets. */
export function promptTokens(point: UsagePoint): number {
  return Math.max(0, point.uncachedInput) + Math.max(0, point.cacheRead) + Math.max(0, point.cacheWrite);
}

export interface HealthOptions {
  /** trailing window for the per-step baselines, and the recency span of the verdict */
  window: number;
  /** size gate: uncached input may reach baseline × factor (+ absolute floor) */
  factor: number;
  floorTokens: number;
  /** shape gate: cacheRead below this share of its own baseline counts as collapsed */
  collapseRatio: number;
  /** shape gate: below this cacheRead baseline a "collapse" is just noise */
  collapseMinBaseline: number;
  /** attribution gate: re-billed uncached input must reach this share of the previous prompt */
  rebillShare: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = {
  window: 8,
  factor: 2.5,
  floorTokens: 1500,
  collapseRatio: 0.25,
  collapseMinBaseline: 2000,
  rebillShare: 0.6,
};

export function analyze(points: UsagePoint[], options: HealthOptions = DEFAULT_HEALTH_OPTIONS): CacheHealth {
  const window = Math.max(1, options.window);
  const rewrites: Rewrite[] = [];
  const growth: Growth[] = [];
  let cacheRead = 0;
  let cacheWrite = 0;
  let uncached = 0;
  const recentUncached: number[] = [];
  const recentCache: number[] = [];
  for (const [index, point] of points.entries()) {
    cacheRead += Math.max(0, point.cacheRead);
    cacheWrite += Math.max(0, point.cacheWrite);
    const value = Math.max(0, point.uncachedInput);
    uncached += value;
    if (recentUncached.length >= window) {
      const baseline = median(recentUncached);
      const allowance = baseline * options.factor + options.floorTokens;
      if (value > allowance && value > options.floorTokens) {
        const cacheBaseline = median(recentCache);
        const previousPrompt = index > 0 ? promptTokens(points[index - 1]!) : 0;
        const collapsed = cacheBaseline >= options.collapseMinBaseline && point.cacheRead < cacheBaseline * options.collapseRatio;
        const reBilled = previousPrompt > 0 && value >= previousPrompt * options.rebillShare;
        if (collapsed && reBilled) {
          rewrites.push({
            index,
            turn: point.turn,
            step: point.step,
            at: point.at,
            uncachedInput: value,
            baseline: Math.round(baseline),
            excessTokens: value - Math.round(allowance),
            cacheRead: Math.max(0, point.cacheRead),
            cacheBaseline: Math.round(cacheBaseline),
            previousPrompt: Math.round(previousPrompt),
          });
        } else {
          growth.push({ index, turn: point.turn, step: point.step, uncachedInput: value, baseline: Math.round(baseline), cacheRead: Math.max(0, point.cacheRead), cacheCollapsed: collapsed });
        }
      }
    }
    recentUncached.push(value);
    recentCache.push(Math.max(0, point.cacheRead));
    if (recentUncached.length > window) recentUncached.shift();
    if (recentCache.length > window) recentCache.shift();
  }
  const prompt = cacheRead + cacheWrite + uncached;
  const hitRate = prompt > 0 ? cacheRead / prompt : 0;
  const wastedTokens = rewrites.reduce((total, rewrite) => total + rewrite.excessTokens, 0);
  const wastedShare = uncached > 0 ? wastedTokens / uncached : 0;
  const recentRewrites = rewrites.filter((rewrite) => rewrite.index >= points.length - window).length;
  // verdict is the session's history (that is what /cache is asked about); the
  // in-context nag is separately keyed to *new* rewrites, so an old break
  // neither hides behind a settled window nor gets announced every step
  const verdict = rewrites.length >= 3 ? 'unstable' : rewrites.length > 0 ? 'watch' : 'stable';
  return { points: points.length, window, hitRate, rewrites, growth, wastedTokens, wastedShare, recentRewrites, verdict };
}

const VERDICT_LABEL: Record<CacheHealth['verdict'], string> = { stable: '✅ 前缀稳定', watch: '⚠ 观察到抖动', unstable: '❌ 前缀不稳定' };

const label = (point: { turn: number; step: number }): string => `第 ${point.turn} 轮第 ${point.step} 步`;

/** Why the oversized steps that were *not* called rewrites are still harmless. */
function growthNote(growth: Growth[]): string {
  if (!growth.length) return '';
  const held = growth.filter((event) => !event.cacheCollapsed).length;
  const collapsed = growth.length - held;
  const parts: string[] = [];
  if (held) parts.push(`${held} 步缓存仍命中（大工具结果/长粘贴，本来就该付）`);
  if (collapsed) parts.push(`${collapsed} 步缓存塌陷但重计量远小于上一步整个 prompt（上下文被压缩/截断，或 provider 不报缓存）`);
  return `\n另有 ${growth.length} 步未缓存变大但未达重写判定：${parts.join('；')}，未计入浪费。`;
}

export function renderHealth(health: CacheHealth): string {
  if (!health.points) return '还没有 usage 数据。';
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const num = (value: number): string => value.toLocaleString();
  const head = `缓存命中率 ${pct(health.hitRate)} · ${health.points} 步 · 判定: ${VERDICT_LABEL[health.verdict]}`;
  if (!health.rewrites.length) return `${head}\n没有前缀重写。${growthNote(health.growth)}`;
  const lines = health.rewrites.slice(-5).map((rewrite) => `  ${label(rewrite)}: 未缓存输入 ${num(rewrite.uncachedInput)} tok（基线 ${num(rewrite.baseline)}），缓存命中从 ${num(rewrite.cacheBaseline)} 塌到 ${num(rewrite.cacheRead)}，上一步整个 prompt ${num(rewrite.previousPrompt)} tok 被重新计费 → 多付 ${num(rewrite.excessTokens)} tok`);
  const settled = health.recentRewrites === 0 ? `\n最近 ${Math.min(health.window, health.points)} 步没有新的重写，抖动已停。` : '';
  return `${head}\n前缀重写（整个前缀按未缓存全价重计）:\n${lines.join('\n')}\n多付合计 ≈ ${num(health.wastedTokens)} tok（占未缓存输入 ${pct(health.wastedShare)}）。断裂发生在轮次/步骤边界，多半是某个插件在上下文头部重渲染了内容（例如每轮刷新的 runtime-context 快照）或缓存已过期，而不是模型自己在改写提示词——去查头部那段内容每轮是否逐字相同。${growthNote(health.growth)}${settled}`;
}
