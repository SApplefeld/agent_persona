# Gold labelling rubric: what a worker's turn did about its goal

Each record is one completed turn of an autonomous worker session, a Claude Code agent working a goal from a goal tree. The plugin's scorer judged what the turn's answer did about the goal's objective. You label what the turn really did, judged by what the scorer's answer is used for.

## Fields

- `id`: the record id. Copy it exactly into your output line.
- `state`: the scorer's view of the turn: the prompt that opened it cut to 500 characters, the worker's answer cut to 1,000, and the goal objective.
- `opening_prompt`: the message that opened the turn, longer than the cut in `state`. A prompt starting `[GOAL] The active goal is:` is the controller's own nudge.
- `final_message`: the worker's last message of the turn, longer than the cut in `state`. Where it differs from the answer in `state`, the `state` text is what was scored; use both.
- `tool_activity`: the turn's tools: yes-or-no flags for a plan read, a plan edit, a commit, a push, an agent dispatch, a `goal_done` call and a reply, the count of work tools, and the last eight tool names in order.
- `outcomes`: usually empty for this question.
- `next_state`: the scorer's view of the next scored turn on this persona, as hindsight. It is null where there was none.

## What the score is used for

The last five scores and the on-goal count go into the controller's view when it decides what to do with an idle worker. On a task entry, `on-goal`, `drift` and `complete` each spend one round of the goal's budget, and `complete` marks the goal done and activates the next one. On a plan entry nothing completes from this score: done is read from the plan document. `off-goal-by-instruction` is offered only on a turn the controller did not nudge, since a worker answering the controller's own nudge cannot be off the goal by instruction. A turn opened by a channel message or a delivered record is never scored.

## Labels

Pick exactly one:

- `on-goal`: the turn advanced the stated objective. Includes a section landed, a fix round, a review dispatched or read, a status report on work toward the objective, and a wait on the worker's own reviewers or background task for that work. Not the objective itself finished.
- `off-goal-by-instruction`: the opening prompt asked for something outside the objective and the turn did it. The prompt is what decides: a message from the operator, the coordinator or another persona asking for other work. The nearest case that is not this one: a turn the controller's own `[GOAL]` nudge opened, which is never this label.
- `drift`: the turn went somewhere the objective did not point and the prompt did not ask for. Includes a tangent into unrelated cleanup, housekeeping with no bearing on the objective, and a turn that did nothing while the objective had a clear next step.
- `complete`: the turn finished the objective itself: the plan marked Complete and archived, the task's stated outcome delivered, or the final `goal_done` on the whole goal. A single section or step landing is `on-goal`.
- `unclear`: the record does not carry enough to choose between two of the labels above. Use it sparingly, and say in the note which two.

## Confidence and note

- `confidence`: `high`, `medium` or `low`.
- `note`: at most 25 words naming the deciding evidence.

## Output

Reply with one JSON object per line, one line per record, and nothing else:
`{"id": "...", "label": "...", "confidence": "...", "note": "..."}`

Label every record in the batch. Do not skip any. Do not call any external service or tool.
