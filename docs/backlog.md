# Backlog

## Suite hardening

- **Goaltree planner variance**: the goaltree suite asserts an exact 12-step sequence that depends on the planner returning exactly the roadmap's 3 items. On 2026-09-08 the planner returned 4 plans (one extra "Verify Syllable Counts") against a 3-item roadmap, producing a red run. Rerun at the same commit passed with 3 plans. Harden by either pinning the plan count in the planner prompt when a roadmap is given, or asserting on the roadmap's items rather than a fixed step sequence. (Round 35, Fable)
