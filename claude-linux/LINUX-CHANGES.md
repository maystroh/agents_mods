# Linux changes

Made from the Windows copy in `../claude` (no PowerShell on Linux):

- PowerShell `Remove-Item` -> `rm -f --` (chat-inventory, handoff, helper-desk, replay-theater)
- PowerShell `Start-Process` -> `xdg-open` (handoff, reflect)
- PowerShell `Set-Clipboard` -> `wl-copy`, then `xclip -selection clipboard`, then `xsel --clipboard --input` (handoff "Copy")
- cache-clock tries `python3`, then `python`
- handoff also picks up `/home/...` and `/root/...` paths when listing the chat's files

The `C:\` path handling and `;` splitting from the Windows copy are kept; they do no harm on Linux.
