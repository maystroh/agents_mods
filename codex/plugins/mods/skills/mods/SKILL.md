---
name: mods
description: Show which agents_mods Codex plugins are installed and enable or remove a named mod when the user asks.
---

# Mods

When the user asks what mods are available, inspect the current `agents-mods` marketplace and plugin installation state with `codex plugin list` or the available plugin management tools. Show the eight Codex counterparts, their installed state, and a one-line purpose. Do not present Claude plugins as installed in Codex.

When the user asks to turn a named mod on, install it with `codex plugin add <name>@agents-mods` if needed. When the user asks to turn it off, use the available enable/disable setting if supported; otherwise explain that `codex plugin remove <name>@agents-mods` uninstalls it and use that only when the user asked to remove or uninstall. Preserve other plugins and configuration. Check the resulting state.

This is an in-chat switchboard. Codex does not offer Claude's custom `/mods` pane or per-chat hook toggles through a skill.
