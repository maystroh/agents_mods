---
name: handoff
description: Prepare a compact, actionable handoff when the user wants to continue a Codex chat in a fresh session or another agent app.
---

# Handoff

Summarize the current task from the chat and workspace evidence. Include the original objective, decisions and constraints, completed work, exact files or links needed next, test results, open risks, and the first concrete next action. Separate verified facts from assumptions. Do not include secrets, credentials, or private transcript content unrelated to the task.

Prefer a native Codex fork when the user wants a new Codex chat with the same history and the available thread tool supports it. When moving to another app, create a self-contained handoff prompt in chat or a user-facing file at the requested location. Preserve Windows paths exactly. If saving a file, link it in the final answer.

Do not start a new chat, copy to the clipboard, or send a message to another chat unless the user requested that action. There is no reliable skill API for Claude's 250k-token automatic offer or progress-bar UI.
