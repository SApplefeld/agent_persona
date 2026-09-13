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
  // The nudge actuator's routine records are here: each one is the controller
  // reporting on its own bookkeeping, and a lesson drawn from the worker's
  // behaviour has nothing to take from any of them. Two stay in the window.
  // nudge_cap_reached, because being capped is something that happened to the
  // worker. And nudge_failed, because a refused submit is the moment every
  // automated path into the session goes dead, and that record is the only
  // surface that says so.
  const NOISE_ACTIONS = new Set([
    "controller_tick", "env_inject", "heartbeat", "self-review",
    "turn_start", "turn_complete", "planning_fired",
    "planning_created", "nudge_sent", "nudge_skipped_turn_in_flight",
    "nudge_skipped_floor", "nudge", "allow",
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
// Dedupe on meaning (item 8.4's own kaizen goal, node memory_quality): a
// paraphrase that leads with the same six normalized words as a stored
// lesson is refused, the same comparison collectEvents already used to spot
// the pair after the fact. Case-insensitive exact match is kept as the
// narrower case the lead comparison already subsumes for same-length text.
export function dedupeSelfReview(memory: MemoryEntry[], text: string): boolean {
  const lower = text.toLowerCase().trim();
  const lead = normalizedLead(text);
  return memory.some((m) => {
    if (m.source !== "self-review" || m.kind !== "lesson") return false;
    if (m.text.toLowerCase().trim() === lower) return true;
    return lead.length > 0 && normalizedLead(m.text) === lead;
  });
}

// --- isSelfScoringLesson ---
// Item 8.2 (plan bullet "Asks come from real forks", memory half): a memory
// entry comes from a proof passing or an operator correction, never from
// the classifier scoring its own confusion. The self-review loop's raw
// output is exactly that class by default - a lesson about the worker's own
// decision-making pattern, with nothing to check it against - unless the
// text itself grounds the lesson in something external (a test result, a
// proof, an operator's own correction). Refuse the former, keep the latter.
export function isSelfScoringLesson(text: string): boolean {
  const lower = text.toLowerCase();
  const selfReferential =
    /\b(the worker|the classifier|this session|the controller)\b/.test(lower) &&
    /\b(confus|unclear|unsure|scored?|scoring|struggl|repeated(?:ly)? (?:ask|nudg))/.test(lower);
  const externallyGrounded =
    /\b(test passed|tests? pass|proof|operator (?:said|corrected|confirmed|reported)|fixed|verified|confirmed by)\b/.test(lower);
  return selfReferential && !externallyGrounded;
}

// --- reviewOwnRecord ---
// Plan item 8.4: the loop reads the worker's own record and turns a repeated
// weakness into a kaizen goal (a tree node with a proof line) instead of a
// memory lesson about itself. Five signals, each counted as discrete events
// from data the worker already keeps:
//   asks_unresolved  an ask that ran out its wait (ask_timeout) or had to be
//                    re-raised into the thread (ask_reraised)
//   tree_lag         a worktree-cleared git sample (dirty went from >0 to 0,
//                    a commit or a reset) with no goal-tree write since the
//                    previous such sample: the tree lagged at least one commit
//   memory_quality   a self-review lesson whose first six normalized words
//                    match another's (a paraphrase the exact-match dedupe let
//                    through), plus a lesson the self-scoring gate refused
//   message_wait     an inbox record delivered KAIZEN_MESSAGE_WAIT_MS or more
//                    after it was sent
//   long_turns       a turn that ran KAIZEN_LONG_TURN_MS or longer
//                    (turn_over_hour, recorded at turn.complete)
// A weakness is repeated when one signal has at least KAIZEN_REPEAT_MIN
// events newer than the last kaizen node raised for that signal (all events
// when none was). An open kaizen node for a signal suppresses a second one.
// long_turns is the signal the loop can answer by changing its own
// configuration: a cadence counted in turns reviews too rarely when turns run
// for hours, so the finding carries a configFix (halve selfReviewEveryTurns,
// floored at the debounce) rather than a goal; once at the floor it proposes
// a goal like the others.

export const KAIZEN_REPEAT_MIN = 2;
export const KAIZEN_MESSAGE_WAIT_MS = 10 * 60_000;
export const KAIZEN_LONG_TURN_MS = 60 * 60_000;

export type KaizenSignal = "asks_unresolved" | "tree_lag" | "memory_quality" | "message_wait" | "long_turns";

export interface OwnRecordInput {
  decisions: Array<{ timestamp: number; loop: string; action: string; detail: string }>;
  memory: MemoryEntry[];
  goals: Array<{ id: string; status: string; kind: string; parentId: string | null; createdAt: number; updatedAt: number; sortKey?: number; kaizenSignal?: string }>;
  inbox: Array<{ at: number; deliveredAt?: number }>;
}

export interface OwnRecordFinding {
  signal: KaizenSignal;
  count: number;
  title: string;
  objective: string; // carries the "Proof:" line
  rationale: string; // one line for the operator's thread
  configFix?: { knob: "selfReviewEveryTurns"; from: number; to: number };
}

interface KaizenEvent { at: number; note: string }

const OPEN_STATUSES = new Set(["pending", "active", "paused", "blocked"]);
const TREE_WRITE_ACTIONS = new Set(["create", "add", "done", "complete", "completed_by_controller", "drop"]);

function normalizedLead(text: string, words = 6): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, words).join(" ");
}

