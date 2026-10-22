# Windows changes

Patched copy of benai-mods for Windows (no bash tools, no pbcopy/open, no python3):

- `mkdir -p` calls dropped (`$.fs.write` creates folders itself)
- `rm -f` -> PowerShell `Remove-Item`
- `pbcopy` -> PowerShell `Set-Clipboard` (handoff "Copy"); hint says Ctrl+V
- `open` -> PowerShell `Start-Process` (handoff, reflect)
- `python3` -> tries `python`, `py -3`, then `python3` (cache-clock)
- Backslash paths normalised; `C:\...` paths recognised (handoff, mods, chat-inventory, helper-desk, reflect)
- `CLAUDE_CODE_PLUGIN_DIRS` split on `;` too (mods)

Needs Claude Code 2.1.287+ (CLI on PATH was 2.1.87 when patched). Not tested inside a running Claude Code.
