# Security model: what the persona fleet trusts and which risks it accepts

This document states what the persona plugin and its process keeper trust, what they defend against, and which risks the operator has accepted on which preconditions. `README.md` under "Trust boundary" states how each boundary is enforced. This document states why each boundary sits where it does, and points there rather than restating it.

A persona is a named, long-running Claude Code session with its own goal tree, the list of work it is carrying. The persona is relaunched under the same name whenever it exits. Three components run it. The persona plugin, `agentic-plugin`, is the Claude Code plugin under `hooks/`, which gives each session its persona, its goal tree and an inbox. The process keeper is the set of PowerShell scripts under `bin/` that starts each persona's supervisor at boot and relaunches it when it exits. The supervisor, `bin/supervise.sh`, runs one persona's `claude` child and restarts it when it stalls.

## Threat model

The model defends the operator's authority over the fleet against text. It places every process running as the operator's account inside the boundary, where nothing defends against it.

**Deployment.** The code runs on one Windows machine that is a dedicated sandbox. Every persona runs as the operator's own Windows account, which is a member of Administrators. At boot each persona starts from an `AgentPersona-<name>` scheduled task. The registration script registers each task to log on with the account's stored password (`bin/Register-PersonaTasks.ps1`, the `New-ScheduledTaskPrincipal` call). A task registered before that script took the password logs on as S4U instead, a logon Windows performs for the account without its password. The six tasks on SCOTT-CLAUDE, the machine this model's measured facts were read on, all log on as S4U. Every task runs at `RunLevel Limited`, which means without administrator elevation. The operator reaches the machine at its console or through Remote Desktop. Remote Desktop is enabled, and its firewall rules admit connections on every network profile, so which networks can reach it is not checked from the machine.

The fleet's personas take one of three kinds of seat. A worker executes plans. The coordinator, `steward` in `bin/fleet.example.json`, routes work and relays the operator's rulings to the workers. The architect writes plans and designs and never executes them.

The operator steers the fleet from a Discord thread through a relay broker that admits one Discord account, named on the broker's allowlist. The broker lives in the `discord-channels` repository (`D:/discord-channels`). This model rests on that allowlist as an assumption. The broker's own model is `docs/security-model.md` in that repository.

**Assets.** Four things are protected from the attacker classes in consideration below:

- The credentials the operator's account can use. Some are protected by Windows' per-account encryption key, DPAPI: every Windows Credential Manager entry and Git Credential Manager's store. A process under a password logon of the account can use that key. A task under S4U cannot, because Windows denies user-scope DPAPI to a logon made without the password. Others sit in files in the account's profile, readable by any process running as the account: the fleet's GitHub token in `.config/gh/hosts.yml`, which git uses for every push through `gh auth git-credential`, an SSH key in `.ssh`, and Claude Code's own `.claude/.credentials.json`.
- The repositories the fleet works in, and the right to push to them.
- The relay's authority. A message on the operator's thread is treated as the operator's own word, and the coordinator carries the operator's rulings on to the workers.
- The fleet's ability to act as the operator. Every entry in the machine's roster, `D:/personas/fleet.json`, runs its child with `permissionMode` set to `bypassPermissions`, so no tool call waits for an approval. `bin/fleet.example.json` shows the same setting.

The plugin guards one of these assets itself, the relay's authority. The operator's rulings reach a worker as records from the coordinator, so the plugin controls which text reaches a session's model under which label. A record is a message one session writes to another persona's inbox with `agentic_say`. The delivery gate, `deliveryGroundIn` in `hooks/operator.ts`, delivers a record only where its writer holds one of four delivery grounds. It labels the record with that ground, such as `[COORDINATOR id=...]`.

The four grounds are these. A writer may hold a reader claim on the receiving persona, which lets a session watch that persona. It may hold the coordinator persona. It may hold any named persona other than `default` when the receiving persona is the coordinator or the architect. And a writer holding the architect persona may answer a record the receiving persona sent the architect and that is still open. Each ground is a claim a session issues itself, so a label records which persona a writer claims to hold and grants no permission. `README.md` under "Trust boundary" states the gate's rules.

A label does carry authority once delivered. The supervisor tells each worker that a `[COORDINATOR id=...]` record carries the operator's delegated authority for an act inside the worker's approved plan (`COORDINATOR_STEER_INSTRUCTION` in `bin/supervise.sh`). It tells the architect to take coordinator and worker records as its own work (`ARCHITECT_ROLE_INSTRUCTION` in `bin/supervise.sh`). So a process that holds the coordinator persona speaks with the operator's delegated authority to every worker. The other three assets rest on the preconditions under "Accepted risks".

