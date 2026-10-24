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
    baseline: number;
    excessTokens: number;
    cacheRead: number;
    cacheBaseline: number;
    previousPrompt: number;
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
    wastedTokens: number;
    wastedShare: number;
    /** rewrites inside the trailing window; 0 means the breaks have stopped */
    recentRewrites: number;
    verdict: 'stable' | 'watch' | 'unstable';
}
export declare function median(values: number[]): number;
/** Prompt tokens billed for a step: the three disjoint input buckets. */
export declare function promptTokens(point: UsagePoint): number;
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
export declare const DEFAULT_HEALTH_OPTIONS: HealthOptions;
export declare function analyze(points: UsagePoint[], options?: HealthOptions): CacheHealth;
export declare function renderHealth(health: CacheHealth): string;
//# sourceMappingURL=cache-health.d.ts.map