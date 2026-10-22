---
name: replay-theater
description: Review edits made in the previous Codex turn or a selected Git revision, file by file.
---

# Replay theater

When the user asks to replay edits, first identify the requested scope: last turn, unstaged/staged changes, or a Git revision. Use Codex's review panel when available; otherwise inspect the corresponding diff and walk through each changed file in order. Explain what changed and why, with file links and a small relevant excerpt only when useful.

Do not claim a historical sequence of individual edits from a final diff. If the last-turn boundary is unavailable, say which diff was used. Do not alter files as part of replay unless the user also asks for fixes.
