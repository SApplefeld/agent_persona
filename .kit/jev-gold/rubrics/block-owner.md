# Gold labelling rubric: who has to act next before a worker's work moves

Each record is the end of one turn of an autonomous worker session, a Claude Code agent working a plan document under a goal tree. You label who has to act next before this worker's work can move.

## Fields

- `id`: the record id. Copy it exactly into your output line.
- `state`: a JSON object. `closingText` is how the worker ended the turn, cut to 1,000 characters. `recentClosingTexts` holds how it ended its last few turns on the same plan, oldest first.
- `opening_prompt`: the message that opened the turn.
- `final_message`: the worker's last message of the turn, longer than `closingText`. Where the two differ, `closingText` is what was asked about; use both.
- `tool_activity`: the turn's tools: yes-or-no flags for a plan read, a plan edit, a commit, a push, an agent dispatch, a `goal_done` call and a reply, the count of work tools, and the last eight tool names in order.
- `next_state`: the same view at the worker's next turn end on this persona, as hindsight. It is null where there was none.

Use the hindsight as evidence of what the worker was really waiting on, not as the answer.

## What the answer is for

Nothing acts on this answer yet. It is read to find the turns where a person or another session has to act before the worker can carry on, so a coordinator could route that turn to them. Label who the work is waiting on, not who happens to speak next.

## Labels

Pick exactly one:

- `operator`: the human operator owes a question, a decision or an approval before the work moves. Includes an `ASK:` line, a stated fork with a recommendation, and a request to merge, deploy or confirm something only the operator may. The nearest case that is not this one: a worker that reports to the operator and carries on, which is `none`.
- `coordinator`: the coordinating session that queues this worker's work has to queue, release, review or reassign something. Includes a section handed to the coordinator for review or a finished plan handed back for the next assignment.
- `another-plan`: other work has to land first, such as another plan's merge or another worker's change this work depends on.
- `self-resolving`: nobody has to act. Something already running will finish on its own and wake the worker: its own reviewers or subagents, a background suite or build, or a timer. Includes a `WAITING:` line on the worker's own dispatched agents.
- `none`: nobody is being waited on. The worker is carrying on, finished a step and has the next one, or reported and moved on.

Where the record leaves two owners open, pick the likelier, set confidence to `low`, and name the other in the note.

## Confidence and note

- `confidence`: `high`, `medium` or `low`.
- `note`: at most 25 words naming the deciding evidence.

## Output

Reply with one JSON object per line, one line per record, and nothing else:
`{"id": "...", "label": "...", "confidence": "...", "note": "..."}`

Label every record in the batch. Do not skip any. Do not call any external service or tool.
