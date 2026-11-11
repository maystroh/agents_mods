#!/usr/bin/env bash
# Installs the Linux mods into the user's Claude Code. Safe to run again.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
claude plugin marketplace add "$here" >/dev/null 2>&1 || claude plugin marketplace update benai-mods
for p in brain-dump helper-desk cache-clock handoff reflect chat-inventory screen-share replay-theater mods; do
  claude plugin install "$p@benai-mods"
done
