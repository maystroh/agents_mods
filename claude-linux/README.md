# Claude Code mods: Linux version

Linux copy of the Windows mods in [`../claude`](../claude/README.md). The changes are in [LINUX-CHANGES.md](LINUX-CHANGES.md); the original README is kept as [README-original.md](README-original.md).

## Status

All nine mods install and load in Claude Code 2.1.309 on Linux (checked with `claude plugin validate` and a `--debug` run: every hooks module loaded, no errors). Their panes, bars and buttons were not seen on screen, because that check ran in a cloud session with no terminal.

## Install

Needs Claude Code 2.1.287+ and `python3` (cache-clock). Optional: `xdg-open` (Open file), `wl-copy`, `xclip` or `xsel` (handoff Copy).

```
./install.sh
```

or in a Claude Code chat:

```
/plugin marketplace add /path/to/agents_mods/claude-linux
/plugin install brain-dump@benai-mods
... (same list as install.sh)
/reload-plugins
```

## Claude Code on the web and project threads

These mods draw on Claude Code's terminal screen (side panes, bars above the prompt, buttons, slash commands). A cloud session on claude.ai has no terminal you can see, so they load but you will not see them there. To install them in every new cloud session anyway, put this in the environment's setup script:

```
[ -d /tmp/agents_mods ] || git clone --depth 1 https://github.com/maystroh/agents_mods /tmp/agents_mods; /tmp/agents_mods/claude-linux/install.sh
```
