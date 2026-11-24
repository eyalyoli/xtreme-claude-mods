import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pin-message-plus',
  component: 'Pane',
  requestId: 'pins',
  props: {
    title: 'Pinned',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 160 },
})

// An in-memory $.store, seeded with what an earlier run saved.
const fakeStore = (on: any, seed: Record<string, unknown> = {}) => {
  const data = new Map<string, unknown>(Object.entries(seed))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: data.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => (data.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$: unknown, e: { key: string }) => (data.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...data.keys()] }))
  return data
}

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('pins a title of the last response or selection, jumps to it, and unpins one', async ($, on) => {
  let selection: { text: string } | undefined
  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 's1' }))
  fakeStore(on)
  on('ui.selection', () => ({ value: selection }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('model.complete', (_$, e) => ({
    value: { isAnswered: true, text: e.prompt.startsWith('# The plan') ? 'Rollout plan' : 'Math note', usage },
  }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'plan it', toolUses: [], uuid: 'u1' },
      { role: 'assistant', text: '# The plan\n1. a\n2. b', toolUses: [], uuid: 'm1' },
      { role: 'assistant', text: '', toolUses: [], uuid: 'm2' },
    ],
  }))

  await $.command.run(run('pin-clear'))
  selection = undefined
  await $.command.run(run('pin'))
  await $.command.run(run('pin')) // the same title twice is one pin

  selection = { text: 'a * b * c' }
  expect((await $.command.run(run('pin'))).text).toContain('Pinned the selection')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Rollout plan' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Math note' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()

  const buttons = await ui.findAll({ type: 'Button' })
  // Transcript scrolling needs a live session; here only that each pin offers the jump.
  expect(buttons.filter(one => String(one.key).startsWith('jump:'))).toHaveLength(2)

  const unpins = buttons.filter(one => String(one.key).startsWith('unpin:'))
  expect(unpins).toHaveLength(2)
  await ui.press({ key: unpins[0]!.key! })
  expect(await ui.find({ type: 'Text', text: 'Rollout plan' })).toBeUndefined()
  await ui.unmount()
})

test('pins a created PR, unpins it once merged; curator adds and removes threads', async ($, on) => {
  const URL = 'https://github.com/acme/app/pull/42'
  let prState = 'OPEN'
  let curatorReply = '{"add":[],"remove":[]}'

  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 's1' }))
  fakeStore(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', (_$, e) =>
    e.argv[1] === 'pr'
      ? { value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ number: 42, title: 'Add flag', state: prState, url: URL, reviews: [], comments: [] }) } }
      : { value: { exitCode: 0, stderr: '', stdout: 'me\n' } },
  )
  on('model.complete', () => ({ value: { isAnswered: true, text: curatorReply, usage } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'B is…', toolUses: [], uuid: 'm9' }] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => ({ result: {}, text: e.command.includes('create') ? `Created ${URL}` : 'ok' }))

  await $.command.run(run('pin-auto', 'on'))

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title "Add flag"' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(`[#42 Add flag](${URL})`)
  expect(await ui.find({ type: 'Text', text: 'Open PR' })).toBeDefined()
  await ui.unmount()

  // User jumps to topic B while A is unfinished: the curator pins A.
  curatorReply = '{"add":[{"kind":"thread","text":"A: flag added, canary rollout next"}],"remove":[]}'
  await $.turn.start({ turnId: 't1', text: 'now explain B' })
  await $.turn.complete({ turnId: 't1', answer: 'B is…', durationMs: 1, isAborted: false, reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Unfinished' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A: flag added, canary rollout next' })).toBeDefined()
  await ui.unmount()

  // Subagent turns are ignored.
  curatorReply = '{"add":[{"kind":"decision","text":"should not appear"}],"remove":[]}'
  await $.turn.complete({ turnId: 't2', agentId: 'a1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' })

  // Merge: the PR pin goes.
  prState = 'MERGED'
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 42 --squash' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Open PR' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Needs decision' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Unfinished' })).toBeDefined()
  await ui.unmount()
})

