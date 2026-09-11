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
    /** Mark the active goal leaf as complete. The controller activates the next pending plan or fires the planner. Call when the current step is finished. */
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
    /** Stop the supervisor itself, not just the current goal. Use ONLY when the operator explicitly asks to shut down, stop the supervisor, or end the session for good - never for a completed goal (goal_done already returns the supervisor to its passive waiting state for the next one). The child exits by the graceful EOF path. Owner only. */
    "mcp__agentic-plugin__supervisor_shutdown": {
      /** Optional. Why the operator asked to shut down. */
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
