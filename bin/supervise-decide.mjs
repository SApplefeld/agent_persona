// bin/supervise-decide.mjs - Pure "is a restart due?" decision unit.
// No I/O, no side effects. Takes a snapshot object, returns {action, reason}.
// Import: import { decide } from '../bin/supervise-decide.mjs';

/**
 * @typedef {Object} DecideInput
 * @property {number|null} [childExitCode] - Exit code of the current child, or null if still running.
 * @property {number|null} [rootCompleteTs] - Timestamp of the newest root_complete decision, or null.
 * @property {boolean} [rootCompleteBackfilled] - True when that root_complete's own detail text names it a backfilled root (the worker did real work with no active goal tree; item 2 of the v1 plan). A backfilled root_complete is not a real completion signal and must never trigger a restart.
 * @property {number|null} [shutdownRequestedTs] - Timestamp of the newest shutdown_requested decision, or null.
 * @property {number|null} [restartRequestedTs] - Timestamp of the newest restart_requested decision, or null.
 * @property {number|null} [criticalTs] - Timestamp of the newest context_budget_crossed critical: decision, or null.
 * @property {number} [crashCount] - Number of consecutive non-zero exits within minRunMs.
 * @property {number} [restartCount] - Number of restarts in the current hour window.
 * @property {number} [childStartTs] - Supervisor's clock at launch (before the launch call).
 * @property {string} [childSessionId] - The child's session id from the stream-json init line.
 * @property {string} [heartbeatSessionId] - The sessionId in the heartbeat sidecar.
 * @property {number|null} [heartbeatLastSeen] - The lastSeen timestamp in the heartbeat sidecar.
 * @property {number} [now] - Current time (for hung check).
 * @property {number} [launchedAt] - Timestamp when the child was launched.
 * @property {number} [staleAfterMs] - Plugin's staleAfterMs setting.
 * @property {number} [minRunMs] - Minimum run time before crash-loop counting.
 * @property {number} [maxRestartsPerHour] - Restart budget per hour.
 */

/**
 * @typedef {Object} DecideOutput
 * @property {string} action - 'restart' | 'restart_passive' | 'stop_complete' | 'stop_crash_loop' | 'stop_budget' | 'continue'
 * @property {string} reason - Human-readable explanation.
 */

/**
 * Decide whether the supervisor should restart, stop, or continue.
 *
 * Priority order (highest first):
 * 1. stop_budget - restart budget exhausted (maxRestartsPerHour reached)
 * 2. stop_crash_loop - 3 consecutive non-zero exits within minRunMs
 * 3. stop_complete - an explicit shutdown_requested decision newer than child start
 *    (plan item 4: distinct from root_complete - the operator asked the
 *    supervisor itself to stop, not just the current goal)
 * 4. restart_passive - a restart_requested decision newer than child start
 *    (plan item 8.3: a reader asked for the child to be relaunched, the usual
 *    reason being a pulled runtime update): the child is stopped by the EOF
 *    path and a fresh one launches with the goal tree intact. Sits below
 *    shutdown, since stopping the supervisor outranks relaunching its child,
 *    and above root_complete, so the reason names the explicit request when
 *    both are present
 * 5. restart_passive - root_complete decision newer than child start, with no
 *    shutdown requested: the goal is done, but the supervisor stays up and
 *    returns to item 1's passive state for a second goal, rather than exiting.
 *    Skipped when rootCompleteBackfilled is true (v2 Section 0 item 1): a
 *    backfilled root_complete means the worker did real work with no active
 *    goal tree, not that a real goal actually finished, and restarting on it
 *    kills a child that was never done with anything.
 * 6. restart - child exited non-zero, or critical crossing, or hung (stale + own session + past grace)
 * 7. continue - none of the above
 *
 * @param {DecideInput} input
 * @returns {DecideOutput}
 */
