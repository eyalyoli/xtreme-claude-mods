# xtreme-claude-mods

Mods for [Claude Code](https://claude.com/claude-code). Each folder is a separate mod and a separate local marketplace.

| Mod | What it does |
|---|---|
| [pin-message-plus](pin-message-plus/) | A Pinned pane beside the chat: pin messages, auto-pin open PRs and pending decisions, and get a recap of where you stopped after you've been idle |
| [mobile-mode](mobile-mode/) | Short, one-question-at-a-time, screen- and speech-friendly replies when you work from your phone (`/phone on\|off\|auto`) |

## Install a mod

```
git clone https://github.com/eyalyoli/xtreme-claude-mods.git ~/mods/xtreme-claude-mods
claude plugin marketplace add ~/mods/xtreme-claude-mods/<mod>
claude plugin install <mod>@<mod>
```

Then restart Claude Code. Each mod's README has its commands and details.