function collectEvents(input: OwnRecordInput): Record<KaizenSignal, KaizenEvent[]> {
  const out: Record<KaizenSignal, KaizenEvent[]> = {
    asks_unresolved: [], tree_lag: [], memory_quality: [], message_wait: [], long_turns: [],
  };
  const decisions = [...input.decisions].sort((a, b) => a.timestamp - b.timestamp);
  let lastClearedAt = -Infinity;
  for (const d of decisions) {
    if (d.action === "ask_timeout" || d.action === "ask_reraised") {
      out.asks_unresolved.push({ at: d.timestamp, note: d.detail.slice(0, 80) });
    } else if (d.action === "turn_over_hour") {
      out.long_turns.push({ at: d.timestamp, note: d.detail.slice(0, 80) });
    } else if (d.action === "memory_lesson_refused") {
      out.memory_quality.push({ at: d.timestamp, note: d.detail.slice(0, 80) });
    } else if (d.action === "env_git") {
      const m = /dirty=0 \(was (\d+)\)/.exec(d.detail);
      if (m && parseInt(m[1], 10) > 0) {
        const wroteTree = decisions.some((w) => TREE_WRITE_ACTIONS.has(w.action) && w.timestamp > lastClearedAt && w.timestamp <= d.timestamp);
        if (lastClearedAt !== -Infinity && !wroteTree) {
          out.tree_lag.push({ at: d.timestamp, note: "worktree cleared with no tree write since the previous one" });
        }
        lastClearedAt = d.timestamp;
      }
    }
  }
  const lessons = input.memory.filter((m) => m.source === "self-review" && m.kind === "lesson");
  const byLead = new Map<string, MemoryEntry[]>();
  for (const m of lessons) {
    const lead = normalizedLead(m.text);
    if (!lead) continue;
    byLead.set(lead, [...(byLead.get(lead) ?? []), m]);
  }
  for (const group of byLead.values()) {
    if (group.length < 2) continue;
    for (const m of group) out.memory_quality.push({ at: m.createdAt, note: "duplicate lesson: " + m.text.slice(0, 60) });
  }
  for (const r of input.inbox) {
    if (typeof r.deliveredAt === "number" && r.deliveredAt - r.at >= KAIZEN_MESSAGE_WAIT_MS) {
      out.message_wait.push({ at: r.deliveredAt, note: "waited " + Math.round((r.deliveredAt - r.at) / 60_000) + " min" });
    }
  }
  return out;
}

