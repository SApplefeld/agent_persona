# Client Sandbox Host Runbook

This runbook stands up one client's sandbox host. The host is a Windows VM running a persona fleet that the client's own people steer from their own Discord server. It shares nothing with your fleet. It has its own Discord server, bot and broker, and a GitHub token for the client's one repository. Its Claude account's spend is the experiment's, and its memory store syncs nowhere. Run the sections in order, since each step depends only on steps above it. The first host is accepted against the checklist at the end.

## Values You Supply

Angle brackets mark a value you supply. Every other value in this runbook is fixed by the code or chosen here, so type it as written.

| Value | What goes there |
|---|---|
| `<owner>` | The GitHub account or organization that owns the client repository |
| `<client repo>` | The client repository's name on GitHub |
| `<client branch>` | The client's branch on Azure DevOps |
| `<Azure DevOps url>` | The clone URL of the Azure DevOps repository that holds `<client branch>` |
| `<bridge folder>` | The folder on your own machine that holds the bridge clone |
| `<sweep pattern>` | A regular expression matching every other client's name and the credential shapes your repositories carry |
| `<reviewer>` | The GitHub account that reviews the worker's pull requests: a client user's, or a second account of yours. It is never the token's owner, since GitHub refuses an author's approval of their own pull request |
| `<host>` | The VM's name, in capitals, as `$env:COMPUTERNAME` prints it. The broker shows it on its cards |
| `<user>` | The VM's Windows account that runs the fleet |
| `<channel id>`, `<your user id>`, `<client user id>` | Discord IDs, copied with Developer Mode on |

`<plan filename>`, `<number>` and `<id>` are values a step below produces. This runbook names the four personas `steward`, `architect`, `liaison` and `dev`, and keeps the fleet under `D:\personas`. This layout puts the fleet, the broker and the clones on a `D:` drive, so the VM needs one. Host commands run in Windows PowerShell.

## Discord Server

The client gets a Discord server, a bot and a channel of its own. Everyone who can see a channel reads every prompt, reply and tool approval in it. So the client's people never share a channel, a server or a bot with your fleet or with another client.

1. Create a Discord server for this client alone, and have each client user join it.
2. Create the host's bot under step 1 of `docs/install.md` in the `discord-channels` repository: Message Content Intent on, the bot permissions that step lists, and the bot invited to this server.
3. Create one text channel, private to the bot, yourself and the client users.
4. With Developer Mode on, copy the channel's ID, your own user ID and each client user's ID.

Check: the channel's member list shows the bot, you and the client users, and nobody else.

## Client Repository

The client's code lives in one private GitHub repository, seeded from its Azure DevOps branch and kept in step by a bridge clone on your own machine. Every command in this section runs on your machine, which holds the Azure DevOps credential. The host never holds it.

1. Create the repository:

   ```
   gh repo create <owner>/<client repo> --private
   ```

2. Clone the client branch as the bridge, then name its two remotes:

   ```
   git clone --single-branch --branch <client branch> <Azure DevOps url> <bridge folder>
   cd <bridge folder>
   git remote rename origin ado
   git remote add client https://github.com/<owner>/<client repo>
   ```

3. Sweep the branch and its history for secrets and other clients' names before the first push:

   ```
   git log --all -p -i -G "<sweep pattern>"
   git log --all -i --grep "<sweep pattern>"
   git log --all --name-only --format= | Sort-Object -Unique | Select-String -Pattern "<sweep pattern>"
   ```

   The first command reads every change in the history, the second every commit message, and the third every file path. The first diffs every commit, so on a long history it runs for minutes before it prints. Run each once with a word you know the history holds, and see it print, before you trust its silence. A match stops the seeding until it is resolved on `<client branch>` in Azure DevOps.

4. Push the branch as the new repository's `main`:

   ```
   git push client HEAD:refs/heads/main
   ```

5. Protect `main`. Under the repository's Settings, Rules, add a branch ruleset targeting `main`, active, with an empty bypass list. It requires a pull request with one approving review, dismisses stale approvals on a push, and requires approval of the most recent push.

6. Give `<reviewer>` write access. The ruleset counts only an approval from an account with write access.

   ```
   gh api -X PUT repos/<owner>/<client repo>/collaborators/<reviewer> -f permission=push
   ```

   GitHub emails `<reviewer>` an invitation, which they accept.