**Attacker classes in consideration.** Three classes are in consideration:

- Text that reaches a session as data. This covers tool output, the text of a file the session reads while it works, a record labelled `READER` or `WORKER` to a worker, and the body of a cross-session `SendMessage`, which Claude Code delivers between sessions. A session weighs such text as evidence and follows none of it as an instruction. Instruction text a session runs under is outside this class. `CLAUDE.md` files, a plugin's hooks and skills, the supervisor's role instructions and the relay's instructions are instances of it, and the list is open.
- A party holding the operator's Discord account. The allowlist establishes the account rather than the person holding it. So the relay's instructions, which its channel plugin gives each session (`relay/protocol.ts` in the `discord-channels` repository), have a session confirm an irreversible or outward-facing act before taking it, even when the thread asked for it. Their stated reason is the act's blast radius.
- A file listed under "The files that take over a persona", written by a process that does not run as the operator's account. For the files under `D:/`, no file permission bounds this case, as "No permission check in the keeper" under "Accepted risks" states.

**Attacker classes out of consideration.** Each is out for the reason given:

- Any process running as the operator's account, whoever started it and whatever it reads or writes. The operator's sandbox decision of 2026-09-15 accepts the account as the boundary for the keeper's files. This model reads that decision as covering every process under the account. That covers a keyboard session, a script the operator runs, and one persona acting against another.
- Instruction text that enters the repository tree through a fetch or a merge. What reaches a repository's trunk passes that repository's own review rule, the first precondition of "Children under `bypassPermissions`".
- A Discord message the broker refused. The allowlist is the boundary.
- A party holding SYSTEM, the Windows service account above every user. The scheduler keeps the password of each task that logs on with one in the LSA vault, a system store that SYSTEM can read by the platform's design. An S4U task stores no password there.

## Trust boundaries

Each entry below names what this model trusts and on what ground. A party is trusted as a party, and text it sends is still weighed under the attacker classes above. The operator's own messages and a coordinator-labelled record to a worker are the texts a session acts on as instructions.

**The operator.** The operator is trusted through two channels. One is the Discord account the relay allowlist admits. The other is the keyboard, where the operator is the local Windows account. A channel message carries the same standing as a typed one. The relay's instructions state this (`relay/protocol.ts` in the `discord-channels` repository).

**The local account and every process under it.** Every process running as this one account is trusted with everything the account can do. That is every persona, every subagent a persona dispatches, and every script the operator runs. Any of them can write every store and roster file on the machine. The plugin separates personas by the claims each session issues for itself, described under "Peer sessions" below. `README.md` under "Trust boundary" states that no file permission separates one persona from the roster.

**The operator's machine state.** The roster at `D:/personas/fleet.json`, the environment file at `D:/personas/keeper.env` and the repository tree are trusted as the operator's own state. Those two paths are the keeper's defaults (`bin/Start-Persona.ps1` and `bin/Register-PersonaTasks.ps1`, the `-Roster` and `-EnvFile` parameters). From the environment file the keeper applies only the eight keys on `$script:KeeperEnvAllowlist` in `bin/keeper-functions.ps1`. That bounds which variables the file can set, though not who wrote it. The process list is trusted the same way. A process whose command line carries a persona's launcher and arguments is adopted as that persona's supervisor. `README.md` under "Process keeper" states the mechanics of both.

**Peer sessions.** A peer session is trusted as a party on this machine, under the same account. Its standing comes from its commons claims. The commons store is a file the account's sessions share, one per way the plugin is loaded, located under "The files that take over a persona". A commons claim is a `persona:<name>` entry a session writes there to say which persona it holds (`PERSONA_PREFIX` in `hooks/operator.ts`). A cross-session `SendMessage` reaches the model as Claude Code delivers it, with no plugin label. The plugin could label or filter such a message only through a `session.receive` hook, and it registers none (`README.md` under "Trust boundary").

**Tool output and file text.** Whatever a tool returns and whatever a file contains is data, whoever wrote it. The one bound on roster text is the fleet reading's own: the coordinator's plugin treats roster-supplied text as untrusted and bounds it (`README.md` under "Trust boundary"). Past that, this boundary rests on the instructions each session runs under.