function describe(signal: KaizenSignal, count: number, events: KaizenEvent[]): { title: string; objective: string; rationale: string } {
  const sample = events.slice(-2).map((e) => e.note).join("; ");
  switch (signal) {
    case "asks_unresolved":
      return {
        title: "Kaizen: asks run out the clock",
        objective: `${count} asks timed out or had to be re-raised before an answer came (${sample}). Find why the asks the worker opens wait unanswered (wrong channel, too generic, opened on a node the operator already parked) and change how they are opened. Proof: a harness case where the same ask shape resolves without a re-raise, and one day's decision log with no ask_timeout.`,
        rationale: `${count} asks timed out or were re-raised unanswered; raising a kaizen goal to change how asks are opened.`,
      };
    case "tree_lag":
      return {
        title: "Kaizen: the tree lags the commits",
        objective: `${count} times the worktree was cleared (a commit landed) with no goal-tree write since the previous one (${sample}). Make the node that a commit closes complete within one controller tick of it. Proof: a harness case where a worktree-cleared sample after a completing commit closes the node, and one roadmap unit whose Chapter names the node closed in the same tick.`,
        rationale: `${count} commits landed with no goal-tree write between them; raising a kaizen goal so the tree tracks the commits.`,
      };
    case "memory_quality":
      return {
        title: "Kaizen: self-review lessons repeat or self-score",
        objective: `${count} self-review lessons were paraphrases of one another or were refused as self-scoring (${sample}). Dedupe lessons on meaning rather than exact text and ground each in a proof or an operator correction. Proof: a harness case where a paraphrased lesson is refused as a duplicate and a distinct proof-backed one is kept, and a memory store with no two lessons sharing a lead.`,
        rationale: `${count} stored self-review lessons duplicate or self-score; raising a kaizen goal to dedupe on meaning.`,
      };
    case "message_wait":
      return {
        title: "Kaizen: messages wait too long",
        objective: `${count} inbox records waited ${Math.round(KAIZEN_MESSAGE_WAIT_MS / 60_000)} minutes or more before delivery (${sample}). Find what held them (a long turn, a quiet tick, a claim gap) and shorten the path. Proof: a harness case where a record sent mid-turn is delivered inside the wait bound, and one day's inbox with no record over the bound.`,
        rationale: `${count} messages waited ${Math.round(KAIZEN_MESSAGE_WAIT_MS / 60_000)}+ minutes for delivery; raising a kaizen goal to shorten the path.`,
      };
    case "long_turns":
      return {
        title: "Kaizen: turns run past an hour",
        objective: `${count} turns ran ${Math.round(KAIZEN_LONG_TURN_MS / 60_000)} minutes or longer (${sample}). Split the work into turns the operator can steer between. Proof: a harness case where a bounded turn plan is injected once a turn runs long, and one day's decision log with no turn_over_hour.`,
        rationale: `${count} turns ran past an hour; raising a kaizen goal to bound turn length.`,
      };
  }
}

export function reviewOwnRecord(
  input: OwnRecordInput,
  opts: { selfReviewEveryTurns: number; selfReviewDebounceTurns: number },
): OwnRecordFinding[] {
  const events = collectEvents(input);
  const findings: OwnRecordFinding[] = [];
  for (const signal of Object.keys(events) as KaizenSignal[]) {
    const priorNodes = input.goals.filter((g) => g.kaizenSignal === signal);
    if (priorNodes.some((g) => OPEN_STATUSES.has(g.status))) continue;
    const since = priorNodes.reduce((max, g) => Math.max(max, g.updatedAt), -Infinity);
    const fresh = events[signal].filter((e) => e.at > since).sort((a, b) => a.at - b.at);
    if (fresh.length < KAIZEN_REPEAT_MIN) continue;
    const text = describe(signal, fresh.length, fresh);
    const finding: OwnRecordFinding = { signal, count: fresh.length, ...text };
    if (signal === "long_turns") {
      const to = Math.max(opts.selfReviewDebounceTurns, Math.floor(opts.selfReviewEveryTurns / 2));
      if (to < opts.selfReviewEveryTurns) {
        finding.configFix = { knob: "selfReviewEveryTurns", from: opts.selfReviewEveryTurns, to };
        finding.rationale = `${fresh.length} turns ran past an hour, so a review cadence counted in turns ran too rarely; selfReviewEveryTurns ${opts.selfReviewEveryTurns} -> ${to}, changed and in effect.`;
      }
    }
    findings.push(finding);
  }
  return findings;
}

// --- kaizenSortKey ---
// A kaizen goal is taken in the interleaved order item 8 names: after the
// next roadmap unit, not before it and not after all of them. With k kaizen
// plans already pending, the new one sorts just after the (k+1)th pending
// roadmap plan; past the end of the pending list it sorts at `now`.
export function kaizenSortKey(
  goals: Array<{ kind: string; status: string; parentId: string | null; createdAt: number; sortKey?: number; kaizenSignal?: string }>,
  rootId: string,
  now: number,
): number {
  const key = (g: { createdAt: number; sortKey?: number }): number => g.sortKey ?? g.createdAt;
  const pendingPlans = goals.filter((g) => g.parentId === rootId && g.kind === "plan" && g.status === "pending");
  const roadmap = pendingPlans.filter((g) => !g.kaizenSignal).sort((a, b) => key(a) - key(b));
  const k = pendingPlans.filter((g) => !!g.kaizenSignal).length;
  if (k >= roadmap.length) return now;
  const anchor = key(roadmap[k]);
  const next = roadmap[k + 1] ? key(roadmap[k + 1]) : anchor + 2;
  return anchor + (next - anchor) / 2;
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