Check: `gh repo view <owner>/<client repo> --json defaultBranchRef --jq .defaultBranchRef.name` prints `main`. `gh api repos/<owner>/<client repo>/rules/branches/main` shows a `pull_request` rule whose `required_approving_review_count` is at least 1, with `dismiss_stale_reviews_on_push` and `require_last_push_approval` both true. `gh api repos/<owner>/<client repo>/collaborators/<reviewer>/permission --jq .permission` prints `write`.

## Host Machine

The host is a Windows VM with one local account, `<user>`, which runs every persona.

1. Install Git for Windows, Node.js 24 or later, the GitHub CLI and Claude Code. The broker requires Node.js 24 or later.
2. Let the account run the repositories' PowerShell scripts:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

Check: `node --version` prints `v24` or later. `git --version`, `gh --version` and `claude --version` each print a version. `Get-ExecutionPolicy` prints `RemoteSigned`.

## Credentials

The host holds four credentials, each issued for this host alone. This section provisions two: the experiment's Claude account and a GitHub token for the client repository. The Broker section adds the other two, the Discord bot's token and a key for TypeSafe, the vendor whose Jev classifier the broker, the persona plugin and the kit's memory store call. No credential of your own fleet is ever copied onto it.

1. Run `claude` and sign in with the Claude account whose spend is the experiment's.
2. Create a fine-grained GitHub token whose resource owner is `<owner>`. Limit its repository access to `<client repo>` alone, give it Contents and Pull requests at read and write, and set an expiry date.
3. Sign the GitHub CLI in with that token, then make it Git's credential for GitHub:

   ```powershell
   gh auth login
   gh auth setup-git
   ```

   At the login prompts, choose GitHub.com and HTTPS, and paste the token.

Check: `gh auth status` shows one account. `git config --global --get-all credential.https://github.com.helper` prints an empty line, then a line ending `auth git-credential`, so Git asks the GitHub CLI and nothing else for a GitHub credential. `Test-Path $HOME\.git-credentials` and `Test-Path $HOME\.ssh` both print `False`.

Never place any of these on the host: a file from a fleet machine's `.claude` folder, its GitHub CLI configuration, its SSH keys, an Azure DevOps credential, or a TypeSafe key a fleet host uses.

## Plugins and Kit

The fleet runs on the persona plugin and the kit. Both must be installed before any persona launches. The liaison's charter loads the kit's `liaison` skill, and the doctrine's class clause tells every session how to weigh a participant's message.

1. Install the persona plugin:

   ```
   claude plugin marketplace add SApplefeld/agent_persona
   claude plugin install agentic-plugin@agent-persona --scope user
   ```

2. Install the kit:

   ```
   claude plugin marketplace add SApplefeld/claude-kit
   claude plugin install claude-kit@applefeld --scope user
   ```

3. Import the kit's doctrine for every session. The command adds the import line only where `CLAUDE.md` lacks it:

   ```powershell
   if (-not (Select-String -Path $HOME\.claude\CLAUDE.md -SimpleMatch -Pattern '@claude-kit-doctrine.md' -Quiet -ErrorAction SilentlyContinue)) { Add-Content -Path $HOME\.claude\CLAUDE.md -Value '@claude-kit-doctrine.md' }
   ```

4. Run the kit doctor from the installed payload with `-Fix`, and accept its repairs:

   ```powershell
   & (Get-ChildItem $HOME\.claude\plugins\cache\applefeld\claude-kit\*\doctor\doctor.cmd | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Fix
   ```

   It installs the `memq` command in `$HOME\.claude\bin` and adds that folder to the user `PATH`. Where its Memory sync line reads WARN for a store with no origin remote, that is the state this host needs. Never apply the remote that line proposes.

5. Open a new PowerShell window, run `claude` once, and `/exit`. The kit's session hook writes the doctrine file on that start.

Check: `Select-String -Path $HOME\.claude\claude-kit-doctrine.md -SimpleMatch -Pattern 'sender_class'` prints the doctrine's class clause. `Get-ChildItem $HOME\.claude\plugins\cache\applefeld\claude-kit\*\skills\liaison\SKILL.md` lists the liaison skill. `Get-Command memq` resolves under `$HOME\.claude\bin`.

