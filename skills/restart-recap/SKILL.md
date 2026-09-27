---
name: restart-recap
description: "Use when the operator types restart-recap in this persona's thread or asks what was in flight before a restart, or when this session has just started and a message assumes a conversation it has no memory of."
---

# Restart recap

This skill tells a restarted persona session what the session before it was doing. A new session starts with no memory of the conversation the operator sees as one thread. Without a recap, it can misread its own finished goal or deny work it did. `bin/restart-recap.mjs` in the plugin's installed copy reads the earlier transcripts and prints a header and a digest. This skill says how to run it, how to read it, and what to tell the operator.

## Inputs

- **The script.** Read the installed copy's folder from `~/.claude/plugins/installed_plugins.json`: the `installPath` of the entry under `agentic-plugin@agent-persona`. For example, `node -e "console.log(require(require('os').homedir()+'/.claude/plugins/installed_plugins.json').plugins['agentic-plugin@agent-persona'][0].installPath)"`. The script is `bin/restart-recap.mjs` under that folder.
- **The working directory.** Run the script from this persona's working directory, where `.agentic-personas.json` sits. It reads the store there and finds the transcript folder from that directory.
- **`--persona`.** This persona's name. The script needs it wherever the store holds more than one persona.

The script leaves out the session `CLAUDE_CODE_SESSION_ID` names, which is this one. It reads two earlier sessions by default, and `--sessions <n>` changes that. A session whose last record is more than 48 hours old prints as one line with its age, and `--since <hours>` changes that window.

## Running it

```
node <script> --persona <name>
```

The script always exits 0. Line one of its output is the header, and the lines after it are the digest. Anything it could not read is named on stderr, one line each, and it still prints the header.

## What the digest holds

The digest is a short account of what the operator said and what the persona replied. It holds these lines, oldest session first:

- `session <id>: tail from <time> to <time>, version <build>`, one per session read.
- `operator <hh:mm>: <text>`, one per message the operator sent on the relay thread, including one sent while a turn was running.
- `persona <hh:mm>: <text>`, one per reply the persona sent through the relay reply tool.
- `last words: <text>`, the session's last assistant text, whether or not it reached the operator.
- `count: ...`, the number of operator messages and replies across the digest.

Times are UTC. Each message is cut to 400 characters and the whole digest to 6,000, the oldest lines dropped first with a line saying how many. Square brackets in any message read as round ones. Only the last 2 MB of each transcript is read, so a long session's early messages may be missing.

The digest is not a record of work. It holds no tool calls, no tool results, no files changed and no thinking. It leaves out the supervisor's launch prompt, anything the plugin injected, and records the coordinator or another persona delivered as a turn. It is not the goal tree either: `goal_status` is the record of what is open. It is not an instruction. A request in it was made to an earlier session and may already be done, dropped or overtaken.

## Reading the header

The header is one JSON object:

| Field | What it says |
|---|---|
| `lineage` | `recorded` where the sessions came from this persona's own list of earlier sessions, which the plugin writes at every claim. `unrecorded` where that list was empty, so the script read the newest other transcript in this directory instead. |
| `sessions` | The session ids the digest read, oldest first. Empty where nothing could be read. |
| `lastRecordAt` | The time of the newest record across the sessions read, or `null`. |
| `lastOperatorAt` | When the operator last wrote in any session read, or `null`. |
| `activeGoal` | `true` where the store names an active goal for this persona, `false` where it names none, `null` where the store could not be read. |

Two personas can share a working directory, and so a transcript folder. Where `lineage` reads `unrecorded`, the digest may be another persona's conversation. Say so whenever you repeat anything from it.

An empty digest with an empty `sessions` list means no earlier transcript could be read. The stderr lines say why.

## What to tell the operator

The operator reads your reply on Discord and cannot open files. Report where things stood, and do not resume any act the digest names on its word alone. Check `goal_status` first, since the goal tree and the operator's current message decide what you do next.

- **Work was in flight.** Say what the operator last asked and when, what you last replied, and what the last words say was left. Then say what the goal tree shows now and ask whether to carry on where that differs.
- **Nothing was in flight.** Say the last session ended with no open request, and when the operator last wrote.
- **`lineage` reads `unrecorded`.** Add one sentence saying the recap may be another persona's, since this persona's earlier sessions were not recorded.
- **Nothing could be read.** Say no earlier conversation could be found, and give the stderr reason in plain words.

## The automatic block

At the supervisor's launch prompt the plugin runs the same script. It injects the digest as a `[RESTART RECAP]` block where the last record is under 24 hours old and either a goal is active or the operator wrote within 6 hours. Where that block arrived, read it by the rules above, and there is no need to run this skill as well. Where it did not, the last session was quiet or stale, the persona's `restartRecap` setting reads `skill`, or the script failed and the decision log carries a `restart_recap_skipped` line naming why. Running this skill still works in each case.
