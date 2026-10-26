import type { Row } from '../domain/db.js';

export const isForcedThinkingGlm = (model: string) => /^glm-5\.3(?:-flashx?)?$/i.test(model);

/** Respect the task's frozen model-route limit; budget reservations remain the cost boundary. */
export function roleOutputLimit(role: string, configured: number) {
  return configured;
}

export function reasoningProfile(route: Row) {
  if (!isForcedThinkingGlm(route.model)) return { model: { reasoningEfforts: false } };
  return {
    provider: { reasoning: 'low', thinkingBudgets: { minimal: 1024, low: 1024, medium: 4096, high: 8192 } },
    model: { reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' }, compat: route.protocol === 'anthropic-messages' ? { allowEmptySignature: true } : { thinkingFormat: 'zai', supportsReasoningEffort: true, maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false } },
  };
}
