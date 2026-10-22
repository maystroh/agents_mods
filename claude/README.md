# Claude Code mods: Windows version

These mods are a Windows version of the mods proposed in this video: https://www.youtube.com/watch?v=bTqizdva04g

The original set (nine mods: brain-dump, helper-desk, cache-clock, handoff, reflect, chat-inventory, screen-share, replay-theater, mods) assumes macOS. This copy changes the Mac-only parts so they run on Windows. The changes are listed in [WINDOWS-CHANGES.md](WINDOWS-CHANGES.md); the original README is kept as [README-original.md](README-original.md).

`replay-theater` is Anthropic's sample mod, shared under Apache 2.0 (see `plugins/replay-theater/LICENSE`).

## Status

Patched and reviewed, loaded into a Claude Code session on Windows. Not fully tested: `claude plugin validate` and the mods' own tests were not run (they need Claude Code 2.1.287+), and the tests still expect the old Mac commands.

## Install

Needs Claude Code 2.1.287+ and Python 3 (`python` or `py`) for cache-clock. In a Claude Code chat, with the path of this `claude` folder:

```
/plugin marketplace add C:\path\to\agents_mods\claude
/plugin install brain-dump@benai-mods
/plugin install helper-desk@benai-mods
/plugin install cache-clock@benai-mods
/plugin install handoff@benai-mods
/plugin install reflect@benai-mods
/plugin install chat-inventory@benai-mods
/plugin install screen-share@benai-mods
/plugin install replay-theater@benai-mods
/plugin install mods@benai-mods
/reload-plugins
```

Known limit: handoff's "start new chat" puts the whole handoff in a `claude://` link, which can exceed the Windows command-line limit for very long handoffs. Use Copy then.