## Memory Isolation

The host's kit memory store starts empty and syncs nowhere. The operator tier on your fleet machines carries the names of other clients, so nothing from it may reach this host. The store's root is `$HOME\.claude`.

Write the kit's Jev config, so `memq` has Jev judge the store's records against the work in progress. The file names TypeSafe's endpoint and model and holds no key:

```powershell
'{"endpoint":"https://api.typesafe.ai","model":"jev-latest"}' | Set-Content -Encoding ascii $HOME\.claude\kit-jev.json
```

| Check | Expected | Why |
|---|---|---|
| `Test-Path $HOME\.claude\kit-memory-db.json` | `False` | With no database client file, the store publishes to no shared database |
| `git -C $HOME\.claude remote -v` | prints nothing | The store syncs only where it has a remote |
| `Test-Path $HOME\.claude\kit-jev.json` | `True` | With it, `memq` sends TypeSafe each nearby record's name, description and status for judging |
| `Test-Path $HOME\.claude\kit-sidecar` | `False` | The kit's sidecar hook captures nothing while its spool folder, `kit-sidecar\spool`, is absent |
| `Test-Path $HOME\.claude\kit-endpoint.json` | `False` | The sidecar's judge service is on your own network, and this file would name it |

Never run the kit's sidecar daemon on this host. Running it creates the spool folder. Never copy a memory file from a fleet machine.

## Broker

The host runs its own broker from the `discord-channels` repository. Its senders list admits every client user as an operator, and its response gate runs in `shadow` until the threshold is chosen. `docs/install.md` in that repository owns each step below, and this section gives the values for a client host.

1. Clone the broker:

   ```powershell
   git clone https://github.com/SApplefeld/discord-channels D:\discord-channels
   Set-Location D:\discord-channels
   ```

   Leave the user environment variable `CHANNEL_LAUNCH_FLAG` unset. The launch wrapper then starts every session with `--channels`, and the checkout stays unedited. "The launch dialog" in `docs/install.md` owns that variable.

2. From the repository root, in a non-elevated window, install the host. Give `-Senders` one entry per client user, each as an operator:

   ```powershell
   install\Install-All.ps1 -HostName <host> -ChannelId <channel id> -AllowedUserId <your user id> `
       -Senders "<client user id>:operator,<client user id>:operator"
   ```

   It prompts for the bot token and raises one UAC prompt. Every operator holds your whole authority over the host. A client user added later is an edit to `CHANNEL_SENDERS` in `broker.env` and a broker restart.

3. Write the TypeSafe key file, from the same non-elevated window. The broker sends TypeSafe held batches and persona replies to judge. Use a key no fleet host uses, so revoking it touches this host alone:

   ```powershell
   $k = Read-Host 'TypeSafe key' -AsSecureString
   [IO.File]::WriteAllText("$env:LOCALAPPDATA\sapplefeld-channels\inbox-judge-key.txt", [Net.NetworkCredential]::new('', $k).Password)
   ```

   Then give every Claude session on the host the same key, through the `env` block of the user-level settings file. The persona plugin and `memq` read it from there. The keeper's env file cannot carry it, since its allowlist refuses every other key:

   ```powershell
   node -e "const fs=require('fs');const f=require('os').homedir()+'/.claude/settings.json';const s=JSON.parse(fs.readFileSync(f,'utf8'));s.env=Object.assign({},s.env,{TYPESAFE_API_KEY:fs.readFileSync(process.env.LOCALAPPDATA+'/sapplefeld-channels/inbox-judge-key.txt','utf8').trim()});fs.writeFileSync(f,JSON.stringify(s,null,2))"
   ```

   Check: `node -e "console.log(Boolean(require(require('os').homedir()+'/.claude/settings.json').env.TYPESAFE_API_KEY))"` prints `true`.

4. Add the gate, the inbox card and the key file to `%LOCALAPPDATA%\sapplefeld-channels\broker.env`:

   ```
   CHANNEL_RESPONSE_GATE=shadow
   CHANNEL_INBOX_CARD=true
   CHANNEL_INBOX_JUDGE_KEY_FILE=C:\Users\<user>\AppData\Local\sapplefeld-channels\inbox-judge-key.txt
   ```

   The inbox card has Jev read each persona reply for a question the persona did not mark as one.

5. Restart the broker, in an elevated window from `D:\discord-channels`:

   ```powershell
   .\install\Repair-Broker.ps1
   ```

6. Run the per-host verification under "The relay as a plugin" in `docs/install.md`, steps 2 to 4. From a new PowerShell window, `cchat sandbox-check` launches a watched session. A message typed in its thread must reach it, and its reply must land back in the thread. Then `/exit`.

Check: `Select-String -Path $env:LOCALAPPDATA\sapplefeld-channels\broker.env -Pattern '^CHANNEL_SENDERS='` shows every client user's ID with `:operator`. `Get-Content $env:LOCALAPPDATA\sapplefeld-channels\broker.log -Tail 50` holds no refusal naming the sender roster, the gate mode or the key file. `curl.exe -s http://127.0.0.1:8787/sessions` answers. `Test-Path $env:LOCALAPPDATA\sapplefeld-channels\relay-mcp.json` prints `True`. Every persona's channel loads through the relay plugin, which reads that file and exits where it is missing. Only a wrapped launch, such as the one in step 6, writes it.

