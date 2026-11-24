export type PinKind = 'manual' | 'pr' | 'review' | 'decision' | 'thread'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type Finding = { id: string; title: string; severity: Severity; isOpen: boolean }

export type Review = {
  /** How many review rounds ran in this session. */
  rounds: number
  /** The latest round's findings. */
  findings: Finding[]
  /** The main-loop turn that recorded the latest round: reviews in the same turn are one round. */
  roundTurn?: string
}

export type Pin = {
  id: string
  kind: PinKind
  text: string
  isMarkdown: boolean
  /** The PR a 'pr' pin tracks. */
  prUrl?: string
  /** The git branch a 'pr' or 'review' pin is about. */
  branch?: string
  /** In-session code-review state of a 'pr' or 'review' pin. */
  review?: Review
  /** The transcript instance to scroll to: a message uuid or a tool_use_id. */
  anchor?: string
}

/** The note at the top of the pane: Haiku's recap after 5 idle minutes, or the person's /note. */
export type Recap = {
  text: string
  /** Written by the person with /note, not by the idle recap. */
  isNote: boolean
  /** Made while Claude was still working: remade when that turn ends. */
  isWhileRunning: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pin-message-plus': { board: Pin[]; autopin: boolean; recap: Recap | null }
  }
}
