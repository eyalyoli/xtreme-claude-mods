import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Finding, Pin, PinKind, Recap, Review, Severity } from '../types'

const PANE = 'pins'
const POLL_MS = 3 * 60 * 1000
const MAX_THREADS = 3
const MAX_DECISIONS = 5
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/
const REVIEW_HINT = /\breview|\baudit/i
const IDLE_MS = 5 * 60 * 1000
const IDLE_CHECK_MS = 30 * 1000

const board = atom({ plugin: 'pin-message-plus', key: 'board' } as const, [])
const autopin = atom({ plugin: 'pin-message-plus', key: 'autopin' } as const, false)
const recap = atom({ plugin: 'pin-message-plus', key: 'recap' } as const, null as Recap | null)

// Markdown takes 10000 chars and no control characters but tab and newline.
const clean = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 10000)

const oneLine = (text: string, limit = 200) => {
  const flat = clean(text).replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`
}

const LABELS: Record<PinKind, string> = {
  pr: 'Open PR',
  review: 'In review',
  decision: 'Needs decision',
  thread: 'Unfinished',
  manual: 'Pinned',
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']
const SEVERITY_ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }

const asSeverity = (value: unknown): Severity =>
  SEVERITIES.includes(value as Severity) ? (value as Severity) : 'medium'

// ReportFindings' own scale onto ours.
const fromReportSeverity = (value: string | undefined): Severity =>
  value === 'important' ? 'high' : value === 'nit' ? 'low' : 'medium'

const reviewStatus = (review: Review) => {
  const open = review.findings.filter(one => one.isOpen)
  const total = review.findings.length
  if (total === 0) return `✅ review passed · round ${review.rounds}`
  if (open.length === 0) return `✔ all ${total} fixed · round ${review.rounds} · re-review pending`
  const highest = SEVERITIES.find(level => open.some(one => one.severity === level)) ?? 'medium'
  return `round ${review.rounds} · ${SEVERITY_ICON[highest]} highest: ${highest} · ${open.length}/${total} open`
}

const CURATOR_SYSTEM = `You maintain a short "pinned" board beside a coding conversation.
You manage two kinds of pins:
- "decision": something waiting on the USER's decision (e.g. a review finding that needs a call, a question the assistant asked the user, a choice between options).
- "thread": a topic the conversation left UNFINISHED because the user switched to a different topic. Pin where topic A stopped when the user's new prompt moves to topic B before A was finished.
You also mark open code-review findings as fixed when the assistant's latest reply shows they were fixed (or deliberately dismissed).
Rules:
- Remove a decision pin once the conversation shows it was decided.
- Remove a thread pin once the conversation returns to that topic or it is finished.
- Do not pin PR openings or review results; they are tracked separately.
- Do not pin normal progress, finished work, or the current topic.
- Most turns need no change. Prefer no change over a weak pin.
- Each pin text is a short title: 3-8 words, max 60 characters, like a heading (e.g. "Decide: keep retry in sync job").
Reply with JSON only: {"add":[{"kind":"decision"|"thread","text":"..."}],"remove":["<pin id>"],"fixed":["<finding id>"]}`

const EXTRACT_SYSTEM = `You read the report of a code reviewer (a subagent, /code-review, or Codex).
Extract its findings. Severity scale: critical, high, medium, low. Map the reviewer's own words: blocker/critical -> critical; important/major/bug -> high; medium/moderate/pre-existing -> medium; minor/nit/style -> low.
Reply with JSON only: {"findings":[{"title":"<max 60 chars>","severity":"critical|high|medium|low"}]}
A clean review with nothing to fix: {"findings":[]}. If the text is not a code-review report at all: {"notReview":true}`

const jsonOf = (text: string): Record<string, unknown> | undefined => {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return undefined
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

type CuratorOps = { add: { kind: PinKind; text: string }[]; remove: string[]; fixed: string[] }

const parseOps = (text: string): CuratorOps => {
  const raw = jsonOf(text) ?? {}
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter(one => typeof one === 'string') : [])
  return {
    add: (Array.isArray(raw.add) ? raw.add : []).filter(
      one => (one?.kind === 'decision' || one?.kind === 'thread') && typeof one.text === 'string',
    ),
    remove: strings(raw.remove),
    fixed: strings(raw.fixed),
  }
}

type PrView = { number: number; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; url: string; headRefName: string }

// The prompt each main-loop turn started with; the one before it; the turn running now.
const prompts = new Map<string, string>()
let lastPrompt = ''
let currentTurn = ''
let seq = 0
// /pin-find's last query and which of its matches it showed.
let findQuery = ''
let findIndex = 0
// When the person last wrote in the chat; whether a main-loop turn is running; a recap being written.
let lastActive = 0
let isRunning = false
let isRecapping = false

// Saved per conversation in the plugin's store, so a resumed conversation gets its pins back.
const MAX_SAVED = 30
const SAVED_PREFIX = 'session:'
type Saved = { board: Pin[]; autopin: boolean; recap?: Recap | null; savedAt: number }

const save = async ($: Engine) => {
  const key = `${SAVED_PREFIX}${await $.session.id()}`
  const saved: Saved = {
    board: await read($, board),
    autopin: await read($, autopin),
    recap: await read($, recap),
    savedAt: await $.clock.now(),
  }
  await $.store.set(key, saved)
  // Keep the newest conversations only: the store holds 4 MiB in all.
  const keys = (await $.store.keys()).filter(one => one.startsWith(SAVED_PREFIX))
  if (keys.length <= MAX_SAVED) return
  const dated: { key: string; at: number }[] = []
  for (const one of keys) dated.push({ key: one, at: ((await $.store.get(one)) as Saved | undefined)?.savedAt ?? 0 })
  for (const old of dated.sort((a, b) => b.at - a.at).slice(MAX_SAVED)) await $.store.delete(old.key)
}

const restore = async ($: Engine) => {
  const saved = (await $.store.get(`${SAVED_PREFIX}${await $.session.id()}`)) as Saved | undefined
  if (!saved || (await read($, board)).length > 0) return false
  await update($, board, () => saved.board)
  await update($, autopin, () => saved.autopin)
  await update($, recap, () => saved.recap ?? null)
  return saved.board.length > 0 || Boolean(saved.recap)
}

const setBoard = async ($: Engine, change: (list: Pin[]) => Pin[]) => {
  await update($, board, change)
  await save($)
}

const setAutopin = async ($: Engine, change: (isOn: boolean) => boolean) => {
  await update($, autopin, change)
  await save($)
}

const setRecap = async ($: Engine, change: (current: Recap | null) => Recap | null) => {
  await update($, recap, change)
  await save($)
}

const RECAP_SYSTEM = `The user stepped away from this coding conversation and will read your note when they come back.
In 1-2 short sentences, say what was last being done and where it stopped, so they can pick up at once.
Cover only the latest stretch of work, not the whole conversation.
If the assistant is still working, say what it is doing right now; if it is waiting on the user, say what it is waiting for.
Reply with the recap only: no heading, no quotes.`

// The idle recap: Haiku over the newest messages. A /pin-note written meanwhile is never overwritten,
// unless the person asked for this recap (isForced). Resolves whether a recap was written.
const makeRecap = async ($: Engine, isForced = false) => {
  if (isRecapping) return false
  isRecapping = true
  try {
    const rows = await $.session.messages({ last: 20 })
    if (!Array.isArray(rows)) return false
    const lines = rows
      .filter(one => one.text.trim() !== '' && !/^\s*(\/|<command-)/.test(one.text))
      .map(one => `${one.role}: ${oneLine(one.text, 800)}`)
    if (lines.length === 0) return false
    const wasRunning = isRunning
    const reply = await $.model.complete({
      model: 'haiku',
      system: RECAP_SYSTEM,
      prompt: `Assistant status: ${wasRunning ? 'STILL WORKING (a turn is running)' : 'idle, its turn has ended'}\n\n${lines.join('\n')}`,
      maxTokens: 150,
      effort: 'low',
      timeoutMs: 15000,
    })
    if (!reply.isAnswered || !reply.text.trim()) return false
    const text = oneLine(reply.text, 400)
    await setRecap($, current => (current?.isNote && !isForced ? current : { text, isNote: false, isWhileRunning: wasRunning }))
    await showPane($)
    return true
  } finally {
    isRecapping = false
  }
}

const checkIdle = async ($: Engine) => {
  if ((await $.clock.now()) - lastActive < IDLE_MS || (await read($, recap))) return
  await makeRecap($)
}

const newId = async ($: Engine) => `${await $.clock.now()}-${seq++}`

// The newest main-conversation reply with text: what a pin made now jumps back to.
const lastReplyAnchor = async ($: Engine) => {
  const rows = await $.session.messages({ last: 30 })
  if (!Array.isArray(rows)) return undefined
  return rows.filter(one => one.role === 'assistant' && one.text.trim() !== '').at(-1)?.uuid
}

// A pin shows a title of what the text is, never the text itself; the jump button reaches the rest.
const titleOf = async ($: Engine, text: string) => {
  const reply = await $.model.complete({
    model: 'haiku',
    system:
      'Write a title (3-8 words, max 60 characters) for what this text represents, like a heading. ' +
      'Reply with the title only: no quotes, no trailing period.',
    prompt: text.slice(0, 8000),
    maxTokens: 40,
    effort: 'low',
    timeoutMs: 8000,
  })
  const title = reply.isAnswered ? oneLine(reply.text.replace(/^["'#\s]+|["'.\s]+$/g, ''), 60) : ''
  return title || oneLine(text.split('\n')[0] ?? '', 60)
}

// Rendered text (a selection) against stored markdown: compare letters and digits only.
const SEARCH_DEPTH = 2000
const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

type Row = { role: string; text: string; uuid?: string }

const findSelection = (rows: readonly Row[], selected: string) => {
  const needle = bare(selected).slice(0, 120)
  return needle === '' ? undefined : [...rows].reverse().find(one => bare(one.text).includes(needle))
}

const findWords = (rows: readonly Row[], words: string) => {
  const needles = words.toLowerCase().split(/\s+/).filter(Boolean)
  return [...rows].reverse().find(one => {
    const hay = one.text.toLowerCase()
    return needles.every(needle => hay.includes(needle))
  })
}

// Fuzzy search: a query word matches a message word it is a prefix of, sits inside, or is a typo or two away from.
const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length] ?? 0
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

const wordMatches = (needle: string, word: string) => {
  if (word.includes(needle)) return true
  const typos = needle.length >= 7 ? 2 : needle.length >= 4 ? 1 : 0
  return typos > 0 && Math.abs(word.length - needle.length) <= typos && distance(needle, word) <= typos
}

// Matching messages, best first: most query words found, then newest. Most of the words must be found.
const fuzzyFind = (rows: readonly Row[], query: string) => {
  const needles = [...new Set(wordsOf(query))]
  if (needles.length === 0) return []
  const needed = Math.max(1, Math.ceil(needles.length * 0.7))
  return rows
    .map((row, index) => {
      const words = new Set(wordsOf(row.text))
      const score = needles.filter(needle => [...words].some(word => wordMatches(needle, word))).length
      return { row, index, score }
    })
    .filter(one => one.score >= needed && one.row.uuid)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .map(one => one.row)
}

const showPane = ($: Engine) => $.ui.open({ id: PANE, title: 'Pinned' })

const viewPr = async ($: Engine, ref: string): Promise<PrView | undefined> => {
  const ran = await $.process.run(['gh', 'pr', 'view', ref, '--json', 'number,title,state,url,headRefName'], {
    timeoutMs: 20000,
  })
  if (ran.exitCode !== 0) return undefined
  try {
    return JSON.parse(ran.stdout) as PrView
  } catch {
    return undefined
  }
}

const currentBranch = async ($: Engine) => {
  const ran = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 10000 })
  return ran.exitCode === 0 ? ran.stdout.trim() : ''
}

const addPr = async ($: Engine, url: string, anchor: string) => {
  const pr = await viewPr($, url)
  const text = pr ? `[#${pr.number} ${oneLine(pr.title, 120)}](${pr.url})` : `[${url}](${url})`
  const branch = pr?.headRefName ?? (await currentBranch($))
  const id = await newId($)
  await setBoard($, list => {
    if (list.some(one => one.kind === 'pr' && one.prUrl === url)) return list
    // A review that ran before the PR existed moves onto the PR's pin.
    const before = list.find(one => one.kind === 'review' && one.branch === branch)
    const pin: Pin = { id, kind: 'pr', text, isMarkdown: true, prUrl: url, branch, review: before?.review, anchor }
    return [...list.filter(one => one !== before), pin]
  })
  await showPane($)
}

// Drops merged or closed PRs.
const pollPrs = async ($: Engine) => {
  const prPins = (await read($, board)).filter(one => one.kind === 'pr' && one.prUrl)
  for (const pin of prPins) {
    const url = pin.prUrl ?? ''
    const pr = await viewPr($, url)
    if (pr && pr.state !== 'OPEN') await setBoard($, list => list.filter(one => one.prUrl !== url))
  }
}

// Which pin a review is about: a PR the hint names, else the newest PR, else the branch's review pin.
const reviewTarget = async ($: Engine, hint: string) => {
  const list = await read($, board)
  const prs = list.filter(one => one.kind === 'pr')
  const named = prs.find(one => {
    const number = one.prUrl?.match(/\/pull\/(\d+)/)?.[1]
    return (one.prUrl && hint.includes(one.prUrl)) || (number && new RegExp(`#${number}\\b|PR ${number}\\b`, 'i').test(hint))
  })
  if (named ?? prs.at(-1)) return (named ?? prs.at(-1))!.id

  const branch = await currentBranch($)
  const existing = list.find(one => one.kind === 'review' && one.branch === branch)
  if (existing) return existing.id
  const id = await newId($)
  const pin: Pin = { id, kind: 'review', text: `Review: ${branch || 'current work'}`, isMarkdown: false, branch }
  await setBoard($, all => [...all, pin])
  return id
}

type NewFinding = { title: string; severity: Severity; isOpen?: boolean }

// One review round per main-loop turn: reviewers in the same turn merge; a verified report replaces.
const recordRound = async ($: Engine, hint: string, found: NewFinding[], mode: 'merge' | 'replace', anchor?: string) => {
  const target = await reviewTarget($, hint)
  const findings: Finding[] = []
  for (const one of found) {
    findings.push({ id: `f${await newId($)}`, title: oneLine(one.title, 60), severity: one.severity, isOpen: one.isOpen ?? true })
  }
  await setBoard($, list =>
    list.map(pin => {
      if (pin.id !== target) return pin
      const before = pin.review
      const sameRound = before !== undefined && before.roundTurn === currentTurn && currentTurn !== ''
      const review: Review = sameRound
        ? { ...before, findings: mode === 'merge' ? [...before.findings, ...findings] : findings }
        : { rounds: (before?.rounds ?? 0) + 1, findings, roundTurn: currentTurn }
      return { ...pin, review, anchor: pin.anchor ?? anchor }
    }),
  )
  await showPane($)
}

const extractFindings = async ($: Engine, report: string): Promise<NewFinding[] | undefined> => {
  const reply = await $.model.complete({
    model: 'haiku',
    system: EXTRACT_SYSTEM,
    prompt: report.slice(0, 30000),
    maxTokens: 1500,
    effort: 'low',
    timeoutMs: 20000,
  })
  const raw = reply.isAnswered ? jsonOf(reply.text) : undefined
  if (!raw || raw.notReview === true || !Array.isArray(raw.findings)) return undefined
  return raw.findings
    .filter(one => typeof one?.title === 'string')
    .map(one => ({ title: one.title as string, severity: asSeverity(one.severity) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pin',
      description: "Pin the selected text, the newest message containing <words>, or Claude's last response",
      argumentHint: '[words to find]',
    })
    await $.command.register({
      name: 'pin-find',
      description: 'Jump to the message best matching <words> (fuzzy); run again to step to the next match',
      argumentHint: '<words>',
    })
    await $.command.register({
      name: 'pin-clear',
      description: 'Remove every pin of this conversation and close the pane; "all" also wipes saved pins of every conversation',
      argumentHint: '[all]',
    })
    await $.command.register({
      name: 'pin-auto',
      description: 'Toggle auto-pinning of PRs, review status, pending decisions and unfinished threads (on | off)',
      argumentHint: '[on|off]',
    })
    await $.command.register({
      name: 'pin-note',
      description: 'Write your own note at the top of the pins pane until you next write in the chat; no text writes the recap now; "clear" removes it',
      argumentHint: '[text|clear]',
    })

    const started = await next(e)
    if (await restore($)) await showPane($)
    $.clock.every(POLL_MS, () => {
      void pollPrs($).catch(() => undefined)
    })
    lastActive = await $.clock.now()
    $.clock.every(IDLE_CHECK_MS, () => {
      void checkIdle($).catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'pin' }, async ($, e) => {
    const selected = clean((await $.ui.selection())?.text ?? '')
    const words = e.args.trim()
    const rows = await $.session.messages({ last: SEARCH_DEPTH })
    // Slash commands (this /pin among them) are rows too: never a match.
    const messages = (Array.isArray(rows) ? rows : []).filter(
      one => one.text.trim() !== '' && !(one.role === 'user' && /^\s*(\/|<command-)/.test(one.text)),
    )

    // Newest first: a selection's own message, the newest holding every word, else the last reply.
    const source = selected
      ? findSelection(messages, selected)
      : words
        ? findWords(messages, words)
        : messages.filter(one => one.role === 'assistant').at(-1)

    if (words && !selected && !source) return { text: `No message contains: ${words}` }
    const text = selected || clean(source?.text ?? '')
    if (text === '') return { text: 'Nothing to pin: no selection and no response yet.' }

    const id = await newId($)
    const title = await titleOf($, text)
    const anchor = source?.uuid ?? messages.filter(one => one.role === 'assistant').at(-1)?.uuid
    const pin: Pin = { id, kind: 'manual', text: title, isMarkdown: false, anchor }
    await setBoard($, list => (list.some(one => one.text === title) ? list : [...list, pin]))
    const opened = await showPane($)

    const what = selected
      ? source ? 'the selection' : "the selection (its message wasn't found, so jump goes to the last reply)"
      : words ? `the message matching "${words}"` : "Claude's last response"
    return {
      text: opened.isPlaced ? `Pinned ${what}: ${title}` : `Pinned, but the pane is not shown: ${opened.reason}`,
    }
  })

  on('command.run', { command: 'pin-find' }, async ($, e) => {
    const query = e.args.trim()
    if (query === '') return { text: 'Usage: /pin-find <words>' }

    const rows = await $.session.messages({ last: SEARCH_DEPTH })
    const messages = (Array.isArray(rows) ? rows : []).filter(
      one => one.text.trim() !== '' && !(one.role === 'user' && /^\s*(\/|<command-)/.test(one.text)),
    )
    const matches = fuzzyFind(messages, query)
    if (matches.length === 0) return { text: `No message matches: ${query}` }

    // The same words again step to the next match, wrapping round.
    findIndex = query.toLowerCase() === findQuery ? (findIndex + 1) % matches.length : 0
    findQuery = query.toLowerCase()
    const match = matches[findIndex]!
    const where = `match ${findIndex + 1} of ${matches.length}: ${oneLine(match.text, 80)}`
    const denied = await $.ui
      .scroll({ to: { requestId: match.uuid! }, block: 'start' })
      .then(moved => moved.deny, (error: unknown) => String(error))
    return { text: denied ? `Found ${where}, but can't jump there: ${denied}` : `↩ ${where}` }
  })

  on('command.run', { command: 'pin-clear' }, async ($, e) => {
    await setBoard($, () => [])
    await $.ui.close({ id: PANE })
    if (e.args.trim().toLowerCase() !== 'all') return { text: 'Unpinned everything in this conversation.' }

    const keys = (await $.store.keys()).filter(one => one.startsWith(SAVED_PREFIX))
    for (const one of keys) await $.store.delete(one)
    return { text: `Unpinned everything and wiped saved pins of ${keys.length} conversation(s).` }
  })

  on('command.run', { command: 'pin-auto' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, autopin))
    await setAutopin($, () => isOn)

    return {
      text: isOn
        ? 'Auto-pin on: PRs, review status, pending decisions and unfinished threads get pinned.'
        : 'Auto-pin off.',
    }
  })

  // PRs: exact, from the gh commands that ran. Codex reviews run from Bash too.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if (!(await read($, autopin))) return ran

    if (/\bgh\s+pr\s+(create|merge|close)\b/.test(e.command)) {
      const created = /\bgh\s+pr\s+create\b/.test(e.command) ? ran.text?.match(PR_URL)?.[0] : undefined
      if (created) await addPr($, created, e.tool_use_id)
      else await pollPrs($)
    } else if (/\bcodex\b[\s\S]*\breview\b/i.test(e.command) && ran.text) {
      const found = await extractFindings($, ran.text)
      if (found) await recordRound($, `${e.command}\n${ran.text.slice(0, 2000)}`, found, 'merge', e.tool_use_id)
    }

    return ran
  })

  // A review subagent's report: its findings, counted by Haiku.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !ran.text) return ran
    const about = `${e.description}\n${e.subagent_type ?? ''}\n${e.prompt.slice(0, 500)}`
    if (!REVIEW_HINT.test(about) || !(await read($, autopin))) return ran

    const found = await extractFindings($, ran.text)
    if (found) await recordRound($, `${e.description}\n${e.prompt}`, found, 'merge', e.tool_use_id)
    return ran
  })

  // /code-review's verified list: exact severities. A re-report with outcomes marks fixes.
  on('tool.call', { tool: 'ReportFindings' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !(await read($, autopin))) return ran

    const isReReport = e.findings.length > 0 && e.findings.every(one => one.outcome !== undefined)
    const found = e.findings.map(one => ({
      title: one.short_summary ?? one.summary,
      severity: fromReportSeverity(one.severity),
      isOpen: one.outcome === undefined,
    }))
    const hint = e.findings.map(one => one.file).join(' ')
    if (isReReport) {
      // Same round, now with what was fixed: replace its findings without counting a new round.
      const target = await reviewTarget($, hint)
      const findings: Finding[] = []
      for (const one of found) findings.push({ id: `f${await newId($)}`, ...one })
      await setBoard($, list =>
        list.map(pin =>
          pin.id === target && pin.review ? { ...pin, review: { ...pin.review, findings } } : pin,
        ),
      )
    } else {
      await recordRound($, hint, found, 'replace', e.tool_use_id)
    }
    return ran
  })

  on('command.run', { command: 'pin-note' }, async ($, e) => {
    const text = oneLine(e.args, 400)
    if (text.toLowerCase() === 'clear') {
      await setRecap($, () => null)
      return { text: 'Note cleared.' }
    }
    if (!text) {
      return (await makeRecap($, true))
        ? { text: 'Recap written at the top of the pins pane.' }
        : { text: "Couldn't write a recap now (no messages yet, one is already being written, or Haiku didn't answer)." }
    }
    await setRecap($, () => ({ text, isNote: true, isWhileRunning: false }))
    await showPane($)
    return { text: 'Note set: it stays at the top of the pins pane until you next write in the chat.' }
  })

  // Writing in the chat ends the recap or note, and restarts the idle clock.
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && e.command?.name !== 'pin-note') {
      lastActive = await $.clock.now()
      if (await read($, recap)) await setRecap($, () => null)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      isRunning = true
      currentTurn = e.turnId
      if (e.text.trim() !== '') prompts.set(e.turnId, e.text)
    }
    return next(e)
  })

  // Decisions, unfinished threads and fixed findings: judged by Haiku at each main-loop turn end.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const prompt = prompts.get(e.turnId)
    prompts.delete(e.turnId)

    if (!e.agentId) {
      isRunning = false
      // The recap said Claude was still working: say how it ended.
      if ((await read($, recap))?.isWhileRunning) await makeRecap($).catch(() => undefined)
    }

    if (e.agentId || e.reason !== 'answer' || !(await read($, autopin))) return result

    const list = await read($, board)
    const curated = list.filter(one => one.kind === 'decision' || one.kind === 'thread')
    const openFindings = list.flatMap(pin =>
      (pin.review?.findings ?? []).filter(one => one.isOpen).map(one => `- ${one.id} [${one.severity}] ${one.title} (${pin.text})`),
    )
    const previous = lastPrompt
    if (prompt) lastPrompt = prompt

    const reply = await $.model.complete({
      model: 'haiku',
      system: CURATOR_SYSTEM,
      prompt: [
        `Current pins (you may remove these by id):\n${curated.map(one => `- ${one.id} [${one.kind}] ${one.text}`).join('\n') || '(none)'}`,
        `Open review findings (mark fixed by id):\n${openFindings.join('\n') || '(none)'}`,
        `Previous user prompt:\n${oneLine(previous, 1500) || '(none)'}`,
        `Latest user prompt:\n${oneLine(prompt ?? '', 1500) || '(continuation)'}`,
        `Assistant's latest reply:\n${clean(e.answer).slice(0, 8000)}`,
      ].join('\n\n'),
      maxTokens: 600,
      effort: 'low',
      timeoutMs: 15000,
    })
    if (!reply.isAnswered) return result

    const ops = parseOps(reply.text)
    if (ops.add.length === 0 && ops.remove.length === 0 && ops.fixed.length === 0) return result

    const anchor = ops.add.length > 0 ? await lastReplyAnchor($) : undefined
    const added: Pin[] = []
    for (const one of ops.add) {
      added.push({ id: await newId($), kind: one.kind, text: oneLine(one.text, 60), isMarkdown: false, anchor })
    }
    await setBoard($, all => {
      const kept = [...all.filter(one => !ops.remove.includes(one.id)), ...added].map(pin =>
        pin.review
          ? {
              ...pin,
              review: {
                ...pin.review,
                findings: pin.review.findings.map(one => (ops.fixed.includes(one.id) ? { ...one, isOpen: false } : one)),
              },
            }
          : pin,
      )
      const cap = (kind: PinKind, max: number) => kept.filter(one => one.kind === kind).slice(-max)
      return [
        ...kept.filter(one => one.kind === 'pr' || one.kind === 'review' || one.kind === 'manual'),
        ...cap('decision', MAX_DECISIONS),
        ...cap('thread', MAX_THREADS),
      ]
    })
    if (added.length > 0) await showPane($)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const list = await read($, board)
    const isAutoOn = await read($, autopin)
    const note = await read($, recap)
    const kinds: PinKind[] = ['pr', 'review', 'decision', 'thread', 'manual']

    return (
      <Box flexDirection="column">
        {note && (
          <Box flexDirection="column" marginBottom={1} borderStyle="round" paddingX={1}>
            <Box flexDirection="row" gap={2}>
              <Text bold>{note.isNote ? '📝 Your note' : '⏸ Where you left off'}</Text>
              <Button key="recap:clear" plain dimColor label="✕ clear" onPress={() => setRecap($, () => null)} />
            </Box>
            <Text>{note.text}</Text>
            <Text dimColor>clears when you write in the chat</Text>
          </Box>
        )}
        {isAutoOn && <Text dimColor>auto-pin on</Text>}
        {list.length === 0 && <Text dimColor>Nothing pinned. Run /pin or /pin-auto.</Text>}
        {kinds
          .filter(kind => list.some(one => one.kind === kind))
          .map(kind => (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>{LABELS[kind]}</Text>
              {list
                .filter(one => one.kind === kind)
                .map(pin => (
                  <Box flexDirection="column">
                    <Box flexDirection="row" gap={2}>
                      {pin.anchor && (
                        <Button
                          key={`jump:${pin.id}`}
                          plain
                          dimColor
                          label="↩ jump"
                          onPress={async () => {
                            const moved = await $.ui.scroll({ to: { requestId: pin.anchor! }, block: 'start' })
                            if (moved.deny) $.ui.toast(`Can't jump there: ${moved.deny}`)
                          }}
                        />
                      )}
                      <Button
                        key={`unpin:${pin.id}`}
                        plain
                        dimColor
                        label="✕ unpin"
                        onPress={() => setBoard($, all => all.filter(one => one.id !== pin.id))}
                      />
                    </Box>
                    {pin.isMarkdown ? <Markdown text={pin.text} /> : <Text>{pin.text}</Text>}
                    {pin.review && <Text dimColor>{`  ${reviewStatus(pin.review)}`}</Text>}
                  </Box>
                ))}
            </Box>
          ))}
      </Box>
    )
  })
}
