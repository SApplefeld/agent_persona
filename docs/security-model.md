# Security model

This document states what the persona plugin and its process keeper trust, what they defend against, and which risks the operator has accepted on which preconditions. `README.md` under Trust boundary states how each boundary is enforced. This document states why each boundary sits where it does, and cites that section rather than restating it.

## Threat model

**Deployment.** The code runs on one Windows machine that is a dedicated sandbox, reached only by the operator, locally. Every persona runs as the operator's own Windows account. At boot each one starts from an `AgentPersona-<name>` scheduled task that logs on with the account's stored password at `RunLevel Limited` (`bin/Register-PersonaTasks.ps1`, the `New-ScheduledTaskPrincipal` call). The hand launchers under `D:/personas` start the same supervisor under the same account. The operator steers the fleet from a Discord thread through a relay broker that admits one Discord account, named on the broker's allowlist. The broker lives in the `discord-channels` repository (`D:/discord-channels`). This model rests on that allowlist as an assumption and does not describe how it works.

**Assets.** Four things are protected, from anyone who is not the operator:

- The operator account's credentials and its whole DPAPI reach on the machine: every Windows Credential Manager entry, Git Credential Manager's store, the Azure CLI token cache and any password a browser saved.
- The repositories the fleet works in, and the right to push to them.
- The relay's authority. A message on the operator's thread is treated as the operator's own word.
- The fleet's ability to act as the operator. Children run with `permissionMode` set to `bypassPermissions` in the shipped roster (`bin/fleet.example.json`).

**Attacker classes in consideration.** These are kinds of text, never the parties that send them:

- Text that reaches a session as data. This covers tool output, file text, the body of a peer message, and a channel message from the account the allowlist admits. The allowlist establishes the account rather than the person holding it, so whoever controls that Discord account writes text with the operator's standing. A peer session and the operator are trusted parties under Trust boundaries below, and the text they send is still in consideration here. The two statements are about different things: one says who may steer, the other what a session weighs before acting.
- A roster or store file written by a process that does not run under the operator's account. The file's own permissions are what bound that process, as `README.md` under Trust boundary states for the roster.

The plugin's delivery grounds are labels rather than permissions. These are the reasons a writer may reach a persona's inbox, which `README.md` under Trust boundary lists and `deliveryGroundIn` in `hooks/operator.ts` evaluates. Each ground is a claim a session issues itself. So a ground names which session wrote a record, and it never proves that the session is entitled to steer.

**Attacker classes out of consideration.** Each is out for the reason given:

- Any process under the operator's account, whoever started it and whatever it reads or writes. The operator's decision of 2026-09-15 accepts the account as the boundary. That covers a keyboard session, a script the operator runs, one persona acting against another, and instruction text loaded from the repository tree or from a plugin.
- A Discord message the broker refused. The allowlist is the boundary, and this model rests on it as an assumption.
- A party holding SYSTEM on the machine. The scheduler keeps each task's password in the LSA vault, which SYSTEM can read by the platform's design.

## Trust boundaries

**The operator.** The operator is trusted through two channels. One is the Discord account the relay allowlist admits. The other is the keyboard, where the operator is the local Windows account. A channel message carries the same standing as a typed one, so its text reaches the session as the operator's instruction.

**The local account and every process under it.** Every persona, every subagent a persona dispatches, and every script the operator runs is this one account. Any of them can write every store and roster file on the machine. The plugin separates personas by claims and labels, never by permissions. `README.md` under Trust boundary states that no file permission separates one persona from the roster.

**The operator's machine state.** The roster at `D:/personas/fleet.json`, the environment file at `D:/personas/keeper.env` and the repository tree are trusted as the operator's own state, with no permission check. Those two paths are the keeper's defaults (`bin/Start-Persona.ps1` and `bin/Register-PersonaTasks.ps1`, the `-Roster` and `-EnvFile` parameters). The keeper reads no file's owner, ACL or writers, by the operator's decision of 2026-09-15. It applies only the eight keys on `$script:KeeperEnvAllowlist` in `bin/keeper-functions.ps1` from the environment file, which bounds what that file sets, though not who wrote it.

