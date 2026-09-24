// bin/supervise-decide.mjs - Pure "is a restart due?" decision unit.
// No I/O, no side effects. Takes a snapshot object, returns {action, reason}.
// Import: import { decide } from '../bin/supervise-decide.mjs';

/**
 * @typedef {Object} DecideInput
 * @property {number|null} [childExitCode] - Exit code of the current child, or null if still running.
 * @property {number|null} [rootCompleteTs] - Timestamp of the newest root_complete decision, or null.
 * @property {boolean} [rootCompleteBackfilled] - True when that root_complete's own detail text names it a backfilled root (the worker did real work with no active goal tree; item 2 of the v1 plan). A backfilled root_complete is not a real completion signal and must never trigger restart_passive (it does not suppress a genuine restart trigger below it, e.g. a frozen child).
 * @property {number|null} [shutdownRequestedTs] - Timestamp of the newest shutdown_requested decision, or null.
 * @property {number|null} [parkRequestedTs] - Timestamp of the newest park_requested decision, or null.
 * @property {number|null} [restartRequestedTs] - Timestamp of the newest restart_requested decision, or null.
 * @property {number} [crashCount] - Number of consecutive non-zero exits within minRunMs.
 * @property {number} [crashLimit] - The supervisor's crash-loop limit (supervisorCrashLimit); crashCount at or past it stops the run.
 * @property {number} [restartCount] - Number of restarts in the current hour window.
 * @property {number} [childStartTs] - Supervisor's clock at launch (before the launch call).
 * @property {{verdict: string, reason: string, detail: string}|null} [liveness] - The reading bin/supervise-liveness.mjs returned for this poll. Null or absent reads as alive: no liveness restart is ever taken without a reading.
 * @property {number|null} [finalAskAt] - When the final ask for the current silence was written, in epoch ms, or null where none has been. The poll loop clears it whenever a reading is alive.
 * @property {number} [finalAskMs] - supervisorFinalAskMs: how long a final ask waits for any signal to move before a frozen child restarts.
 * @property {number} [now] - Current time (for the final ask's window).
 * @property {number} [minRunMs] - Minimum run time before crash-loop counting.
 * @property {number} [maxRestartsPerHour] - Restart budget per hour.
 */

/**
 * @typedef {Object} DecideOutput
 * @property {string} action - 'restart' | 'restart_passive' | 'final_ask' | 'sweep_relaunch' | 'stop_complete' | 'stop_park' | 'stop_crash_loop' | 'stop_budget' | 'continue'
 * @property {string} reason - Human-readable explanation.
 */

