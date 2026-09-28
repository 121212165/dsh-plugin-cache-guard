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
  /** tell the model in-context when the prefix looks unstable */
  adviseModel: boolean;
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  window: Schema.natural().default(DEFAULT_HEALTH_OPTIONS.window),
  factor: Schema.number().default(DEFAULT_HEALTH_OPTIONS.factor),
  floorTokens: Schema.natural().default(DEFAULT_HEALTH_OPTIONS.floorTokens),
  adviseModel: Schema.boolean().default(true),
});

interface ModelRef {
  id: string;
  provider?: string;
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('cache-guard');
  if (!config.enabled) return void log.info('disabled by config');

  const options: HealthOptions = { window: config.window, factor: config.factor, floorTokens: config.floorTokens };
  const pointsBySession = new Map<string, UsagePoint[]>();
  const pendingAdvice = new Map<string, string>();
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
    const usage = event.data.usage as { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number } | undefined;
    if (!usage) return;
    const sessionId = String((session as { id?: unknown }).id ?? 'session');
    const points = pointsBySession.get(sessionId) ?? (pointsBySession.set(sessionId, []), pointsBySession.get(sessionId)!);
    points.push({
      turn: typeof event.data.turn === 'number' ? event.data.turn : points.length + 1,
      at: new Date().toISOString(),
      uncachedInput: Math.max(0, usage.inputTokens ?? 0),
      cacheRead: Math.max(0, usage.cacheReadTokens ?? 0),
      output: Math.max(0, usage.outputTokens ?? 0),
    });
    if (!config.adviseModel) return;
    const health = analyze(points, options);
    if (health.verdict === 'stable') return;
    const advice = `缓存健康提示: ${renderHealth(health)}\n如果你刚才改写过系统提示、工具列表或任何位于上下文开头的内容，请停止——那会把整个前缀打成未缓存，每轮都按全价计费。`;
    if (points.length) pendingAdvice.set(sessionId, advice);
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
