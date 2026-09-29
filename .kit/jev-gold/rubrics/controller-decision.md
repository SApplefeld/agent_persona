# Gold labelling rubric: the controller's decision on an idle worker

Each record is one moment when an autonomous worker session had gone idle and the plugin's controller had to decide what to do next. The worker is a Claude Code agent working a goal from a goal tree, usually a plan document run section by section. You label the decision the controller should have made at that moment, judged by what each decision actually does.

## Fields

- `id`: the record id. Copy it exactly into your output line.
- `state`: the controller's view at the moment it decided. It names the objective, the goal node and whether it is a plan entry (`(plan)` on the `Node:` line) or a task entry, the last five turn scores, how long the worker has been idle, the recent controller decisions, and the option list the controller was offered. The option list names `switch` only where a pending plan existed.
- `opening_prompt`: the message that opened the worker's last turn before the idle gap.
- `final_message`: the worker's last message of that turn. This is what the worker said before it went quiet, and it is usually the text that decides the label.
- `tool_activity`: that turn's tools: yes-or-no flags for a plan read, a plan edit, a commit, a push, an agent dispatch, a `goal_done` call and a reply, the count of work tools, and the last eight tool names in order.
- `next_state`: the controller's view at its next decision on this persona, as hindsight. It is null where there was none.

Use the hindsight as evidence of what the worker's situation really was, not as the answer. What the next view shows tells you what the worker was facing. It does not tell you the controller chose right.

## What each decision does

- A plain nudge sends the worker `[GOAL] The active goal is: ...`, names the idle time, and tells it to re-read the objective and take the next concrete step.
- The idle-gap nudge sends the same goal line, tells the worker the controller read this as an idle gap rather than a real fork, tells it to re-read the plan document, and tells it to state any genuine fork the plan does not resolve as a line `ASK: <question>? Recommend: <choice>`. The operator is asked only if the worker writes that line.
- Complete, on a task entry, marks the goal done and activates the next one. On a plan entry the controller does not act on complete: done is read from the plan document, so complete becomes a plain nudge.
- Switch demotes the current goal to paused and activates a pending plan. It exists only where the option list offers it.

## Labels

Pick exactly one:

There is no label for leaving the worker alone. Both nudges carry the same line on a plan entry, that a `WAITING:` or `BLOCKED:` line holds the controller's nudges, so a worker honestly waiting is not disturbed by either one. The question is which nudge's words fit the worker's situation.

- `nudge`: the worker is on its objective and either has a next step or is honestly waiting on work of its own that is in flight. Includes a worker that reported a step done and has the next step in the plan, a worker that ended on an intermediate status, a worker waiting on a background job, implementer, reviewer, test run or workflow it dispatched for this objective, whether or not the record shows the wait is over, and a plan entry whose work reads finished, since on a plan entry nothing but a nudge acts. The nearest case that is not this one: a wait on something that is not coming, which is `ask-operator`.
- `ask-operator`: the worker is stalled in a way the idle-gap nudge addresses, since that nudge tells it this is not a real fork, to re-read the plan, and to state any genuine fork as an `ASK:` line. Includes a worker that says it needs a decision, reports a blocker it cannot clear itself, waits on a person or another session rather than on its own in-flight work, is looping on the same step or the same wait across nudges without progress, or is working on something other than the objective the state names. The nearest case that is not this one: a first wait on its own dispatched work, which is `nudge`.
- `complete`: a task entry whose objective the worker has evidently finished, so the goal should be marked done now. Never on a plan entry.
- `switch`: the option list offers switch, and the current goal cannot move while a pending plan can, or the worker itself says the pending plan is the one to work on now. Never where the option list does not offer switch.
- `unclear`: the record carries evidence for two labels in equal weight. Not a label for a wait whose end the record does not show; that is `nudge` or `ask-operator` by the rules above. Say in the note which two.

## Confidence and note

- `confidence`: `high`, `medium` or `low`.
- `note`: at most 25 words naming the deciding evidence.

## Output

Reply with one JSON object per line, one line per record, and nothing else:
`{"id": "...", "label": "...", "confidence": "...", "note": "..."}`

Label every record in the batch. Do not skip any. Do not call any external service or tool.