## Client Disclosure

Give the client these four facts in writing before any client user posts in a thread.

1. Every persona turn sends its text to Anthropic, under the experiment's Claude account.
2. Discord stores every thread message, card and tool approval prompt under Discord's own retention. A tool approval prompt carries the tool's actual input.
3. TypeSafe, through its Jev classifier, may receive most of what Anthropic receives. That includes client messages in a thread, persona replies, the personas' plans, goals and working state, and the names and descriptions of records in the host's memory store. What it receives may grow as the fleet gains Jev features, without a new notice. It receives this under a key issued for this host alone.
4. The host stores its memory store, its session transcripts and the gate's journal on the host alone. Facts 1 and 3 still send parts of their content off it.

## Fleet

The fleet is four personas: the steward as coordinator, the architect, the liaison, and one worker, `dev`, in the client repository. Each runs under a scheduled task the process keeper registers.

1. Clone the persona repository, which the tasks run from:

   ```powershell
   git clone https://github.com/SApplefeld/agent_persona D:\agent_persona
   ```

2. Create the persona folders:

   ```powershell
   New-Item -ItemType Directory -Force D:\personas\steward, D:\personas\architect, D:\personas\dev, D:\personas\liaison\.claude, D:\personas\liaison\notes
   ```

3. Clone the client repository as the worker's working directory, and keep the persona's state files out of it:

   ```powershell
   git clone https://github.com/<owner>/<client repo> D:\<client repo>
   Add-Content -Path D:\<client repo>\.git\info\exclude -Value '.agentic-*'
   ```

   The worker's persona store, heartbeat and channel log sit in its working directory as `.agentic-*` files.

4. Give the liaison its settings file, the template this repository ships:

   ```powershell
   Copy-Item D:\agent_persona\docs\liaison-settings.template.json D:\personas\liaison\.claude\settings.json
   ```

   The liaison runs on the `default` permission mode, and its allow list marks the tools it runs without approval. In the supervisor's launch, with the channel attached, a tool outside the list is refused and no approval reaches the thread. A Bash command the harness classes as read-only runs without approval. The harness decides that class, and its reach is unmeasured. The liaison's bounds assume the user-level settings file grants nothing more. The broker's installer, in Broker step 2, writes that file's one allow rule, the relay's reply tool. So check it: `node -e "console.log(JSON.stringify(require(require('os').homedir()+'/.claude/settings.json').permissions))"` prints an allow list holding `mcp__plugin_relay_channel-relay__reply` and nothing else. A missing file means Broker step 2 did not finish, so run it again. Any other allow entry widens every persona on the host, the liaison included, so remove it.

5. Trust the liaison's working directory. The harness ignores the settings file's allow list in a directory it has not trusted.

   ```powershell
   Set-Location D:\personas\liaison
   claude
   ```

   Accept the trust dialog, then `/exit`.

   Check: `node -e "console.log(require(require('os').homedir()+'/.claude.json').projects['D:/personas/liaison'].hasTrustDialogAccepted)"` prints `true`. An untrusted directory shows at launch as this line in the liaison's `stderr.log`: `Ignoring N permissions.allow entries from .claude/settings.json: this workspace has not been trusted`.

