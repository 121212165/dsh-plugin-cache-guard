import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { analyze, renderHealth, DEFAULT_HEALTH_OPTIONS } from './cache-health.js';
export const name = 'cache-guard';
export const inject = ['commands', 'llm', 'sessions', 'tools'];
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    window: Schema.natural().default(DEFAULT_HEALTH_OPTIONS.window),
    factor: Schema.number().default(DEFAULT_HEALTH_OPTIONS.factor),
    floorTokens: Schema.natural().default(DEFAULT_HEALTH_OPTIONS.floorTokens),
    collapseRatio: Schema.number().default(DEFAULT_HEALTH_OPTIONS.collapseRatio),
    collapseMinBaseline: Schema.natural().default(DEFAULT_HEALTH_OPTIONS.collapseMinBaseline),
    rebillShare: Schema.number().default(DEFAULT_HEALTH_OPTIONS.rebillShare),
    adviseModel: Schema.boolean().default(true),
});
export function apply(ctx, config) {
    const log = ctx.logger('cache-guard');
    if (!config.enabled)
        return void log.info('disabled by config');
    const options = {
        window: config.window,
        factor: config.factor,
        floorTokens: config.floorTokens,
        collapseRatio: config.collapseRatio,
        collapseMinBaseline: config.collapseMinBaseline,
        rebillShare: config.rebillShare,
    };
    const pointsBySession = new Map();
    const pendingAdvice = new Map();
    /** rewrites already announced per session, so one break is not reported every step */
    const announced = new Map();
    ctx.on('agent/request', (_payload, next) => next().then((callConfig) => callConfig).catch((error) => {
        throw error;
    }));
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message')
            return;
        const usage = event.data.usage;
        if (!usage)
            return;
        const sessionId = String(session.id ?? 'session');
        const points = pointsBySession.get(sessionId) ?? (pointsBySession.set(sessionId, []), pointsBySession.get(sessionId));
        const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : new Date().toISOString();
        points.push({
            turn: typeof event.data.turn === 'number' ? event.data.turn : points.length + 1,
            step: typeof event.data.step === 'number' ? event.data.step : points.length + 1,
            at,
            uncachedInput: Math.max(0, usage.inputTokens ?? 0),
            cacheRead: Math.max(0, usage.cacheReadTokens ?? 0),
            cacheWrite: Math.max(0, usage.cacheWriteTokens ?? 0),
            output: Math.max(0, usage.outputTokens ?? 0),
        });
        if (!config.adviseModel)
            return;
        const health = analyze(points, options);
        // announce each rewrite once: verdict is session-scoped, so without this the
        // same break is re-injected on every later step and inflates the context
        const fresh = health.rewrites.slice(announced.get(sessionId) ?? 0);
        announced.set(sessionId, health.rewrites.length);
        if (!fresh.length)
            return;
        pendingAdvice.set(sessionId, `缓存健康提示: ${renderHealth(health)}\n本次新检测到 ${fresh.length} 处前缀重写（上面已列出的历史项不必重复处理）。`);
    });
    ctx.on('tools/post-execute', async (exec, _result, next) => {
        const sessionId = String(exec?.agent?.session?.id ?? '');
        const text = pendingAdvice.get(sessionId);
        if (!text)
            return next();
        pendingAdvice.delete(sessionId);
        const downstream = await next();
        return {
            ...downstream,
            additionalContexts: [
                createUserMessage({
                    // Session format v4 retired the {kind:'plugin', plugin} wrapper and throws
                    // on it (dsh-session-format-v3-to-v4). Third-party producers own their kind
                    // as `plugin:<name>`; dsh-llm's source union predates that and is narrower
                    // than its own runtime, hence the cast.
                    content: [{ type: 'text', text }],
                    source: { kind: `plugin:${name}`, form: 'notice', summary: '缓存健康' },
                }),
                ...('additionalContexts' in downstream ? (downstream.additionalContexts ?? []) : []),
            ],
        };
    });
    ctx.on('session/disposed', (session) => {
        const key = String(session.id ?? '');
        pointsBySession.delete(key);
        announced.delete(key);
    });
    ctx.commands.register({
        name: 'cache',
        description: '本会话的前缀缓存健康：命中率、抖动轮次、多付 token 估算',
        handler: ({ agent }) => {
            const sessionId = String(agent?.session?.id ?? 'session');
            const points = pointsBySession.get(sessionId) ?? [];
            return { kind: 'success', text: renderHealth(analyze(points, options)) };
        },
    });
    ctx.tools.register(defineTool({
        name: 'cache_status',
        description: '读出本会话的前缀缓存健康状况。怀疑上下文被改写导致计费暴涨时用。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(_args, exec) {
            const sessionId = String(exec?.agent?.session?.id ?? 'session');
            return renderHealth(analyze(pointsBySession.get(sessionId) ?? [], options));
        },
    }));
    log.info(`mounted · window=${config.window} factor=${config.factor}`);
}
//# sourceMappingURL=plugin.js.map