export function decide(input) {
  const {
    childExitCode,
    rootCompleteTs,
    shutdownRequestedTs,
    restartRequestedTs,
    criticalTs,
    crashCount = 0,
    restartCount = 0,
    childStartTs,
    childSessionId,
    heartbeatSessionId,
    heartbeatLastSeen,
    now,
    launchedAt,
    staleAfterMs = 90000,
    minRunMs = 120000,
    maxRestartsPerHour = 6,
    rootCompleteBackfilled = false,
  } = input;

  // 1. Restart budget exhausted: stop (not a restart).
  if (restartCount >= maxRestartsPerHour) {
    return { action: 'stop_budget', reason: `restart budget exhausted (${restartCount}/${maxRestartsPerHour} in the hour)` };
  }

  // 2. Crash loop: 3 consecutive non-zero exits within minRunMs: stop.
  if (crashCount >= 3) {
    return { action: 'stop_crash_loop', reason: `crash loop (${crashCount} non-zero exits within ${minRunMs}ms)` };
  }

  // 3. An explicit shutdown request newer than child start: the operator
  // asked the supervisor itself to stop, not just the current goal. Stop.
  if (shutdownRequestedTs !== null && shutdownRequestedTs !== undefined && shutdownRequestedTs > childStartTs) {
    return { action: 'stop_complete', reason: `shutdown_requested at ${shutdownRequestedTs} > child start ${childStartTs}` };
  }

  // 3a. An explicit restart request newer than child start: relaunch the
  // child with the goal tree kept (plan item 8.3). Same action as root_complete
  // below, so supervise.sh takes one relaunch path for both.
  if (restartRequestedTs !== null && restartRequestedTs !== undefined && restartRequestedTs > childStartTs) {
    return { action: 'restart_passive', reason: `restart_requested at ${restartRequestedTs} > child start ${childStartTs}` };
  }

  // 3b. root_complete newer than child start, with no shutdown requested:
  // the goal is done, but the supervisor stays up for a second goal (plan
  // item 4) - restart the child passively instead of exiting. Skipped when
  // the root was backfilled (v2 Section 0 item 1): that is real tool work
  // with no goal tree, not a real completion, and restarting on it kills a
  // child mid-work. Reviewer Round 119 R45 correction: this used to return
  // early on a backfilled root, which meant a goal-less child could never
  // be restarted at all - not by 4a (no exit), not by 4b (critical budget),
  // not by 4c (hung check) - since none of those ever ran. A backfilled
  // root ignores this one completion signal; it does not pre-empt every
  // other trigger below.
  if (rootCompleteTs !== null && rootCompleteTs > childStartTs && !rootCompleteBackfilled) {
    return { action: 'restart_passive', reason: `root_complete at ${rootCompleteTs} > child start ${childStartTs}` };
  }

  // 4a. Child exited non-zero: restart.
  if (childExitCode !== null && childExitCode !== 0) {
    return { action: 'restart', reason: `child exited with code ${childExitCode}` };
  }

  // 4b. context_budget_crossed critical: newer than child start: restart.
  if (criticalTs !== null && criticalTs > childStartTs) {
    return { action: 'restart', reason: `context_budget_crossed critical: at ${criticalTs} > child start ${childStartTs}` };
  }

  // 4c. Hung check: stale + own session + past grace: restart.
  // Identity key: the heartbeat sidecar's sessionId must equal the child's session id.
  // Startup grace: the hung check does not run within staleAfterMs of launch.
  if (
    heartbeatLastSeen !== null &&
    now !== null &&
    (now - heartbeatLastSeen) > staleAfterMs &&
    heartbeatSessionId !== null &&
    heartbeatSessionId === childSessionId &&
    launchedAt !== null &&
    (now - launchedAt) > staleAfterMs
  ) {
    return {
      action: 'restart',
      reason: `hung: heartbeat lastSeen ${heartbeatLastSeen} older than ${staleAfterMs}ms, sessionId ${heartbeatSessionId} matches child, past grace (${now - launchedAt}ms > ${staleAfterMs}ms)`,
    };
  }

  // 5. Continue: no restart trigger.
  return { action: 'continue', reason: 'no restart trigger' };
}

export default decide;