6. Write the roster to `D:\personas\fleet.json`. The steward and the liaison both carry `liaisonPersona`. The liaison needs it for its charter, and the steward needs it to answer the liaison's status asks.

   ```json
   [
     {
       "name": "steward",
       "workdir": "D:/personas/steward",
       "permissionMode": "bypassPermissions",
       "rundir": "D:/personas/steward/run",
       "channelName": "steward",
       "model": "sonnet",
       "controllerTickMs": 300000,
       "jevMode": "shadow",
       "coordinatorPersona": "steward",
       "architectPersona": "architect",
       "liaisonPersona": "liaison",
       "fleetRoster": "D:/personas/fleet.json",
       "enabled": true
     },
     {
       "name": "architect",
       "workdir": "D:/personas/architect",
       "permissionMode": "bypassPermissions",
       "rundir": "D:/personas/architect/run",
       "channelName": "architect",
       "model": "fable",
       "effort": "high",
       "controllerTickMs": 60000,
       "jevMode": "shadow",
       "coordinatorPersona": "steward",
       "architectPersona": "architect",
       "enabled": true
     },
     {
       "name": "liaison",
       "workdir": "D:/personas/liaison",
       "permissionMode": "default",
       "rundir": "D:/personas/liaison/run",
       "channelName": "liaison",
       "jevMode": "shadow",
       "coordinatorPersona": "steward",
       "architectPersona": "architect",
       "liaisonPersona": "liaison",
       "enabled": true
     },
     {
       "name": "dev",
       "workdir": "D:/<client repo>",
       "permissionMode": "bypassPermissions",
       "rundir": "D:/personas/dev/run",
       "channelName": "dev",
       "model": "opus",
       "jevMode": "shadow",
       "coordinatorPersona": "steward",
       "architectPersona": "architect",
       "enabled": true
     }
   ]
   ```

7. Write the keeper's environment file to `D:\personas\keeper.env`. The scheduled task starts outside any interactive session, so its `PATH` and profile folders come from this file. In `KEEPER_PATH_PREPEND`, replace each `<... folder>` with the folder `where.exe` prints for that command.

   ```
   KEEPER_BASH_EXE=C:\Program Files\Git\bin\bash.exe
   KEEPER_PATH_PREPEND=C:\Program Files\Git\bin;<node folder>;<claude folder>;<gh folder>;C:\Users\<user>\.claude\bin
   HOME=C:\Users\<user>
   USERPROFILE=C:\Users\<user>
   APPDATA=C:\Users\<user>\AppData\Roaming
   LOCALAPPDATA=C:\Users\<user>\AppData\Local
   TEMP=C:\Users\<user>\AppData\Local\Temp
   TMP=C:\Users\<user>\AppData\Local\Temp
   ```

   Check, from `D:\agent_persona`: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File bin\keeper-probe.ps1 -OutFile D:\personas\probe.txt` writes `node.exit=0` and `claude.exit=0` to `probe.txt`.

8. Register the tasks, in an elevated window from `D:\agent_persona`. A credential dialog asks for `<user>`'s password, which the scheduler stores so each task runs as that account.

   ```powershell
   bin/Register-PersonaTasks.ps1 -Roster D:/personas/fleet.json -EnvFile D:/personas/keeper.env
   ```

9. Start the four personas:

   ```powershell
   Start-ScheduledTask AgentPersona-steward
   Start-ScheduledTask AgentPersona-architect
   Start-ScheduledTask AgentPersona-liaison
   Start-ScheduledTask AgentPersona-dev
   ```

10. In the architect's thread, post `https://github.com/<owner>/<client repo>` and say it is the repository this host's plans land in. The architect's charter clones only a remote URL the operator writes on its own channel.

