# Task Budget

**Windows copy. Not tested on Windows yet.** On Windows, `~/.claude/` means `%USERPROFILE%\.claude\`. The copy of a handoff note uses `clip`, which can change letters outside English. Windows has no `awk`, so when the mod learns from your past chats it skips chat files over about 3.5 MB. It also cannot read the effort level from a chat file that big.

A mod for Claude Code. It tells you what a task will likely cost before Claude starts, counts the real cost live, and pauses Claude before a dollar limit is passed. It also tells you when a task fits a cheaper model or a lower effort level.

## What it does

1. **Estimates before the work starts.** A small model call (Sonnet, medium effort) reads your task and counts the work: files to read, searches, edits, helpers. Code prices that count with the real cost of your own past tasks. The question is one short line: "Likely $1.20, usually $0.60 to $2.40. Start?" The estimate card in the chat keeps the detail.
2. **Advises a model and an effort level.** A second small call reads the task beside the first one. When the task fits another model or effort level, the mod asks in one line: "Run this on Sonnet at medium: about $0.40, against $1.20 now. Switch?" Switch runs this task on that model and effort level. Your settings do not change. When the mod cannot see your effort level, the advice is a target in the start line: "Run this at medium effort."
3. **Tracks, with or without a limit.** `/budget <task>` asks how to start: "Start, no limit", "Start, limit $X" or "Not now". The suggested limit starts at 1.5 times the likely cost. It learns from your finished tasks: when they land close to the estimate, the multiple goes down (to 1.15 at the least). When they go over, it goes up (to 3 at the most). It uses tasks of the same kind when there are 10 of them, else all your tasks. `/budget 5 <task>` uses a $5 limit.
4. **Asks before the start when the limit is too low.** "Likely $2.10, over your $1.50 limit. What now?" You choose: Raise the limit, Lower the effort, Lower the model, or Stop. Each "lower" estimates again and asks again when the task is still over.
5. **Shows the course while the task runs.** The panel and the band show "On course for $X" and the chance to pass the limit. "On course for" is the spend so far plus the work that is left, plus 15% for mistakes and retries. The work that is left mixes the estimate and the real pace. Early in the task the estimate counts most. Late in the task the real pace counts most. A small model (Sonnet at low effort) reads the chat to see how much of the work is done. It reads again each time 4% of the likely cost is spent (from 8 to 25 cents), and at once when Claude starts a new step in its task list.
6. **Pauses, does not kill.** A pause holds Claude's next request. Your work stays as it is. One question at a time for the whole task: the main chat and every subagent wait on the same question. After you answer, no new money question comes until the spend rises by 10% of the limit. Each raise covers the subagents that still run, so a new limit does not trip at once.
   - At 50% of the limit, when the task is on course for 1.2 times the limit or more: Keep going, Raise the limit, Hand off to a cheaper model, or Stop. This pause comes one time for each task.
   - At 80% of the limit, when the task is on course to pass it: Raise the limit, Hand off to a cheaper model, or Stop.
   - When the next request does not fit in the money left: the same three buttons.
   - A task that is on course to finish under the limit is not paused.
7. **Hand off to a cheaper model.** Hand off stops this chat and opens the Handoff panel above the prompt box. The panel sums up the task, the files, skills and connectors used, and the work that is left. Press Start new chat there. The new chat starts with that summary as its prompt. Pick Sonnet (or Haiku) as its model. This needs the Handoff mod, which is in the same pack. Without Handoff, the mod writes a note of the work so far, copies it, and stops this chat. You then open a new chat on a cheaper model and paste the note. The note is also in `~/.claude/mods-logs/task-budget-handoff.md`.
8. **Subagents run on Sonnet or Haiku, in every chat.** While the mod is on, no subagent runs on Opus or Fable, with or without a `/budget` task. A subagent asked for on Opus or Fable runs on Sonnet. A subagent with no model asked, under an Opus or Fable chat, gets a quick pick from Haiku: "fast" work runs on Haiku, all else on Sonnet. When the pick fails, it runs on Sonnet. Sonnet and Haiku asks are kept. Its effort is capped at medium. A fork on an Opus or Fable chat is refused with "Forks are off in this chat. Start a normal subagent." The setting **Subagents on Sonnet or Haiku** (`forceHelperModel`, on by default) turns this off outside a `/budget` task. Inside a `/budget` task the cap stays, because the money check counts on it. The Model Router mod can pick a subagent model too: this mod runs after it and caps its pick. Each subagent adds its usual cost to "On course for" as soon as it starts.
9. **Stop stops everything.** The mod's Stop button, in the pop-up and in the panel, ends every running subagent (TaskStop) and the main turn. Hand off does the same. A stopped subagent gets no more tool calls and no more requests, and no new subagent can start. Only a message you type ends a stop. Messages from other sessions, Slack or task notices do not. End budget also stops the subagents before the budget closes.
   - The app's own Stop button, or Escape, stops the main turn only. Then the subagents of the `/budget` task wait: no new subagent request goes out. A message you type lets them go on. The mod's Stop in `/budget panel` ends them.
10. **Claude sees nothing.** No budget, limit or dollar amount goes to Claude. Claude does not cut corners to save money. The replies of `/budget` go to you only.
11. **Counts its own cost.** The mod's own small calls (the estimate, the advice, the reads of the chat) cost money too. The likely cost includes them. They count in the spend and against the limit. The panel has a "Mod cost" part with two lines: "This mod run cost $0.041" and "Session total, mod included $1.47". With no history, the mod's calls are about $0.04 for a $0.40 task.
12. **Learns.** Each finished task corrects the next estimate for that kind of task. It keeps the number of subagents and their model, and every question the mod asked with your answer. When you add to a running task, the mod estimates again with no pop-up. It asks one time only if the new estimate passes the limit. A miss gets a reason: more steps, fewer steps, more thinking, helpers or search. The panel shows your last 3 tasks and the line "Your last 20 estimates: 14 inside 2 times."
13. **A learning memory.** Each finished task adds one line to `~/.claude/mods-logs/task-budget-memory/runs.jsonl`. The mod then writes `INDEX.md` (one line per type of task, 200 lines at most), one file per type in `types/` (sample tasks, cost by model and effort, subagents, lessons, the last 30 runs) and `usage.md` (spend by week and model). Each estimate reads `INDEX.md` and at most 2 type files. A big task (3 or more subagents, or large for its type) shows its high end: "Likely $4, up to $45. Start?". The default limit then comes from the high end. After a miss of 2 times or more, a small call (Sonnet) writes one lesson line for that type. A new install starts from general starter figures. Your own figures take full weight after 10 tasks of a type. Types with fewer than 5 tasks are kept in `types/other.md`.

## The first run

The first time you use `/budget`, the mod asks one time: "Read your last 7 days of chats to learn how you work?" Yes makes the first estimates better and shows a short summary of your last 7 days. Not now keeps the built-in numbers. `/budget learn` runs it later.

## Commands

| Command | What it does |
| --- | --- |
| `/budget research our churned members` | Estimate first. Then you start with no limit or with a limit |
| `/budget 3 research our churned members` | Estimate first, then start with a $3 limit. The mod asks when the likely cost is over $3 |
| `/budget 3! <task>` | Start at once with $3. No estimate first |
| `/budget estimate <task>` | Estimate only, nothing starts |
| `/budget add 2` | Add $2 |
| `/budget set 8` | Set the limit to $8. Works for a task that has no limit too |
| `/budget keep` | Keep going with no limit. The count runs on |
| `/budget finish` | Claude writes one last answer and stops |
| `/budget done` | The task is done: close the budget and put the report in the chat |
| `/budget off` | End the budget |
| `/budget` | Show the money spent and left |
| `/budget panel` | Open the panel. When the task runs over, it has the same buttons as the pop-up: Raise the limit, Hand off to a cheaper model, Stop |
| `/budget report` | Show the last finished budget |
| `/budget prices` | Show what your past tasks cost |
| `/budget learn` | Read your last 7 days of chats and show how you work |
| `/budget learn all` | Read more past chats |
| `/budget learn off` | Stop reading past chats |

Removed in 0.8.0: Pace mode, Guard mode as a choice, `/budget plan`, `/budget guard`, `/budget pace`, the "Finish cheaper" button, and the panel buttons "+ $1", "+ $5", "Keep going" and "Finish now" (`/budget finish` and `/budget keep` still work). The mod now always works as Guard did: Claude sees nothing.

For tests only: `/budget try [amount] <task> [tb-test:name]` takes the estimate-first path and reads the answers from `~/.claude/mods-logs/task-budget-answers.json`. A message with no `[tb-test:...]` mark is not changed.

You can also type the budget in a normal message: `budget $3: research our churned members`.

## Your data

- The mod reads your past Claude Code chats **on your computer only**, and only after you say yes. It keeps a short summary, not the chats.
- The two small calls send the text of your task, the end of Claude's last answer in the chat (up to 2,000 characters) and up to 5 short lines of past tasks to Claude, the same service the chat uses. The estimate call also sends the memory index and up to 2 type files, which hold short snippets of your past tasks.
- In every chat, the text of a subagent's task goes to Haiku when the mod picks the subagent's model (only when no model was asked under an Opus or Fable chat).
- After a miss of 2 times or more, the task, its type, the estimate and the real cost go to Sonnet for one lesson line.
- The memory folder `task-budget-memory/` holds your task snippets on your computer. `runs.jsonl` is the true source, with a copy in `runs.jsonl.bak`. If it cannot be read, the mod never writes over it. Delete the folder to start from the starter figures.
- The reading of the chat during a task sends the task, Claude's task list and the last tool calls to Sonnet at low effort.
- The mod keeps its files in `~/.claude/mods-logs/`: `task-budget-book-3.json` (prices and past task costs), `task-budget-history.json` (your budgets, with a copy of the last good file in `task-budget-history.json.bak`), `task-budget-tasks.jsonl` (one line for each finished task: kind, skill, model, effort, estimate, real cost, time) and `task-budget-handoff.md` (the last handoff note). Delete them to start from zero.

## Limits

- Costs are at list price. On a subscription plan the dollars show the size of the work, not a bill.
- An estimate is a range with odds, not a promise. The real cost can be 2 times the likely cost or more. The range gets closer as the mod learns from your own tasks.
- Big tasks that use many helpers are often under-estimated. The pause is the guard for these.
- A model change in a chat that is already long makes the new model read the whole chat one time at the full price. That cost is in the new estimate.
- How well the small model reads "how much is done" is not measured yet.
- The advice is one small model's reading of the task. You decide.
- If the history file cannot be read, the mod uses the `.bak` copy and never writes over the file.
- If the mod fails, the chat is not blocked. The budget then does not guard that request.
- The Model Selector mod does the same advice on every prompt. Turn it off when you use this mod, or you can get two questions.
