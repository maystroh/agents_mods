# Codex Mods for Windows

Codex-native workflows adapted from the nine [Claude Windows mods](../claude/README.md) in this repository. The eight supported counterparts are separate Codex skill plugins, so each can be enabled or removed independently. They work in Codex CLI and the desktop app without depending on Claude's React hook runtime.

| Claude mod | Codex counterpart | Limit |
| --- | --- | --- |
| brain-dump | `$brain-dump` shapes a rough request into a four-part brief | No unsent composer replacement |
| handoff | `$handoff` writes a portable brief or uses a native Codex fork | No automatic 250k-token prompt bar |
| reflect | `$reflect` saves a user-requested correction in the right instruction file | No correction pop-up |
| chat-inventory | `$chat-inventory` reports used tools, skills, and files | Inline report, not a live pane |
| helper-desk | `$helper-desk` reports milestones and real subagent status | No persistent progress bar or cards |
| replay-theater | `$replay-theater` walks the last-turn or Git diff | Review panel or chat, not a custom theater |
| screen-share | `$screen-share` produces a redacted copy | Cannot mask the live Codex UI |
| cache-clock | No port | Codex does not expose reliable cache TTL or a background model fork to plugins |
| mods | `$mods` lists and manages plugins in chat | No custom switchboard pane or per-chat toggle |

## Install

The repository includes a Codex marketplace at `.agents/plugins/marketplace.json`. In PowerShell:

```powershell
codex plugin marketplace add maystroh/agents_mods
$mods = 'brain-dump','handoff','reflect','chat-inventory','helper-desk','replay-theater','screen-share','mods'
$mods | ForEach-Object { codex plugin add "${_}@agents-mods" }
```

Restart Codex desktop after installation. The skills are then available as `$brain-dump`, `$handoff`, `$reflect`, `$chat-inventory`, `$helper-desk`, `$replay-theater`, `$screen-share`, and `$mods`. Ask for a workflow in ordinary language to let Codex select a skill automatically.

Use `codex plugin list` and `codex plugin marketplace list` to inspect the installation. To refresh a Git-backed marketplace after a repository update, use `codex plugin marketplace upgrade agents-mods` and reinstall or update the plugin through Codex.