**The files that take over a persona.** A local process that writes any of these files can steer or replace a persona. None of the keeper, the supervisor or the plugin checks who wrote them. Two directories locate them. A persona's working directory is the one its roster entry's `workdir` names, which for most workers is the repository the worker works in. Its run directory is the entry's `rundir`, or `<working directory>/run` where none is given (`bin/supervise.sh`, the `RUNDIR` default).

- The persona store, `.agentic-personas.json` in the working directory (`PERSONA_STORE_FILENAME` in `hooks/index.ts`). It holds the goal tree, the id of the open ask to the operator, and which session holds the persona. `persist` in `hooks/index.ts` writes it whole, with no lock.
- The heartbeat file, `.agentic-heartbeat.json` in the working directory. The supervisor reads it before each launch, to refuse a launch while another session holds the persona (`wait_persona_free_both` in `bin/agentic-common.sh`). It reads it again to judge whether a running child has hung (`bin/supervise.sh`, the `HEARTBEAT` path).
- The commons store, an `agentic-plugin_*.json` file under `$HOME/.claude/plugins/store`, which `find_global_store` in `bin/agentic-common.sh` locates. An installed copy of the plugin and a development checkout each keep their own. It holds every live claim and every record, the asks included. The supervisor's pre-launch check reads the claims. `HOME` comes from the environment file below.
- The roster, `D:/personas/fleet.json`, which the keeper reads (`Read-KeeperRoster` in `bin/keeper-functions.ps1`) and the coordinator's plugin reads (`readRosterFile` in `hooks/index.ts`). It decides which personas exist, which coordinator each worker takes direction from and which persona holds the architect seat.
- The environment file, `D:/personas/keeper.env`. Its eight keys set the bash executable, the `PATH` prefix and six directories. The six are `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP`, which every child resolves its own state and credentials from.
- `restart.request` in the run directory, which restarts that persona's child (`bin/supervise-restart-request.mjs`).
- `keeper.hold` in the run directory, which keeps the persona from launching for as long as it exists (`bin/Start-Persona.ps1`, the `$holdPath` check).
- `settings.json` in the run directory, which the supervisor hands to the child. Once it exists, the supervisor fills in a few missing keys and otherwise takes it as written (`bin/supervise.sh`, the provided-file branch). The child's plugin reads `persona`, `coordinatorPersona`, `architectPersona` and `fleetRoster` from it. So the file decides which persona the child claims, whose records reach it as the coordinator's, which persona it treats as the architect, and which roster it reads.
- The repository tree the scheduled tasks run from, and the plugin's installed hooks. Each task runs `bin/Start-Persona.ps1` and `bin/supervise.sh` from the repository root it was registered with (`bin/Register-PersonaTasks.ps1`, the `-RepoRoot` parameter). So a process that writes those scripts or the hooks replaces every persona at once.
- The files Claude Code itself loads for a child from its working directory: `CLAUDE.md` and the settings files under `.claude/`. They set the child's instructions and its permissions.

The list holds the files this model has traced. Any other file the keeper, the supervisor, the plugin or the child loads to launch or steer a persona belongs to the same class.

## Accepted risks

The operator has accepted three risks, and each holds only while its preconditions hold. A precondition that stops holding sends its risk back to the operator as a decision.

**No permission check in the keeper.** By the operator's sandbox decision of 2026-09-15, the keeper carries no permission check. No keeper script refuses, warns or skips on who owns or can write a file. The decision's record is `docs/archive/agent_persona_process-keeper_v1.md`. The rule sits under its "Standing Brief Amendments" heading, the rules every later section of that plan ran under. The operator's answer is quoted in its entry "Interim board 11".

On this machine the group Authenticated Users can modify `D:/`, and `D:/personas`, `D:/agent_persona` and every worker's repository inherit that (`icacls`). Windows counts its own service accounts among authenticated users. So a process on the machine that does not run as the operator can write every takeover file under `D:/`. That includes the environment file, which sets `HOME` and so decides where every child finds its commons store and its credentials. The profile directories under `C:/Users` admit only the operator's account, Administrators and SYSTEM. The risk rests on four preconditions:

- The machine is a dedicated sandbox that holds no credential for anything beyond the fleet's own work. `gh auth status`, `cmdkey /list` and the account's `.ssh` directory show what it holds.
- The operator's account is the only enabled local user account. `Get-LocalUser` shows this.
- No account but the operator's can sign in remotely. Remote Desktop admits members of Administrators and Remote Desktop Users. So this holds while the operator's account is the only enabled member of both groups, which `Get-LocalGroupMember` shows.
- The operator account's password is used on no other machine or service. This cannot be checked from the machine, so it rests on the operator's word.

