/**
 * dsh wiring for cache-guard. Same verified usage stream as cost-ledger
 * (session/event assistant/message), token-only — it diagnoses, never bills.
 * When the prefix looks unstable, the diagnosis also rides tools/post-execute
 * as a plugin notice so the model itself knows to stop mutating the context.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "cache-guard";
export declare const inject: string[];
export interface Config {
    enabled: boolean;
    window: number;
    factor: number;
    floorTokens: number;
    collapseRatio: number;
    collapseMinBaseline: number;
    rebillShare: number;
    /** tell the model in-context when the prefix looks unstable */
    adviseModel: boolean;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    window: Schema<number, number, "defined">;
    factor: Schema<number, number, "defined">;
    floorTokens: Schema<number, number, "defined">;
    collapseRatio: Schema<number, number, "defined">;
    collapseMinBaseline: Schema<number, number, "defined">;
    rebillShare: Schema<number, number, "defined">;
    adviseModel: Schema<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    window: Schema<number, number, "defined">;
    factor: Schema<number, number, "defined">;
    floorTokens: Schema<number, number, "defined">;
    collapseRatio: Schema<number, number, "defined">;
    collapseMinBaseline: Schema<number, number, "defined">;
    rebillShare: Schema<number, number, "defined">;
    adviseModel: Schema<boolean, boolean, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=plugin.d.ts.map