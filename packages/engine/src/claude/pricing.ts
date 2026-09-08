/**
 * First-party Anthropic API list prices (USD per 1M tokens). Update when Anthropic changes pricing.
 * Cache write = 1.25x input, cache read = 0.1x input. Web search = $10 per 1,000 searches.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Array<[RegExp, ModelPrice]> = [
  [/^claude-fable-5-1/, { input: 10, output: 50 }],
  [/^claude-mythos-5-1/, { input: 10, output: 50 }],
  [/^claude-fable-5/, { input: 10, output: 50 }],
  [/^claude-opus-5/, { input: 5, output: 25 }],
  [/^claude-opus-4-8/, { input: 5, output: 25 }],
  [/^claude-opus-4-7/, { input: 5, output: 25 }],
  [/^claude-opus-4-6/, { input: 5, output: 25 }],
  [/^claude-sonnet-5/, { input: 2, output: 10 }],
  [/^claude-sonnet-4-6/, { input: 3, output: 15 }],
  [/^claude-haiku-4-5/, { input: 1, output: 5 }],
];

export const WEB_SEARCH_USD_PER_1000 = 10;

export function priceFor(model: string): ModelPrice {
  for (const [re, price] of PRICES) if (re.test(model)) return price;
  return { input: 5, output: 25 };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export function estimateCostUsd(model: string, t: TokenCounts): number {
  const p = priceFor(model);
  const perTok = 1 / 1_000_000;
  const cost =
    t.inputTokens * p.input * perTok +
    t.cacheWriteTokens * p.input * 1.25 * perTok +
    t.cacheReadTokens * p.input * 0.1 * perTok +
    t.outputTokens * p.output * perTok +
    (t.webSearches / 1000) * WEB_SEARCH_USD_PER_1000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