/**
 * Decide whether the supervisor should restart, stop, or continue.
 *
 * Priority order (highest first):
 * 1. stop_budget - restart budget exhausted (maxRestartsPerHour reached)
 * 2. stop_crash_loop - crashLimit consecutive non-zero exits within minRunMs
 * 3. stop_complete - an explicit shutdown_requested decision newer than child start
 *    (plan item 4: distinct from root_complete - the operator asked the
 *    supervisor itself to stop, not just the current goal)
 * 3a. stop_park - an explicit park_requested decision newer than child start:
 *    the persona parked for an update window. The supervisor stops as it does
 *    for a shutdown and exits on the park code, so the keeper's next start
 *    launches the persona again. Sits below shutdown, since a stop for good
 *    outranks a park, and above both restart_passive rows, since stopping the
 *    supervisor outranks relaunching its child
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
 * 6. restart - child exited non-zero
 * 6a. the liveness verdict: frozen returns final_ask while no final ask has
 *    been written for the current silence, continue while that ask is inside
 *    finalAskMs, and restart once it is older and still unanswered; gone
 *    returns sweep_relaunch; alive falls through
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
    parkRequestedTs,
    restartRequestedTs,
    crashCount = 0,
    crashLimit = 3,
    restartCount = 0,
    childStartTs,
    liveness = null,
    finalAskAt = null,
    finalAskMs = 660000,
    now,
    minRunMs = 120000,
    maxRestartsPerHour = 6,
    rootCompleteBackfilled = false,
  } = input;

  // 1. Restart budget exhausted: stop (not a restart).
  if (restartCount >= maxRestartsPerHour) {
    return { action: 'stop_budget', reason: `restart budget exhausted (${restartCount}/${maxRestartsPerHour} in the hour)` };
  }

  // 2. Crash loop: crashLimit consecutive non-zero exits within minRunMs: stop.
  // The limit is the supervisor's own setting, so both readers of the crash
  // count, this unit and the natural-exit path, compare against the same
  // number. They differ on timing: the natural-exit path checks before it
  // relaunches, while this unit sees the count at the next child's first poll.
  if (crashCount >= crashLimit) {
    return { action: 'stop_crash_loop', reason: `crash loop (${crashCount} non-zero exits within ${minRunMs}ms)` };
  }

  // 3. An explicit shutdown request newer than child start: the operator
  // asked the supervisor itself to stop, not just the current goal. Stop.
  if (shutdownRequestedTs !== null && shutdownRequestedTs !== undefined && shutdownRequestedTs > childStartTs) {
    return { action: 'stop_complete', reason: `shutdown_requested at ${shutdownRequestedTs} > child start ${childStartTs}` };
  }

  // 3a. An explicit park request newer than child start: the persona asked to
  // stop for an update window and come back at the keeper's next start. Stop,
  // on a code of its own. Below the shutdown, so a stop for good wins.
  if (parkRequestedTs !== null && parkRequestedTs !== undefined && parkRequestedTs > childStartTs) {
    return { action: 'stop_park', reason: `park_requested at ${parkRequestedTs} > child start ${childStartTs}` };
  }

  // 3b. An explicit restart request newer than child start: relaunch the
  // child with the goal tree kept (plan item 8.3). Same action as root_complete
  // below, so supervise.sh takes one relaunch path for both.
  if (restartRequestedTs !== null && restartRequestedTs !== undefined && restartRequestedTs > childStartTs) {
    return { action: 'restart_passive', reason: `restart_requested at ${restartRequestedTs} > child start ${childStartTs}` };
  }

  // 3c. root_complete newer than child start, with no shutdown requested:
  // the goal is done, but the supervisor stays up for a second goal (plan
  // item 4) - restart the child passively instead of exiting. Skipped when
  // the root was backfilled (v2 Section 0 item 1): that is real tool work
  // with no goal tree, not a real completion, and restarting on it kills a
  // child mid-work. A backfilled root ignores only this one completion
  // signal; it never pre-empts 4a (child exit) or 4b (the liveness verdict) below -
  // a goal-less child stays restartable for either of those other reasons.
  if (rootCompleteTs !== null && rootCompleteTs > childStartTs && !rootCompleteBackfilled) {
    return { action: 'restart_passive', reason: `root_complete at ${rootCompleteTs} > child start ${childStartTs}` };
  }

  // 4a. Child exited non-zero: restart.
  if (childExitCode !== null && childExitCode !== 0) {
    return { action: 'restart', reason: `child exited with code ${childExitCode}` };
  }

  // 4b. The liveness verdict. bin/supervise-liveness.mjs reads frozen or gone
  // only where every signal is silent past its bound at once, and alive on
  // every fail-closed case, so alive, an absent reading and any value outside
  // the closed set all fall through to continue.
  const verdict = liveness && typeof liveness === 'object' ? liveness.verdict : null;
  const detail = liveness && typeof liveness === 'object' ? String(liveness.detail || '') : '';
  if (verdict === 'gone') {
    return { action: 'sweep_relaunch', reason: `gone: every signal is silent and the walk found no live process (${detail})` };
  }
  if (verdict === 'frozen') {
    // One final ask per silence, never on a cadence, since it costs the child
    // a model turn. The window it opens is the harness's tool-call cap plus a
    // margin, and any signal moving inside it reads alive, which clears the
    // ask's time before the next poll hands it in.
    if (finalAskAt === null || finalAskAt === undefined) {
      return { action: 'final_ask', reason: `frozen: every signal is silent and the walk found a live process (${detail})` };
    }
    if (now - finalAskAt > finalAskMs) {
      return { action: 'restart', reason: `frozen: the final ask at ${finalAskAt} went unanswered past ${finalAskMs}ms (${detail})` };
    }
    return { action: 'continue', reason: `final_ask_window: the final ask at ${finalAskAt} is inside ${finalAskMs}ms (${detail})` };
  }

  // 5. Continue: no restart trigger.
  return { action: 'continue', reason: 'no restart trigger' };
}

export default decide;