Check: the channel shows four threads, `steward`, `architect`, `liaison` and `dev`. `Select-String -Path D:\personas\*\run\supervisor.out, D:\personas\*\run\supervisor.log -SimpleMatch -Pattern 'ERROR:'` prints nothing. `Select-String -Path D:\personas\steward\run\settings.json, D:\personas\liaison\run\settings.json -SimpleMatch -Pattern 'liaisonPersona'` matches in both files. `Select-String -Path D:\personas\liaison\run\child-*\stderr.log -SimpleMatch -Pattern 'has not been trusted'` prints nothing. `Select-String -Path $HOME\.claude\projects\D--personas-liaison\*.jsonl -SimpleMatch -Pattern 'You are the liaison persona'` matches the liaison's priming turn.

A persona's session transcripts sit under `$HOME\.claude\projects`, in a folder named for its working directory with every character other than a letter or digit replaced by `-`. The liaison's is `D--personas-liaison`.

### Liaison Joining Later

Where a liaison joins a fleet that is already running, the steward must restart onto a new settings file. A run directory's `settings.json` keeps the names it was first written with, and the steward builds its liaison clause only from its own.

1. Add the liaison's entry to `D:\personas\fleet.json`, and add `"liaisonPersona": "liaison"` to the steward's entry.
2. Take steps 2, 4 and 5 of the Fleet section for the liaison's folder.
3. Re-run step 8 to register the liaison's task.
4. Ask the steward in its thread to shut down. Its shutdown leaves a hold marker, so the keeper does not relaunch it before step 5. Once `Test-Path D:\personas\steward\run\keeper.hold` prints `True`, delete the steward's settings file:

   ```powershell
   Remove-Item D:\personas\steward\run\settings.json
   ```

5. Release and start the steward, then start the liaison:

   ```powershell
   D:\agent_persona\bin\Start-Persona.ps1 -Name steward -Release
   Start-ScheduledTask AgentPersona-steward
   Start-ScheduledTask AgentPersona-liaison
   ```

Check: the Fleet section's checks, run again.

## Bridge Flows

Two flows keep the client repository and Azure DevOps in step. Both run on your machine, in `<bridge folder>`.

Delivery goes upstream, carrying the client's merged `main` to Azure DevOps:

```
git fetch client main
git push ado client/main:refs/heads/<client branch>
```

Git refuses the push where it is not a fast-forward. A refusal means `<client branch>` moved on Azure DevOps since the last downstream flow, and you resolve it by hand.

Product updates go downstream, after you merge trunk into `<client branch>` on Azure DevOps:

```
git fetch ado <client branch>
git push client ado/<client branch>:refs/heads/upstream
gh pr create --repo <owner>/<client repo> --base main --head upstream --title "Product update" --body "Merges the latest product update into main."
```

The pull request merges `upstream` into `main` under the same review rule as every other. Merge it with a merge commit, never a squash or a rebase. Delivery pushes the client's `main` back to `<client branch>`, and that push fast-forwards only while `main` contains the Azure DevOps commits themselves.

## Response Gate Threshold

The gate runs at `shadow` for the first week, delivering every message at once and journalling what `live` would have done. The threshold is then chosen from that week's labelled rows. "Choosing the response gate's threshold" in `docs/operations.md` of the `discord-channels` repository owns the procedure.

1. The journal is `%LOCALAPPDATA%\sapplefeld-channels\response-gate.jsonl`. It rotates at the broker log's own size and file count, to `response-gate.jsonl.1`, `.2` and on, where a higher number is older. Where any numbered file exists, join every one of them, highest number first, and the active file last. Then use `week.jsonl` in place of `response-gate.jsonl` in steps 2 and 4. With `.1` and `.2` present, the join reads:

   ```powershell
   Set-Location $env:LOCALAPPDATA\sapplefeld-channels
   cmd /c copy /b response-gate.jsonl.2+response-gate.jsonl.1+response-gate.jsonl week.jsonl
   ```

2. From the same folder, list the rows the judge scored, each with its buffered lines:

   ```powershell
   Get-Content response-gate.jsonl | ConvertFrom-Json | Where-Object { $null -ne $_.probability } | Format-List id, probability, lines
   ```