test('review rounds: highest open severity, fixes, re-review passes, review before PR moves onto it', async ($, on) => {
  const URL = 'https://github.com/acme/app/pull/9'
  let extracted = '{"findings":[]}'
  let curator = '{"add":[],"remove":[],"fixed":[]}'
  let curatorPrompt = ''
  on('clock.now', () => ({ value: 3000 }))
  on('session.id', () => ({ value: 's1' }))
  fakeStore(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'done', toolUses: [], uuid: 'm1' }] }))
  on('process.run', (_$, e) =>
    e.argv[0] === 'git'
      ? { value: { exitCode: 0, stderr: '', stdout: 'feat/x\n' } }
      : { value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ number: 9, title: 'Feat X', state: 'OPEN', url: URL, headRefName: 'feat/x' }) } },
  )
  on('model.complete', (_$, e) => {
    if (e.system?.startsWith('You read the report')) return { value: { isAnswered: true, text: extracted, usage } }
    curatorPrompt = e.prompt
    return { value: { isAnswered: true, text: curator, usage } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => ({ result: {}, text: e.tool === 'Bash' ? `Created ${URL}` : 'report…' }))

  const status = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => String(one.props.children ?? one.text ?? ''))
    await ui.unmount()
    return texts.join(' | ')
  }

  await $.command.run(run('pin-auto', 'on'))

  // Round 1, before any PR: a review pin for the branch. Two reviewers in one turn merge.
  await $.turn.start({ turnId: 't1', text: 'review it with a subagent' })
  extracted = '{"findings":[{"title":"Race in cache","severity":"high"},{"title":"Naming","severity":"low"}]}'
  await $.tool.call({ tool: 'Agent', description: 'Code review', prompt: 'review the diff' })
  extracted = '{"findings":[{"title":"SQL injection","severity":"critical"}]}'
  await $.tool.call({ tool: 'Agent', description: 'Security review', prompt: 'review security' })
  expect(await status()).toContain('In review')
  expect(await status()).toContain('round 1 · 🔴 highest: critical · 3/3 open')

  // The PR is created: the review moves onto its pin.
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  let shown = await status()
  expect(shown).toContain('Open PR')
  expect(shown).not.toContain('In review')
  expect(shown).toContain('round 1 · 🔴 highest: critical')

  // Fixes land: the curator marks the critical one fixed.
  await $.turn.complete({ turnId: 't1', answer: 'found 3', durationMs: 1, isAborted: false, reason: 'answer' })
  const id = curatorPrompt.match(/- (f\S+) \[critical\]/)?.[1]
  expect(id).toBeDefined()
  curator = `{"add":[],"remove":[],"fixed":["${id}"]}`
  await $.turn.start({ turnId: 't2', text: 'fix them' })
  await $.turn.complete({ turnId: 't2', answer: 'fixed the injection', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(await status()).toContain('round 1 · 🟠 highest: high · 2/3 open')

  // Round 2 via /code-review's ReportFindings, then its re-report with outcomes.
  curator = '{"add":[],"remove":[],"fixed":[]}'
  await $.turn.start({ turnId: 't3', text: 'review again' })
  const f = { file: 'a.ts', summary: 'Off by one', failure_scenario: 'x', severity: 'nit' as const }
  await $.tool.call({ tool: 'ReportFindings', findings: [f] })
  expect(await status()).toContain('round 2 · ⚪ highest: low · 1/1 open')
  await $.tool.call({ tool: 'ReportFindings', findings: [{ ...f, outcome: 'fixed' as const }] })
  expect(await status()).toContain('✔ all 1 fixed · round 2')

  // Round 3 comes back clean.
  await $.turn.start({ turnId: 't4', text: 'final review' })
  extracted = '{"findings":[]}'
  await $.tool.call({ tool: 'Agent', description: 'Code review', prompt: 'review the diff #9' })
  expect(await status()).toContain('✅ review passed · round 3')
})

test('a resumed conversation gets its saved pins and auto-pin back; /pin-clear all wipes every saved board', async ($, on) => {
  const saved = {
    board: [{ id: 'p1', kind: 'thread', text: 'A: canary step next', isMarkdown: false }],
    autopin: true,
    savedAt: 1,
  }
  const data = fakeStore(on, { 'session:s1': saved, 'session:other': saved })
  on('clock.now', () => ({ value: 5000 }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'A: canary step next' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'auto-pin on' })).toBeDefined()
  await ui.unmount()

  expect((await $.command.run(run('pin-clear', 'all'))).text).toContain('2 conversation(s)')
  expect([...data.keys()]).toEqual([])
})

