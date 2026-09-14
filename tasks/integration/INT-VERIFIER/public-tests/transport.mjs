/** Explicit synthetic model boundary. No network, credentials, host session or subscription is loaded. */
let respond = async () => { throw new Error('No synthetic completion configured'); };
export function setCompletion(handler) { respond = handler; }
export async function callVerifier(client, prompt, signal) { signal?.throwIfAborted(); return respond(client, prompt, signal); }
export async function predictScoringChannel() { return 'explicit-tag'; }
export function emptyUsage() { return { calls: 0, attempts: 0, retries: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }; }
export function addUsage(target, source) { for (const key of Object.keys(emptyUsage())) target[key] += source[key] ?? 0; }
const partial = Symbol('synthetic.partialUsage');
export function attachUsage(error, usage) { if (error !== null && typeof error === 'object') error[partial] = usage; }
export function partialUsage(error) { return error?.[partial]; }
export function requestAttempts(error) { return error?.attempts ?? 0; }
export function completion(text = '<score_A>A</score_A><score_B>T</score_B>') {
  return { text, tokens: [], topLogprobs: [], scoringMode: 'explicit-tag', usage: { ...emptyUsage(), calls: 1, attempts: 1, inputTokens: 17, outputTokens: 9 } };
}
