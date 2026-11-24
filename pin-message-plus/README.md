# pin-message-plus

A Claude Code mod that keeps a **Pinned** pane beside the conversation: pin messages yourself, or let it auto-pin open PRs with their review status, decisions waiting on you, and threads you left unfinished. Step away for 5 minutes and the pane opens with a 1–2 sentence recap of where you stopped.

## Install

1. Unzip the folder anywhere, e.g. `~/mods/pin-message-plus`.
2. Add it as a local marketplace and install:
   ```
   claude plugin marketplace add ~/mods/pin-message-plus
   claude plugin install pin-message-plus@pin-message-plus
   ```
3. Restart Claude Code.

To update after changing the files: bump `version` in `.claude-plugin/plugin.json`, then run `claude plugin marketplace update pin-message-plus`, then `claude plugin update pin-message-plus@pin-message-plus`, then restart.

## Commands

| Command | What it does |
|---|---|
| `/pin` | Pins the selected text, or Claude's last response. A pin shows a short title, plus a `↩ jump` button back to the message |
| `/pin <words>` | Pins the newest message containing all the words |
| `/pin-find <words>` | Jumps to the message that best matches the words, without pinning it. Matching is fuzzy and tolerates typos. Run it again to step to the next match |
| `/pin-note <text>` | Puts your own note at the top of the pane in place of the idle recap |
| `/pin-note` | Writes the recap right now, without waiting 5 idle minutes. It replaces a note |
| `/pin-note clear` | Removes the recap or note. The `✕ clear` button on it in the pane does the same |
| `/pin-auto [on\|off]` | Turns auto-pinning on or off |
| `/pin-clear` | Clears this conversation's pins and closes the pane |
| `/pin-clear all` | Also wipes the saved pins of every conversation |

To open the pane, run any of these commands, or open it from the panes menu.

## Auto-pin (when on)

- **Open PR:** pinned when `gh pr create` runs, and unpinned once the PR is merged or closed. Several PRs can be pinned at once.
- **Review status:** reviews that run in the session are recorded on the PR pin. This covers subagents, `/code-review` and Codex. The pin shows the round count and the highest open severity, e.g. `round 2 · 🟠 highest: high · 2/5 open`.
- **Needs decision:** review findings or questions that are waiting on you.
- **Unfinished:** where topic A stopped, when you switched to topic B before A was done.

Haiku judges decisions, threads and fixed findings at the end of each turn.

## Idle recap

- **When it appears:** after 5 minutes without you writing in the chat. The pane opens with **⏸ Where you left off**, 1–2 sentences on the latest stretch of work only, not the whole conversation.
- **If Claude is still working:** the recap says what Claude is doing. It is rewritten when that turn ends.
- **Your own note:** `/pin-note <text>` replaces the recap, and the idle recap never overwrites a note.
- **When it clears:** a recap or note clears as soon as you next write in the chat.

## Persistence

Pins, the auto-pin setting and the recap/note are saved per conversation. They come back when you resume it.