3. Label each listed row in a labels file, one line per row: its `id`, a tab, then `yes` where the last line expected a response from the assistant and `no` where it did not.

   ```powershell
   Add-Content -Encoding ascii -Path labels.tsv -Value "<id>`tyes"
   ```

4. Score the labels, from `D:\discord-channels`:

   ```powershell
   node tools/response-gate-score.ts $env:LOCALAPPDATA\sapplefeld-channels\response-gate.jsonl $env:LOCALAPPDATA\sapplefeld-channels\labels.tsv
   ```

   It prints the count of labelled judged rows, then the precision and recall at each threshold from 0.40 to 0.95. A threshold that would deliver nothing prints `n/a`.

5. In `broker.env`, set `CHANNEL_RESPONSE_GATE_THRESHOLD` to the lowest threshold whose precision you accept, and set `CHANNEL_RESPONSE_GATE=live`. Then restart the broker with `.\install\Repair-Broker.ps1`, elevated, from `D:\discord-channels`.

## Acceptance Checklist

The first host is accepted when every item below passes. Each names what you run or read, and the outcome that fails it.

1. **Envelope carries author and class.** Post a message in the liaison's thread, then run:

   ```powershell
   Get-ChildItem $HOME\.claude\projects\D--personas-liaison\*.jsonl | Sort-Object LastWriteTime | Select-Object -Last 1 | Select-String -SimpleMatch -Pattern 'sender_class=' | Select-Object -Last 1
   ```

   It passes where the printed line's `<channel` tag carries `author=` with the name Discord shows for you in that server and `sender_class=` with `operator`. No line, or a tag missing either attribute, fails it.

2. **Brief reaches the architect.** In the liaison's thread, ask for a change to `<client repo>` that needs a plan. `Select-String -Path $HOME\.claude\projects\D--personas-architect\*.jsonl -SimpleMatch -Pattern '[WORKER:liaison id='` then matches the liaison's brief. Once the architect's own thread shows its answer, the liaison's thread carries that answer in plain words. No brief in the architect's transcript, or no relayed answer in the liaison's thread, fails it.

3. **Plan reaches the worker.** The architect reports a plan filename. Then run the command below, writing each character of `<client repo>` other than a letter or digit as `-`:

   ```powershell
   Select-String -Path $HOME\.claude\projects\D--<client repo>\*.jsonl -SimpleMatch -Pattern '<plan filename>'
   ```

   It passes where a matching line carries a `[COORDINATOR id=` record, and `Select-String -Path D:\<client repo>\.agentic-personas.json -SimpleMatch -Pattern '<plan filename>'` also matches. No coordinator record naming the plan, or a worker store without it, fails it.

4. **Token cannot merge.** The worker opens a pull request on the client repository, which `gh pr list --repo <owner>/<client repo>` shows. On the host, before anyone reviews it, `gh pr view <number> --repo <owner>/<client repo> --json mergeStateStatus,reviewDecision` prints `BLOCKED` and `REVIEW_REQUIRED`. With the ruleset's bypass list empty, no token can merge past that block. Once `<reviewer>` approves it on GitHub, the same command prints `APPROVED` for `reviewDecision`. A `mergeStateStatus` of `CLEAN` before the review fails it, and so does a review that leaves `REVIEW_REQUIRED`. Never try a merge from the host to test this. A failed block would land an unreviewed change on `main`.

5. **Memory holds nothing of the fleet.** From `D:\personas\liaison`, `memq recall` prints no record your fleet wrote, and its stderr names no refusal. `git -C $HOME\.claude remote -v` prints nothing. A fleet record, a remote, or a refusal line fails it. A refused read prints nothing and proves nothing.

6. **Shadow journal scores.** After a week at `shadow`, `(Select-String -Path $env:LOCALAPPDATA\sapplefeld-channels\response-gate.jsonl* -SimpleMatch -Pattern '"probability"').Count` is above zero. The scoring tool under "Response Gate Threshold" prints the count line and a row for each threshold from 0.40 to 0.95. No journal, no judged row, or a refusal from the tool fails it.

7. **Unlisted tool refused.** In the liaison's thread, ask it to run `node -e "require('fs').writeFileSync('probe-marker.txt','x')"` with the Bash tool and report the harness's answer. `Test-Path D:\personas\liaison\probe-marker.txt` then prints `False`, and `Select-String -Path D:\personas\liaison\run\child-*\stdout.jsonl -SimpleMatch -Pattern '"permission_denials":[{"tool_name":"Bash"'` matches. The marker file existing, or an approval prompt in the thread, fails it. A reply that declines without calling the tool proves nothing, so ask again until the call is made.