**Peer sessions.** A peer session is trusted as a party on this machine, under the same account. The label its records carry comes from the commons claims. These are the `persona:<name>` entries a session writes into the machine-global commons store to say which persona it holds (`PERSONA_PREFIX` in `hooks/operator.ts`). A claim is self-issued, so the label says which persona a session holds and never who launched it. A cross-session `SendMessage` reaches the model as the harness delivers it, with no plugin label, because the plugin registers no `session.receive` hook (`README.md` under Trust boundary).

**Tool output and file text.** Whatever a tool returns and whatever a file contains is data, whoever wrote it. It is weighed as evidence and never followed as an instruction.

**The files that take over a persona.** A local process that writes any of these files can steer or replace a persona, and none of them carries a permission check:

- The persona store, `.agentic-personas.json` in the persona's working directory (`PERSONA_STORE_FILENAME` in `hooks/index.ts`). It holds the goal tree, the ask records and the claim state. `persist` in `hooks/index.ts` writes it whole, with no lock.
- The roster, `D:/personas/fleet.json`. It decides which personas exist, which coordinator each worker steers to and which persona holds the architect seat.
- The environment file, `D:/personas/keeper.env`. It sets the bash executable and the `PATH` prefix every persona's child runs under.
- A persona's `restart.request` in its run directory. It restarts that persona's child (`bin/supervise-restart-request.mjs`).
- A persona's `settings.json` in its run directory. The supervisor hands it to the child and never rewrites it once it exists, so its `persona` and `architectPersona` values win over the launch. The Known gaps entry on a provided settings file carries this.

## Accepted risks

**No permission check in the keeper.** The operator's decision of 2026-09-15 removed every permission check from the keeper. No keeper script reads a file's ACL, owner or writers, and none refuses, warns or skips on such a reading. The decision's record is `docs/archive/agent_persona_process-keeper_v1.md`, in its Intent record and its Interim board 11. It rests on three preconditions:

- The machine is a dedicated sandbox that runs nothing but the operator's own work.
- No account other than the operator's can sign in to the machine, locally or remotely.
- The operator account's password is used on no other machine or service.

**The whole DPAPI reach of a Password-logon task.** A task that logs on with a stored password unlocks the account's user-scope DPAPI key (`bin/Register-PersonaTasks.ps1`, the comment above `New-ScheduledTaskPrincipal`). So every persona holds every credential that key protects, not only the git credentials the fleet needs. The scheduler keeps the password in the LSA vault, where a party holding SYSTEM can recover it. This risk rests on the same three preconditions as the one above.

**Children under `bypassPermissions`.** Every persona child runs with `permissionMode` set to `bypassPermissions` in the shipped roster (`bin/fleet.example.json`), so no tool call waits for an approval. What bounds a child's push is the repository's own controls. This risk rests on one precondition, checked on GitHub rather than on the machine: each repository the fleet pushes to has a branch protection rule or an active ruleset on its trunk that requires an approving pull-request review before merge. `gh api repos/<owner>/<repo>/rules/branches/<trunk>` lists a `pull_request` rule with `required_approving_review_count` of at least 1 where a ruleset carries it. The classic branch-protection endpoint does not report rulesets.

## Known gaps

Each gap is an open entry in `docs/backlog.md`, listed by its heading. The backlog entry carries the detail and the remedy.

- **The PowerShell watchdog's taskkill is the one kill with no identity guard.** A bounded PowerShell call in `bin/supervise.sh` can kill whatever process has reused a dead process's id.
- **A child's session id reaches a filesystem path unsanitized.** A value a child writes reaches a file-modification-time read in `bin/supervise.sh`.
- **A roster value carrying a glob character reaches bash unquoted.** A roster value can split into several supervisor arguments in `bin/Start-Persona.ps1`.
- **A provided settings file's persona silently overrides the supervisor's persona argument.** A run directory's `settings.json` decides the persona and the architect name a child takes. The same entry carries the architect seat's outward reach: only the architect's charter, and no code, confines its clones to its own directory and its pushes to the remotes it was handed.
- **Findings the direct-lines finishing pass deferred.** The facet this model counts is that the architect's charter names no disposition for a worker record that carries no design ask.

## What this model does not cover

- **The Claude Code harness.** Its permission modes, its hook runtime and its message delivery are the harness's own.
- **The kit plugin.** Its skills, agents and guards are owned by the kit's own repository.
- **The Discord relay broker.** Its allowlist and delivery are owned by the `discord-channels` repository. This model assumes the allowlist admits only the operator's account.