test('/pin <words> and a selection both pin, and jump to, the exact older message', async ($, on) => {
  let selection: { text: string } | undefined
  on('clock.now', () => ({ value: 7000 }))
  on('session.id', () => ({ value: 's1' }))
  const data = fakeStore(on)
  on('ui.selection', () => ({ value: selection }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.complete', (_$, e) => ({ value: { isAnswered: true, text: `T:${e.prompt.slice(0, 12)}`, usage } }))
  on('session.messages', () => ({
    value: [
      { role: 'assistant', text: 'The **canary rollout** goes to 5% first.', toolUses: [], uuid: 'old' },
      { role: 'assistant', text: 'Unrelated later reply.', toolUses: [], uuid: 'new' },
      { role: 'user', text: '/pin canary rollout', toolUses: [], uuid: 'cmd' },
    ],
  }))
  on('ui.scroll', () => ({ value: {} }))

  const found = await $.command.run(run('pin', 'canary rollout'))
  expect(found.text).toContain('the message matching "canary rollout"')
  expect((await $.command.run(run('pin', 'no such words'))).text).toBe('No message contains: no such words')

  // Rendered selection (no ** marks) still finds its markdown source.
  selection = { text: 'canary rollout goes to 5%' }
  await $.command.run(run('pin'))

  // What was saved for this conversation is the board as it stands.
  const board = (data.get('session:s1') as { board: { anchor?: string }[] }).board
  expect(board.map(one => one.anchor)).toEqual(['old', 'old'])
})

test('/pin-find is fuzzy, ranks best match first and steps through matches', async ($, on) => {
  on('session.messages', () => ({
    value: [
      { role: 'assistant', text: 'We set up the canary deployment yesterday.', toolUses: [], uuid: 'a' },
      { role: 'user', text: 'what about the rollout plan?', toolUses: [], uuid: 'b' },
      { role: 'assistant', text: 'Canary rollout: 5% then 50%.', toolUses: [], uuid: 'c' },
      { role: 'user', text: '/pin-find canary rolout', toolUses: [], uuid: 'cmd' },
    ],
  }))

  // "rolout" is a typo; with two words both must match, so only c.
  expect((await $.command.run(run('pin-find', 'canary rolout'))).text).toContain('match 1 of 1: Canary rollout')

  // "canery": one typo. Newest first, then stepping on, then wrapping round.
  expect((await $.command.run(run('pin-find', 'canery'))).text).toContain('match 1 of 2: Canary rollout')
  expect((await $.command.run(run('pin-find', 'canery'))).text).toContain('match 2 of 2: We set up the canary')
  expect((await $.command.run(run('pin-find', 'canery'))).text).toContain('match 1 of 2')

  expect((await $.command.run(run('pin-find', 'kubernetes'))).text).toBe('No message matches: kubernetes')
})

test('after 5 idle minutes a recap tops the pane, remade when the running turn ends; /pin-note overrides; writing clears', async ($, on) => {
  let now = 0
  let ticks: (() => void)[] = []
  const prompts: string[] = []
  fakeStore(on)
  on('clock.now', () => ({ value: now }))
  // The idle check fires only when the test says so; other timers never fire.
  on('clock.every', (_$, e) =>
    e.ms === 30000 ? new Promise(resolve => ticks.push(() => resolve({ value: undefined }))) : new Promise(() => undefined),
  )
  on('session.id', () => ({ value: 's1' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'run the migration', toolUses: [], uuid: 'u1' },
      { role: 'assistant', text: 'Running the migration now', toolUses: [], uuid: 'm1' },
    ],
  }))
  on('model.complete', (_$, e) => {
    prompts.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: e.prompt.includes('STILL WORKING') ? 'Claude is still running the migration.' : 'The migration finished; next is the backfill.',
        usage,
      },
    }
  })
  const tick = async () => {
    const pending = ticks
    ticks = []
    pending.forEach(fire => fire())
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const text = async (value: string) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text: value })
    await ui.unmount()
    return found
  }

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'run the migration' })

  now = 4 * 60 * 1000
  await tick()
  expect(prompts).toHaveLength(0) // not idle long enough

  now = 6 * 60 * 1000
  await tick()
  expect(await text('Claude is still running the migration.')).toBeDefined()
  expect(await text('⏸ Where you left off')).toBeDefined()

  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(await text('The migration finished; next is the backfill.')).toBeDefined()

  expect((await $.command.run(run('pin-note', 'check prod logs before backfill'))).text).toContain('Note set')
  expect(await text('📝 Your note')).toBeDefined()
  now = 20 * 60 * 1000
  await tick()
  expect(await text('check prod logs before backfill')).toBeDefined() // the idle recap leaves a note alone

  // /pin-note with no text writes the recap now, over the note; "clear" removes it.
  expect((await $.command.run(run('pin-note'))).text).toContain('Recap written')
  expect(await text('The migration finished; next is the backfill.')).toBeDefined()
  expect((await $.command.run(run('pin-note', 'clear'))).text).toBe('Note cleared.')
  expect(await text('⏸ Where you left off')).toBeUndefined()

  // The ✕ clear button removes it too.
  await $.command.run(run('pin-note', 'a note to clear'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recap:clear' })
  expect(await ui.find({ type: 'Text', text: 'a note to clear' })).toBeUndefined()
  await ui.unmount()

  await $.command.run(run('pin-note', 'check prod logs before backfill'))
  await $.prompt.submit({ text: 'ok go' })
  expect(await text('check prod logs before backfill')).toBeUndefined()
})
