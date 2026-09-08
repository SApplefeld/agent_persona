// self-review.ts: pure decision logic for the self-review loop (S13).
// No `import $`, no side effects. Takes data only.
// Covered by check-loader-rule.mjs (scans every hooks/*.ts).

import type { MemoryEntry, MonitorState } from "./agent-state.ts";

export interface SelfReviewOptions {
  selfReviewStreak: number;
  selfReviewEveryTurns: number;
  selfReviewDebounceTurns: number;
  selfReviewMaxPerHour: number;
}

export interface SelfReviewState {
  monitor: MonitorState;
  decisions: Array<{ timestamp: number; loop: string; action: string; detail: string }>;
  memory: MemoryEntry[];
  goals?: Array<{ id: string; title: string; status: string; kind: string }>;
  activeGoalId?: string | null;
}

// --- shouldSelfReview ---
// Returns eligibility + reason. Does NOT mutate state.
export function shouldSelfReview(
  state: SelfReviewState,
  opts: SelfReviewOptions,
  now: number,
  phase: "reactive" | "periodic",
): { eligible: boolean; reason: string } {
  const sr = state.monitor.selfReview;
  if (!sr) return { eligible: false, reason: "no selfReview state" };

  // Cap check (S10): reset count when the hourly window has expired.
  let effectiveCount = sr.count;
  if (now - sr.windowStart >= 3600000) {
    effectiveCount = 0;
  }
  if (effectiveCount >= opts.selfReviewMaxPerHour) {
    return { eligible: false, reason: "cap reached" };
  }

  // Debounce (S12): lastAt === 0 means fresh, pass immediately.
  if (sr.lastAt > 0 && sr.turnsSince < opts.selfReviewDebounceTurns) {
    return { eligible: false, reason: "debounce" };
  }

  // Trigger (S9): reactive needs streak, periodic needs pendingPeriodic or turnsSince >= everyTurns.
  if (phase === "reactive") {
    const streak = state.monitor.env?.errors?.consecutiveErrorTurns ?? 0;
    if (streak >= opts.selfReviewStreak) {
      return { eligible: true, reason: "reactive: streak " + streak };
    }
    return { eligible: false, reason: "reactive: streak " + streak + " < " + opts.selfReviewStreak };
  }

  // Periodic
  if (sr.pendingPeriodic) {
    return { eligible: true, reason: "periodic: pendingPeriodic (goal_done)" };
  }
  if (sr.turnsSince >= opts.selfReviewEveryTurns) {
    return { eligible: true, reason: "periodic: turnsSince " + sr.turnsSince + " >= " + opts.selfReviewEveryTurns };
  }
  return { eligible: false, reason: "periodic: no trigger (pendingPeriodic=false, turnsSince " + sr.turnsSince + " < " + opts.selfReviewEveryTurns + ")" };
}

// --- buildSelfReviewInput ---
// Filters the decision log to worker-facing actions (S5), builds the model prompt.
// Returns { prompt, decisionTimestamps, streak } for provenance.
export function buildSelfReviewInput(
  state: SelfReviewState,
  now: number,
): {
  prompt: string;
  decisionTimestamps: number[];
  streak: number;
} {
  // Noise actions: internal bookkeeping with no worker-facing signal (T5).
  // Kept OUT of the window: deny, block, score, error_streak, paused_by_controller, done, activated.
  const NOISE_ACTIONS = new Set([
    "controller_tick", "env_inject", "heartbeat", "self-review",
    "turn_start", "turn_complete", "planning_fired",
    "planning_created", "nudge_sent", "nudge", "allow",
  ]);

  const workerDecisions = state.decisions.filter(
    (d) => !NOISE_ACTIONS.has(d.action),
  );

  // Build the decision window (most recent 20 worker-facing actions)
  const recent = workerDecisions.slice(-20);
  const window = recent
    .map((d) => new Date(d.timestamp).toISOString().slice(11, 19) + " " + d.loop + " | " + d.action + " | " + d.detail)
    .join("\n");

  // Known lessons (S5: pass as "do not repeat")
  const lessons = state.memory.filter((m) => m.kind === "lesson").slice(-5);
  const lessonBlock = lessons.length > 0
    ? "Known lessons (do not repeat):\n" + lessons.map((m) => " - " + m.text).join("\n")
    : "No prior lessons.";

  const activeGoal = state.goals?.find((g) => g.id === state.activeGoalId);
  const goalContext = activeGoal
    ? "Active goal: " + activeGoal.title + " (status: " + activeGoal.status + ")"
    : "No active goal.";

  const streak = state.monitor.env?.errors?.consecutiveErrorTurns ?? 0;

  const prompt = [
    "Review the following worker activity. If there is a clear, actionable lesson (a mistake worth avoiding or a pattern worth reinforcing), respond with the lesson text only (<=200 chars). If the worker is doing fine and there is nothing worth distilling, respond with exactly: NONE.",
    "",
    goalContext,
    "",
    "Consecutive error turns: " + streak,
    "",
    "Decision window (most recent " + recent.length + " worker-facing actions):",
    window,
    "",
    lessonBlock,
    "",
    "Respond with the lesson text only.",
  ].join("\n");

  return {
    prompt,
    decisionTimestamps: recent.map((d) => d.timestamp),
    streak,
  };
}

// --- dedupeSelfReview ---
// Case-insensitive exact match against existing self-review lessons (S5).
export function dedupeSelfReview(memory: MemoryEntry[], text: string): boolean {
  const lower = text.toLowerCase().trim();
  return memory.some(
    (m) => m.source === "self-review" && m.kind === "lesson" && m.text.toLowerCase().trim() === lower,
  );
}

// --- evictSelfReview ---
// Keep at most 5 self-review lessons (newest by createdAt).
// Never touches pinned entries (S8). Mutates `memory` in place.
export function evictSelfReview(memory: MemoryEntry[], max = 5): void {
  const selfReview = memory
    .filter((m) => m.source === "self-review" && m.kind === "lesson")
    .sort((a, b) => b.createdAt - a.createdAt); // newest first

  if (selfReview.length <= max) return;

  const toEvict = new Set(selfReview.slice(max).map((m) => m.id));
  for (let i = memory.length - 1; i >= 0; i--) {
    if (toEvict.has(memory[i].id)) {
      memory.splice(i, 1);
    }
  }
}
