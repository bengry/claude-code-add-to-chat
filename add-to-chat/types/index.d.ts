/**
 * Where an Excerpt was selected: a reply, the person's prompt, a tool's row,
 * a notice or other row of Claude Code's own, or no single row.
 */
export type AnnotationSource = 'assistant' | 'user' | 'tool' | 'system' | 'transcript'

export type Annotation = {
  /** One-based, renumbered when one is removed. */
  index: number
  /** The Excerpt, marks stripped. */
  text: string
  source: AnnotationSource
  /** The transcript row it was selected in (`$.ui.selection()`'s `requestId`), when it lies in one. */
  requestId?: string
  comment?: string
}

/** A selection the band offers to add. */
export type Candidate = { text: string; requestId?: string }

/** The selection reported, not offered as its Excerpt is pending: as Annotation `index`. */
export type SelectionNote = { text: string; index: number }

/**
 * What a rewritten prompt row draws instead of the rendered template, the
 * Annotations it was sent with (absent for a prompt sent before 0.3.0), and
 * the reply rows (requestIds) that answered it, whose Citations may name
 * 1 to `count` alone.
 */
export type Original = { text: string; count: number; annotations?: Annotation[]; replies?: string[] }

/**
 * What the pane shows below its first row: the pending Annotations, the
 * list of sent prompts that had some, or one of them (by `hashText` of its
 * rewritten text), read-only; `requestId` is its row, when known, to jump to.
 */
export type PaneMode =
  | { kind: 'pending' }
  | { kind: 'history' }
  | { kind: 'sent'; hash: string; tab: number; requestId?: string }

declare module 'claude-code' {
  interface PluginState {
    'add-to-chat': {
      pending: Annotation[]
      candidate: Candidate | null
      /** `selectionKey` of the selection last added or ignored; outlives a submit. */
      handled: string | null
      /** What the pane's first row says of the selection reported when its Excerpt is pending, or null. */
      selectionNote: SelectionNote | null
      /** Whether the pane is open, as the poll last saw `$.ui.panes()`. */
      isPaneOpen: boolean
      /** Whether the pane is drawn (open and placed), as the poll last saw: while not, the line under the prompt counts the Annotations. */
      isPaneDrawn: boolean
      /** The index of the Annotation whose tab the pane shows. */
      paneTab: number
      /**
       * What a Comment field holds, by its Annotation's index, typed since
       * the last save: kept as the Comment when the field is left or the
       * prompt goes. No drawing reads it, so typing redraws nothing.
       */
      commentDrafts: Record<string, string>
      /**
       * Comments saved with Enter so far. The terminal empties a field on
       * Enter; the pane draws the field anew after each save, holding it.
       */
      commentSaves: number
      isDraftEmpty: boolean
      /**
       * The Annotations a prompt put back in the box (a rewind, a step
       * through the history) brought back to pending: the next prompt put
       * there takes them out again. Null once none is pending.
       */
      recalled: { annotations: Pick<Annotation, 'text' | 'requestId'>[] } | null
      /** Keyed by `hashText` of the rewritten prompt; mirrored in `$.store`. */
      originals: Record<string, Original>
      /** `hashText` of the rewritten prompts in this conversation's transcript, oldest first: what the pane's history lists. */
      sessionPrompts: string[]
      /**
       * Each reply row (requestId) known to answer a prompt of this
       * conversation → how many Annotations that prompt was sent with: the
       * Citations it may draw. Written only on a change, so reply rows,
       * which read it, redraw only then.
       */
      replyCounts: Record<string, number>
      paneMode: PaneMode
    }
  }
}