**Every child holds the account's file credentials, and under a password logon its DPAPI credentials too.** Every child can read the credential files in the profile. A task that logs on with a stored password also unlocks the account's DPAPI key for everything the task runs (`bin/Register-PersonaTasks.ps1`, the comment above `New-ScheduledTaskPrincipal`). An S4U task does not. So on SCOTT-CLAUDE every persona can use the GitHub token, the SSH key and Claude Code's credentials, and cannot use the Credential Manager entries. Nothing bounds what a persona does with a credential it can use. Because SYSTEM is out of consideration, this model also accepts that a party holding it can recover a password-logon task's password from the LSA vault. This risk rests on the same four preconditions as the one above.

**Children under `bypassPermissions`.** What bounds a child's push is each repository's own controls, because no tool call a child makes waits for an approval. No code confines a child to the repository it works in. So the repositories in scope are every repository the fleet's push account can push to. This risk rests on three preconditions:

- Each such repository requires an approving pull-request review before anything merges to its trunk, and a push after that approval needs a fresh one. A ruleset meeting this shows a `pull_request` rule in `gh api repos/<owner>/<repo>/rules/branches/<trunk>`. Its `required_approving_review_count` is at least 1, and `dismiss_stale_reviews_on_push` and `require_last_push_approval` are both true. That endpoint does not report a classic branch protection rule. A classic rule shows `required_pull_request_reviews` in `gh api repos/<owner>/<repo>/branches/<trunk>/protection`, which only an admin of the repository can read.
- The push account cannot bypass or change that rule. `gh api repos/<owner>/<repo>` shows `admin` false in its `permissions`. For a ruleset, `gh api repos/<owner>/<repo>/rulesets/<id>` shows `current_user_can_bypass` as `never`. GitHub refuses an author's approval of their own pull request, so this account cannot approve what it authored.
- No credential for an account that can approve those pull requests is stored on the machine. `gh auth status` and the credential files under "Assets" show this.

The preconditions bound what reaches a trunk and nothing else. A push to any other branch is outside them. The push account's token carries the `workflow` scope, so such a push can add a GitHub Actions workflow that runs on that push. This model accepts that reach as part of this risk.

The fleet pushes as the GitHub account `neo-claude`. It can push to nine repositories under `SApplefeld`, is an admin of none, and `gh auth status` shows no other account. How far each repository meets the first precondition, read on each trunk `main`:

- Met, by an active ruleset requiring one approving review with stale approvals dismissed and last-push approval required, which `neo-claude` cannot bypass: `agent_persona` (ruleset `protect-main`, id 22911862), `claude-kit`, `discord-channels` and `Neuro-Evolution-Operations`.
- Unknown: `ai-os`, `claude-memory`, `knowledge-base` and `llm-wiki` carry classic branch protection, which `neo-claude` cannot read. An admin of each can check it with the classic endpoint above.
- Not met: `Tabletop-Adventure-Simulator` has no protection on `main`, so the fleet's account can push to it directly.

So this risk stands accepted for the four repositories that meet the precondition. For the other five it is the operator's decision.

## Known gaps

Each gap is an open entry in `docs/backlog.md`, listed by its heading. The backlog entry carries the detail and the remedy.

- **The PowerShell watchdog's taskkill is the one kill with no identity guard.** A bounded PowerShell call in `bin/supervise.sh` can kill whatever process has reused a dead process's id.
- **A child's session id reaches a filesystem path unsanitized.** A value a child writes reaches a file-modification-time read in `bin/supervise.sh`.
- **A roster value carrying a glob character reaches bash unquoted.** A roster value can split into several supervisor arguments in `bin/Start-Persona.ps1`.
- **A provided settings file's persona silently overrides the supervisor's persona argument.** A run directory's `settings.json` decides which persona a child claims. For the architect seat the same entry records that only its charter confines where it clones and pushes.
- **Findings the direct-lines finishing pass deferred.** The direct lines are the paths that let a worker and the architect message each other. The architect's charter, `ARCHITECT_ROLE_INSTRUCTION` in `bin/supervise.sh`, states no handling for a worker's record that carries no design question.

## What this model does not cover

- **Claude Code itself.** Its permission modes and message delivery are its own.
- **The kit plugin.** Its skills and agents are owned by the kit's own repository.
- **The Discord relay broker.** Its own security model is `docs/security-model.md` in the `discord-channels` repository.
