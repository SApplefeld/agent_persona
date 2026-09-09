// cost-ledger.ts: pure decision logic for cost and cadence (item 6).
// No `import $`, no side effects. Takes data only.
// Covered by check-loader-rule.mjs (scans every hooks/*.ts).

// --- FNV-1a hash ---
// Small, no crypto dependency.
export function fnv1aHash(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // FNV prime, keep unsigned
  }
  return hash >>> 0;
}

// --- Window arithmetic ---
// Returns the effective count for a fixed 1-hour window.
// If start is 0, no window has started yet, return the stored count (typically 0).
// If the window has expired (now - start >= 3600000), return 0.
export function effectiveWindowCount(
  window: { start: number; count: number },
  now: number,
): number {
  if (window.start === 0) return window.count; // no window started yet
  if (now - window.start >= 3600000) return 0; // expired
  return window.count;
}

// --- Cap check ---
// Returns true if the cap is reached.
export function isCapReached(
  window: { start: number; count: number },
  maxPerHour: number,
  now: number,
): boolean {
  const effectiveCount = effectiveWindowCount(window, now);
  return effectiveCount >= maxPerHour;
}

// --- Backoff factor ---
// factor = min(2 ^ floor(consecutiveSkips / costBackoffAfterTicks), floor(costBackoffMaxMs / controllerTickMs))
export function backoffFactor(
  consecutiveSkips: number,
  costBackoffAfterTicks: number,
  costBackoffMaxMs: number,
  controllerTickMs: number,
): number {
  const exponent = Math.floor(consecutiveSkips / costBackoffAfterTicks);
  const maxFactor = Math.floor(costBackoffMaxMs / controllerTickMs);
  const factor = Math.min(Math.pow(2, exponent), maxFactor);
  return Math.max(1, factor); // at least 1
}

// --- Estimate for a call ---
// Estimate tokens: prompt chars / 4 + maxTokens
export function estimateTokens(
  promptChars: number,
  maxTokens: number,
): number {
  return Math.floor(promptChars / 4) + maxTokens;
}
