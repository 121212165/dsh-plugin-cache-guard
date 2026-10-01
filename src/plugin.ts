/**
 * dsh wiring for cache-guard. Same verified usage stream as cost-ledger
 * (session/event assistant/message), token-only — it diagnoses, never bills.
 * When the prefix looks unstable, the diagnosis also rides tools/post-execute
 * as a plugin notice so the model itself knows to stop mutating the context.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { analyze, renderHealth, DEFAULT_HEALTH_OPTIONS, type UsagePoint, type HealthOptions } from './cache-health.ts';

export const name = 'cache-guard';
export const inject = ['commands', 'llm', 'sessions', 'tools'];

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

interface ModelRef {
  id: string;
  provider?: string;
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('cache-guard');
  if (!config.enabled) return void log.info('disabled by config');

  const options: HealthOptions = {
    window: config.window,
    factor: config.factor,
    floorTokens: config.floorTokens,
    collapseRatio: config.collapseRatio,
    collapseMinBaseline: config.collapseMinBaseline,
    rebillShare: config.rebillShare,
  };
  const pointsBySession = new Map<string, UsagePoint[]>();
  const pendingAdvice = new Map<string, string>();
  /** rewrites already announced per session, so one break is not reported every step */
  const announced = new Map<string, number>();
  const modelByAgent = new Map<string, ModelRef>();

  ctx.on('agent/request', (payload, next) =>
    next().then((callConfig) => {
      const shape = callConfig as unknown as { provider?: string; model?: string };
      if (shape.model) modelByAgent.set(agentKey(payload.agent), { id: shape.model, provider: shape.provider });
      return callConfig;
    }),
  );

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return;
    const usage = event.data.usage as { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number } | undefined;
    if (!usage) return;
    const sessionId = String((session as { id?: unknown }).id ?? 'session');
    const points = pointsBySession.get(sessionId) ?? (pointsBySession.set(sessionId, []), pointsBySession.get(sessionId)!);
    const at = typeof (event as { time?: unknown }).time === 'number' ? new Date((event as { time: number }).time).toISOString() : new Date().toISOString();
    points.push({
      turn: typeof event.data.turn === 'number' ? event.data.turn : points.length + 1,
      step: typeof event.data.step === 'number' ? event.data.step : points.length + 1,
      at,
      uncachedInput: Math.max(0, usage.inputTokens ?? 0),
      cacheRead: Math.max(0, usage.cacheReadTokens ?? 0),
      cacheWrite: Math.max(0, usage.cacheWriteTokens ?? 0),
      output: Math.max(0, usage.outputTokens ?? 0),
    });
    if (!config.adviseModel) return;
    const health = analyze(points, options);
    // announce each rewrite once: verdict is session-scoped, so without this the
    // same break is re-injected on every later step and inflates the context
    const fresh = health.rewrites.slice(announced.get(sessionId) ?? 0);
    announced.set(sessionId, health.rewrites.length);
    if (!fresh.length) return;
    pendingAdvice.set(
      sessionId,
      `缓存健康提示: ${renderHealth(health)}\n本次新检测到 ${fresh.length} 处前缀重写（上面已列出的历史项不必重复处理）。`,
    );
  });

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const sessionId = String((exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id ?? '');
    const text = pendingAdvice.get(sessionId);
    if (!text) return next();
    pendingAdvice.delete(sessionId);
    const downstream = await next();
    return {
      ...downstream,
      additionalContexts: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'notice', summary: '缓存健康' },
        }),
        ...('additionalContexts' in downstream ? (downstream.additionalContexts ?? []) : []),
      ],
    };
  });

  ctx.on('session/disposed', (session) => {
    const key = String((session as { id?: unknown }).id ?? '');
    pointsBySession.delete(key);
    announced.delete(key);
    modelByAgent.delete(key);
  });

  ctx.commands.register({
    name: 'cache',
    description: '本会话的前缀缓存健康：命中率、抖动轮次、多付 token 估算',
    handler: ({ agent }) => {
      const sessionId = String((agent as { session?: { id?: unknown } } | undefined)?.session?.id ?? 'session');
      const points = pointsBySession.get(sessionId) ?? [];
      return { kind: 'success', text: renderHealth(analyze(points, options)) };
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'cache_status',
      description: '读出本会话的前缀缓存健康状况。怀疑上下文被改写导致计费暴涨时用。',
      parameters: {},
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(_args, exec) {
        const sessionId = String((exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id ?? 'session');
        return renderHealth(analyze(pointsBySession.get(sessionId) ?? [], options));
      },
    }),
  );

  log.info(`mounted · window=${config.window} factor=${config.factor}`);
}

function agentKey(agent: unknown): string {
  const value = agent as { id?: string; session?: { id?: string } } | undefined;
  return String(value?.id ?? value?.session?.id ?? 'agent');
}
