# mobile-mode

A Claude Code mod for working from your phone. While it is on, Claude keeps replies short, asks one question at a time, avoids content that is hard to read on a small screen, and writes so replies sound right through text-to-speech.

## Install

1. Clone this repo, e.g. into `~/mods/xtreme-claude-mods`.
2. Add the mod's folder as a local marketplace and install:
   ```
   claude plugin marketplace add ~/mods/xtreme-claude-mods/mobile-mode
   claude plugin install mobile-mode@mobile-mode
   ```
3. Restart Claude Code.

To pick up changes to the files, run `/reload-plugins`.

## Commands

| Command | What it does |
|---|---|
| `/phone on` | Turns mobile mode on and shows `📱 mobile` in the status line |
| `/phone off` | Turns it off |
| `/phone auto` | The default. On only while a phone app is attached to the session |
| `/phone` | Shows the current mode |

The mode is saved across sessions.

## What changes when it is on

- **Short:** replies are 1–5 lines, with the answer first.
- **Ping-pong:** at most one question per message. When several decisions are pending, Claude raises the most important one and says how many remain ("1 of 3").
- **One item at a time:** no full plans or long lists of findings in one message. Claude gives the first item and offers the next.
- **Screen-friendly:** no tables. Short bullets or `Label: value` lines instead, and no long code blocks, paths, URLs or wide text.
- **Speech-friendly:** plain sentences, no emoji or decorative symbols, no nested lists.

Claude still does the full work with its tools. Only the replies are trimmed.

## How it works

The rules are attached to each message you type, where only Claude reads them, and slash commands don't get them. They override other reply-format instructions, such as table rules in your CLAUDE.md. The mod doesn't change the system prompt, because some organization-managed plugins skip plugin hooks on it.
