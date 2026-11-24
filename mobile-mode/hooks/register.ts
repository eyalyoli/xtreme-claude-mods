import type { Register } from 'claude-code'

type Mode = 'on' | 'off' | 'auto'

const RULES = `# Mobile mode (active)
The user is on a phone, often listening via text-to-speech. These rules override any conflicting reply-format rules (including CLAUDE.md table/numbering rules) while this note is attached:
- Keep replies short: aim for 1–5 lines. Lead with the answer.
- Ping-pong: ask at most ONE question per message, then stop and wait. If several decisions are pending, raise the most important one only and say how many remain ("1 of 3").
- Tackle one item at a time. Don't dump full plans, long lists or multiple findings in one message; give the first and offer the next.
- No tables. Use short bullets or "Label: value" lines instead. Max ~5 bullets.
- No wide content: avoid long code blocks, long paths, URLs, hashes and wide ASCII. Show only the few relevant code lines; summarize the rest in words.
- Write so it reads well aloud: plain sentences, no emoji, no decorative symbols (✅ ❌ →), spell out abbreviations where unclear, no nested lists.
- Still do the work fully with tools; only the message to the user is trimmed.`

async function getMode($: { store: { get: (k: string) => Promise<unknown> } }): Promise<Mode> {
  const v = await $.store.get('mode')
  return v === 'on' || v === 'off' ? v : 'auto'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'phone',
      description: 'Mobile mode: /phone on | off | auto (auto = on when a phone is attached)',
    })
    const mode = await getMode($)
    $.ui.status(mode === 'on' ? '📱 mobile' : undefined)
    return next(e)
  })

  on('command.run', { command: 'phone' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== 'on' && arg !== 'off' && arg !== 'auto') {
      return { text: `Mobile mode is ${await getMode($)}. Use: /phone on | off | auto` }
    }
    await $.store.set('mode', arg)
    $.ui.status(arg === 'on' ? '📱 mobile' : undefined)
    return {
      text: `Mobile mode: ${arg}.`,
      context: [`Mobile mode was set to "${arg}". ${arg === 'off' ? 'Return to the normal reply format.' : 'Follow the mobile-mode rules from now on.'}`],
    }
  })

  // Attached to each typed prompt (not the system prompt): an org mod skips plugin prompt.compose hooks.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const mode = await getMode($)
    const active =
      mode === 'on' || (mode === 'auto' && (await $.session.surfaces()).includes('mobile'))
    if (!active) return next(e)
    return next({ ...e, context: [...(e.context ?? []), RULES] })
  })
}
