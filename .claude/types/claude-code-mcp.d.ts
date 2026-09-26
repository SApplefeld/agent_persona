// The inputs of the MCP tools this session had, from each server's tools/list
// inputSchema; written by `/plugin-types` (src/plugins/functionHooks/mcp-tool-types/mcp-tool-declarations.ts).
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Regenerate rather than edit.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Switch this session to a persona's store, joining or claiming ownership safely: it never evicts a live session. If another session already holds this persona and its heartbeat is current, this session joins as a passive reader (agentic_say/agentic_inbox), taking no write access. Ownership is taken only when no live holder exists, or the existing holder's heartbeat has gone stale (the holder crashed or exited without releasing it). Pass the persona name (e.g. 'default'). */
    "mcp__agentic-plugin__agentic_identity": {
      /** The persona name to activate (e.g. "default", "refactorer"). If omitted, activates "default". */
      persona: string
    }
    /** Add a node (plan or task) to the goal tree. Plans go under the root; tasks go under a plan. If parentId is omitted, the parent is the active leaf when it is a plan, otherwise the active task's parent. */
    "mcp__agentic-plugin__goal_add": {
      /** One-line title for the new node. */
      title: string
      /** What done looks like. */
      objective: string
      /** Optional. The id of the parent node. */
      parentId?: string
      /** "task" (default) or "plan". "plan" is only allowed under the root. */
      kind?: string
      /** Round budget. Default 10. */
      maxRounds?: number
    }
    /** Create a new goal tree for this persona. The root represents the operator's objective; plans are created by the planner at the next controller tick. Optionally provide a roadmap file to guide planning. Use when the user asks to pursue a multi-step objective. */
    "mcp__agentic-plugin__goal_create": {
      /** What the worker should accomplish across multiple turns. */
      objective: string
      /** Maximum number of goal rounds before auto-blocking. Default 10. */
      maxRounds?: number
      /** Optional path to a roadmap file (project-relative). The planner reads it at every planning event. */
      roadmapPath?: string
    }
    /** Mark the active goal leaf as complete. The controller then activates the next pending plan. Once every entry under the top goal is complete or abandoned, with at least one complete, the top goal completes by itself, unless the planner has planned it before, in which case the planner is asked for more. Call when the current step is finished. */
    "mcp__agentic-plugin__goal_done": {
      /** One-line note about why this is done. */
      note?: string
    }
    /** Resume a paused goal leaf. If no node is active, resumes the most recently paused node. Resets the nudge budget. Owner only. */
    "mcp__agentic-plugin__goal_resume": {
      /** Optional. The id of the paused node to resume. Defaults to the most recently paused node. */
      nodeId?: string
    }
    /** Show the current goal tree as formatted text. Read-only; works for passive readers. */
    "mcp__agentic-plugin__goal_status": {}
    /** Stop the supervisor itself, not just the current goal: the child exits by the graceful EOF path once this turn ends. park: true parks for an update window and the keeper's next start brings the persona back; without it the call stops for good and is made only on the operator's explicit ask. A finished goal needs no call here: goal_done already returns the supervisor to its passive waiting state. Owner only. */
    "mcp__agentic-plugin__supervisor_shutdown": {
      /** reason is optional: why the operator asked to shut down. */
      reason?: string
      /** park: true parks for a restart: the supervisor exits on the park code and the keeper's next start relaunches it. */
      park?: boolean
    }
    /** Relaunch the supervised child without stopping the supervisor: this child exits by the graceful EOF path and a fresh one starts with the goal tree intact and resumes the active plan. Use when the operator asks for a restart, or to pick up an updated runtime (a plugin update) without ending the run. Never for a completed goal (goal_done already returns the supervisor to its passive waiting state). Owner only. */
    "mcp__agentic-plugin__supervisor_restart": {
      /** Optional. Why the operator asked for a restart. */
      reason?: string
    }
    /** Steer the goal tree in response to an operator request: drop a pending plan or task (marks it abandoned, it is never activated), pause an active or pending node with a reason (use goal_resume to continue it later), or reprioritize a pending node so it activates before its siblings. Owner only. */
    "mcp__agentic-plugin__goal_edit": {
      /** The id of the node to change (see goal_status). */
      nodeId: string
      /** "drop" | "pause" | "reprioritize" */
      action: string
      /** Why (recorded as the node's blockedReason for pause/drop). */
      reason?: string
    }
    /** Hold or let go of a long-term goal: the idea this persona is working towards, kept beside the goal tree and listed by goal_status. A long-term goal is never the active work and never starts by itself. add holds a new one and returns its id; at most 5 are held, and an add past that is refused. drop lets one go by its id and records the reason. An edit is a drop and an add. Refused outside a turn the operator or the coordinator persona started. Owner only. */
    "mcp__agentic-plugin__goal_longterm": {
      /** action is "add" or "drop". */
      action: string
      /** title is the goal in one line. Required for add. */
      title?: string
      /** objective is what the persona is working towards. Required for add. */
      objective?: string
      /** id names the long-term goal to drop, as goal_status lists it. Required for drop. */
      id?: string
      /** reason says why it is dropped, and is recorded. Required for drop. */
      reason?: string
    }
    /** Set this persona's autonomy level, which says what it may do with work it found on its own. level "propose": it may only propose work, by sending a [PROPOSAL] record to the coordinator persona. level "plan-and-ask": it may write a plan document and queue it with goal_add, and the entry waits paused for the operator's yes. level "plan-and-start": it may write a plan document, queue it and start it, and the plugin tells the coordinator persona. Only the operator's own turn on this persona's thread may call this; every other turn is refused, a coordinator delivery included. The level governs goal_add with kind "plan" and nothing else. goal_status shows the level. Owner only. */
    "mcp__agentic-plugin__goal_autonomy": {
      /** level is "propose", "plan-and-ask" or "plan-and-start". */
      level: string
    }
    /** Add a memory entry to this persona's durable store. Use for facts, preferences, or lessons the worker should remember across sessions. Distill to one clear, self-contained statement. */
    "mcp__agentic-plugin__memory_add": {
      /** A short, self-contained statement (one fact, preference, or lesson). */
      text: string
      /** Memory kind: "fact", "preference", or "lesson". */
      kind?: string
      /** Confidence 0-1. Default 0.7. */
      confidence?: number
    }
    /** Send a message back to the operator in this session's Discord thread. Use it to answer a message that arrived on this channel, or at any time to report something worth their attention. The message is delivered to the thread bound to this session; any chat_id given is ignored. */
    "mcp__plugin_relay_channel-relay__reply": {
      /** The text to send. */
      message: string
      /** Accepted for compatibility and ignored; replies are routed by session. */
      chat_id?: string
    }
  }
}
