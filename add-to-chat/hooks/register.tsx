// The engine glue: every call on `$` lives here (the engine follows `$`
// only within this file); the decisions are the pure modules beside it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, UiPane } from 'claude-code'

import type { Annotation, AnnotationSource, Candidate, Original, PaneMode, SelectionNote } from '../types'
import { added, cleared, drafted, flushed, recalledBack, removed, saved, shown, withoutRecalled } from './annotations'
import type { Pending, Recalled } from './annotations'
import { NO_REPLIES, bound, checked, drawn, ended, promptSent, settled, toCheck } from './answering'
import type { Replies } from './answering'
import { promptsIn, replyCountsOf, sameRecord, sentInBox, sentPrompts } from './history'
import { ALREADY_ADDED, NEEDS_FULLSCREEN, NOT_DRAWN, PANE_TITLE, SEND_PLACEHOLDER, addedToast } from './labels'
import { PANE_COLUMNS, PANE_ID, commentKey, ownWords, paneView } from './pane'
import { promptHint } from './prompt-hint'
import { promptRow } from './prompt-row'
import { promptRowView, replyText } from './rows'
import { SYSTEM_ROWS, TOOL_ROWS, isSelectionOf, judge, noteOf, rowSource, selectionKey } from './selection'
import type { Surroundings, Verdict } from './selection'
import { forgotten, keysToLoad, loaded, originalOf, promptHash, remembered, stored, withReplies } from './originals'
import type { Originals, StoreWrite } from './originals'
import { annotated } from './send'

const pending = atom({ plugin: 'add-to-chat', key: 'pending' } as const, [])
const candidate = atom({ plugin: 'add-to-chat', key: 'candidate' } as const, null)
const handled = atom({ plugin: 'add-to-chat', key: 'handled' } as const, null)
const selectionNote = atom({ plugin: 'add-to-chat', key: 'selectionNote' } as const, null)
const isPaneOpen = atom({ plugin: 'add-to-chat', key: 'isPaneOpen' } as const, false)
const isPaneDrawn = atom({ plugin: 'add-to-chat', key: 'isPaneDrawn' } as const, false)
const paneTab = atom({ plugin: 'add-to-chat', key: 'paneTab' } as const, 1)
const commentDrafts = atom({ plugin: 'add-to-chat', key: 'commentDrafts' } as const, {})
const commentSaves = atom({ plugin: 'add-to-chat', key: 'commentSaves' } as const, 0)
const isDraftEmpty = atom({ plugin: 'add-to-chat', key: 'isDraftEmpty' } as const, true)
const recalled = atom({ plugin: 'add-to-chat', key: 'recalled' } as const, null)
const originals = atom({ plugin: 'add-to-chat', key: 'originals' } as const, {})
const sessionPrompts = atom({ plugin: 'add-to-chat', key: 'sessionPrompts' } as const, [])
const replyCounts = atom({ plugin: 'add-to-chat', key: 'replyCounts' } as const, {})
const paneMode = atom({ plugin: 'add-to-chat', key: 'paneMode' } as const, { kind: 'pending' } as PaneMode)

const POLL_MS = 250
/** How long after the prompt box empties a submit has surely read what is pending. */
const CLEAR_GRACE_MS = 1_000

/**
 * Each transcript row's Source, by requestId.
 * Render hooks fill it and may not write state; it is a cache, not drawing
 * state: after a reload every row in view draws again and refills it, and a
 * selection in a row out of view carries no requestId anyway.
 */
const roles = new Map<string, AnnotationSource>()

function rememberRole(requestId: string | undefined, component: string, props: unknown) {
  if (requestId !== undefined && requestId !== 'placeholder') roles.set(requestId, rowSource(component, props))
}

/**
 * Each rewritten prompt row's requestId, by `hashText` of its text: where
 * the pane's history jumps to. Filled as rows draw, like `roles`; a prompt
 * not drawn since the load has none, and the pane offers no jump.
 */
const promptRows = new Map<string, string>()

/**
 * The reply rows drawn since the load and the prompt they may answer (see
 * answering.ts). Render hooks note rows here and may not write state; the
 * poll checks them once the turn has ended and keeps them with the prompt.
 */
let replies: Replies = NO_REPLIES

/**
 * Once the turn has ended, checks the rows noted since against the
 * transcript and keeps those that answer the prompt with its Original.
 */
async function keepReplies($: EngineInterface) {
  const check = toCheck(replies)
  if (check === undefined) return
  replies = check.replies
  const messages = await $.session.messages()
  const transcript = Array.isArray(messages) ? messages : []
  // Against the value now: rows noted while the transcript was read count.
  const done = checked(replies, check.hash, transcript)
  replies = done.replies
  if (done.fresh.length > 0) await editOriginals($, now => withReplies(now, check.hash, done.fresh))
  await refreshSession($, false, transcript)
}

async function surroundings($: EngineInterface): Promise<Surroundings> {
  const [prompt, list, key, mode, map, inSession] = await Promise.all([
    $.prompt.read(),
    read($, pending),
    read($, handled),
    read($, paneMode),
    read($, originals),
    read($, sessionPrompts),
  ])
  return { draft: prompt.text, pending: list, handled: key, paneWords: ownWords({ mode, pending: list, sent: sentPrompts(map, inSession) }) }
}

/** What the poll last wrote, so it writes state only on a change. */
type PollWatch = { isDraftEmpty?: boolean; isPaneOpen?: boolean; isPaneDrawn?: boolean; sessionId?: string; note?: string }

function offerKey(offer: Candidate | null): string | null {
  return offer === null ? null : selectionKey(offer)
}

/** One tick of the selection poll: what the pane offers, the draft's state, whether the pane is open. */
async function poll($: EngineInterface, watch: PollWatch) {
  // The offer before what decides it (see markHandled).
  const offered = await read($, candidate)
  const [selection, around, panes, sessionId] = await Promise.all([$.ui.selection(), surroundings($), $.ui.panes(), $.session.id()])

  // /branch, /resume and /clear go on under another session id, with
  // $.state cleared and no session.start: the originals come back from the
  // store, and the history follows the new transcript.
  if (watch.sessionId !== undefined && watch.sessionId !== sessionId) {
    replies = settled(replies)
    await refreshSession($, true)
  }
  watch.sessionId = sessionId
  await keepReplies($)

  const isEmpty = around.draft.trim() === ''
  if (watch.isDraftEmpty !== isEmpty) {
    watch.isDraftEmpty = isEmpty
    await update($, isDraftEmpty, () => isEmpty)
  }
  const isOpen = panes.some(p => p.id === PANE_ID)
  if (watch.isPaneOpen !== isOpen) {
    watch.isPaneOpen = isOpen
    await update($, isPaneOpen, () => isOpen)
  }
  const isDrawn = isPanePlaced(panes)
  if (watch.isPaneDrawn !== isDrawn) {
    watch.isPaneDrawn = isDrawn
    await update($, isPaneDrawn, () => isDrawn)
  }

  // `handled` holds only while the engine still reports that selection.
  // Once it reports none or another (a new drag, a command run, the turn's
  // end), the same text selected again is a new selection. Cleared only if
  // unchanged since read: a dismissal landing meanwhile stays.
  let decide = around
  const was = around.handled
  if (was !== null && (selection === undefined || selectionKey(selection) !== was)) {
    await update($, handled, now => (now === was ? null : now))
    decide = { ...around, handled: null }
  }

  // The pane previews the Excerpt as it will be kept, marks and 📎 gone;
  // or says why it offers nothing.
  const verdict = judge(selection, decide)
  const offer = 'key' in verdict ? verdict.excerpt : null
  if (offerKey(offer) !== offerKey(offered)) await update($, candidate, () => offer)
  const note = noteOf(verdict)
  const noteKey = JSON.stringify(note)
  if (watch.note !== noteKey) {
    watch.note = noteKey
    await update($, selectionNote, () => note)
  }
}

/** Done with a selection: it is not offered again until another is made. */
async function markHandled($: EngineInterface, key: string | undefined) {
  // `handled` before the offer goes: a poll that reads the offer gone then
  // reads the selection handled, and does not offer it again.
  if (key !== undefined) await update($, handled, () => key)
  await update($, candidate, () => null)
}

/**
 * Adds the selection as an Annotation, if it can be. `isAsked` (from
 * /add-to-chat) adds a selection last added or dismissed too: the command
 * is the person asking for it; one pending is still not added twice.
 */
async function addSelection($: EngineInterface, isAsked = false): Promise<{ annotation: Annotation } | Exclude<Verdict, { key: string }>> {
  const around = await surroundings($)
  const verdict = judge(await $.ui.selection(), isAsked ? { ...around, handled: null } : around)
  if (!('key' in verdict)) return verdict

  const { excerpt } = verdict
  const source = (excerpt.requestId !== undefined && roles.get(excerpt.requestId)) || 'transcript'
  const { now } = await editPending($, p => added(p, excerpt, source))
  const annotation = now.list.at(-1)!
  // The new tab shows, whatever the pane was showing.
  await Promise.all([markHandled($, verdict.key), update($, paneMode, () => ({ kind: 'pending' }) as const)])
  return { annotation }
}

/**
 * The offer's ✕: not this time. The engine still reports the selection,
 * so it is marked handled, or the next poll would offer it again; selected
 * again, it is offered (see the poll).
 */
async function dismissOffer($: EngineInterface) {
  const selection = await $.ui.selection()
  await markHandled($, selection === undefined ? undefined : selectionKey(selection))
}

/** Whether the pane is drawn now: open, and placed by the surface. */
function isPanePlaced(panes: readonly UiPane[]): boolean {
  return panes.some(p => p.id === PANE_ID && p.isPlaced)
}

async function removeAnnotation($: EngineInterface, index: number) {
  const [{ was }, selection, key] = await Promise.all([editPending($, p => removed(p, index)), $.ui.selection(), read($, handled)])
  const gone = was.list.find(a => a.index === index)
  // The selection it came from, still reported, can be added again: offered
  // once more, as the engine reports it until another is made.
  if (gone !== undefined && key !== null && selection !== undefined && selectionKey(selection) === key && isSelectionOf(selection, gone)) {
    await update($, handled, now => (now === key ? null : now))
  }
}

/**
 * Edits what is pending (see annotations.ts), writing only the atoms that
 * changed: every transcript row reads `pending`, so a write of it, even of
 * the same list, may redraw them all.
 */
async function editPending($: EngineInterface, edit: (p: Pending) => Pending): Promise<{ was: Pending; now: Pending }> {
  const [list, drafts, tab, back] = await Promise.all([read($, pending), read($, commentDrafts), read($, paneTab), read($, recalled)])
  const was: Pending = { list, drafts, tab, recalled: back }
  const now = edit(was)
  await Promise.all([
    now.list !== was.list && update($, pending, () => now.list),
    now.drafts !== was.drafts && update($, commentDrafts, () => now.drafts),
    now.tab !== was.tab && update($, paneTab, () => now.tab),
    now.recalled !== was.recalled && update($, recalled, () => now.recalled),
  ])
  return { was, now }
}

async function clearPending($: EngineInterface) {
  await editPending($, cleared)
}

/** Keeps what the Comment fields hold as their Comments, saved with Enter or not (see `flushed`). */
async function keepDrafts($: EngineInterface) {
  await editPending($, flushed)
}

/** A Comment saved with Enter: kept, and its field drawn anew holding it, the keyboard still in it. */
async function saveComment($: EngineInterface, index: number, value: string) {
  await editPending($, p => saved(p, index, value))
  const saves = await update($, commentSaves, n => n + 1)
  await $.ui.focus({ requestId: PANE_ID, key: commentKey(index, saves) }).catch(() => undefined)
}

/**
 * The prompt box changed by no edit (`by`: a rewind is `engine`, a step
 * through the prompt history `history`).
 *
 * Annotations that came back with a prompt are that prompt's: they are
 * pending while the box shows it. So a rewind or a step through the
 * history first takes out those the last prompt brought back (a clear
 * does too, a moment later: see the prompt.change hook). Then, a sent
 * prompt with Annotations back in the box gets what was typed in its
 * place, and its Annotations are pending again, to be edited and sent
 * anew. From the history only a prompt of this conversation brings its
 * Annotations back: another's point at rows this transcript does not hold.
 */
async function boxChanged($: EngineInterface, text: string, by: string) {
  const isHistory = by === 'history'
  if (isHistory || by === 'engine') await dropRecalled($)
  const [map, inSession] = await Promise.all([read($, originals), read($, sessionPrompts)])
  const sent = sentInBox(text, map, inSession)
  if (sent === undefined) return
  if (!isHistory || sent.isHere) {
    const { was, now } = await editPending($, p => recalledBack(p, sent.original.annotations))
    if (now.list.length > was.list.length) await update($, paneMode, () => ({ kind: 'pending' }) as const)
  }
  if (text !== sent.original.text) await $.prompt.fill({ text: sent.original.text, mode: 'replace' })
}

/**
 * Takes out of pending the Annotations the last prompt put back in the box
 * brought with it; with `only`, only if they are still those.
 */
async function dropRecalled($: EngineInterface, only?: Recalled) {
  await editPending($, p => withoutRecalled(p, only))
}

/** Opens the pane at the person's asking: placed at any width. */
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  await Promise.all([update($, isPaneOpen, () => true), update($, isPaneDrawn, () => opened.isPlaced)])
}

/** Closes the pane at the person's asking: closed until they ask for it again. */
async function hidePane($: EngineInterface) {
  await Promise.all([update($, isPaneOpen, () => false), update($, isPaneDrawn, () => false)])
  await $.ui.close({ id: PANE_ID })
}

/**
 * Reads which sent prompts are in this conversation's transcript (or in
 * `transcript`, when the caller has just read it), for the pane's history;
 * with `reload`, takes the originals from the store first.
 */
async function refreshSession($: EngineInterface, reload: boolean, transcript?: readonly SessionMessage[]) {
  const [messages, stored] = await Promise.all([transcript ?? $.session.messages(), reload ? loadOriginals($) : undefined])
  const map = stored !== undefined ? await update($, originals, now => ({ ...now, ...stored })) : await read($, originals)
  const hashes = Array.isArray(messages) ? promptsIn(messages, map) : []
  const counts = replyCountsOf(map, hashes)
  // Written only on a change: reply rows read replyCounts, and a write, even
  // of the same value, may redraw them all.
  const [shown, bounds] = await Promise.all([read($, sessionPrompts), read($, replyCounts)])
  if (shown.length !== hashes.length || shown.some((h, i) => h !== hashes[i])) await update($, sessionPrompts, () => hashes)
  if (!sameRecord(bounds, counts)) await update($, replyCounts, () => counts)
}

/**
 * Every Original in the store: 0.4.0's one map and the records of their own
 * keys, with their replies. Writes nothing, so it cannot drop what another
 * session writes meanwhile.
 */
async function loadOriginals($: EngineInterface): Promise<Originals> {
  const keys = await $.store.keys()
  const wanted = keysToLoad(keys)
  const values = await Promise.all(wanted.map(k => $.store.get(k)))
  return loaded(Object.fromEntries(wanted.map((k, i) => [k, values[i]])), keys)
}

/** Edits the Originals (see originals.ts): state, then the store's writes, in their order. */
async function editOriginals($: EngineInterface, edit: (map: Originals) => { originals: Originals; writes: StoreWrite[] }) {
  let writes: StoreWrite[] = []
  await update($, originals, now => {
    const edited = edit(now)
    writes = edited.writes
    return edited.originals
  })
  for (const w of writes) await ('set' in w ? $.store.set(w.set, w.value) : $.store.delete(w.delete))
}

/** Shows a sent prompt's Annotations in the pane, from its row's 📎. */
async function showSentPrompt($: EngineInterface, hash: string, requestId: string | undefined) {
  await Promise.all([openPane($), keepDrafts($)])
  await update($, paneMode, () => ({ kind: 'sent', hash, tab: 1, ...(requestId === undefined ? {} : { requestId }) }) as const)
}

/** Scrolls the transcript to the sent prompt the pane shows. */
async function jumpToSent($: EngineInterface) {
  const mode = await read($, paneMode)
  if (mode.kind !== 'sent') return
  const requestId = mode.requestId ?? promptRows.get(mode.hash)
  const moved =
    requestId === undefined ? { deny: 'not drawn' } : await $.ui.scroll({ to: { requestId }, block: 'center' }).catch((err: unknown) => ({ deny: String(err) }))
  if ('deny' in moved) $.ui.toast(NOT_DRAWN)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'add-to-chat',
      description: 'Add the text selected in the transcript to your next prompt',
    })
    await refreshSession($, true)
    // A reload keeps state but not the pane's drawing: clearing the offer
    // makes the first poll write it again, so the new code draws it.
    await update($, candidate, () => null)
    // A reload drops the previous load's timers and fires session.start
    // again, so this is the only interval running.
    // Empty, so its first tick sets the status line too.
    const watch: PollWatch = {}
    $.clock.every(POLL_MS, () => poll($, watch))
    return next(e)
  })

  // /clear ends the session without a new session.start: the rows the
  // pending Annotations point at are gone.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await clearPending($)
      await update($, candidate, () => null)
    }
    return next(e)
  })

  // Adds the selection if there is one to add, opening the pane; with
  // nothing to add, shows the pane or hides it.
  on('command.run', { command: 'add-to-chat' }, async ($, e) => {
    if (!e.presentation.isFullscreen) {
      $.ui.toast(NEEDS_FULLSCREEN)
      return {}
    }
    // Hidden behind another pane's tab or not placed, it is open but unseen: this asks to see it.
    const isSeen = (await $.ui.panes()).some(p => p.id === PANE_ID && p.isShown && p.isPlaced)
    if (!isSeen) await openPane($)
    const added = await addSelection($, true)
    if (isSeen && 'reason' in added && added.reason === 'nothing') {
      await hidePane($)
      return {}
    }
    if ('annotation' in added) $.ui.toast(addedToast(added.annotation.index))
    else if (added.reason === 'pending') $.ui.toast(ALREADY_ADDED)
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const { list } = (await editPending($, flushed)).now
    if (list.length === 0) {
      replies = settled(replies)
      return next(e)
    }
    const sent = annotated(e.text, list)
    const hash = promptHash(sent.text)
    // In state before the engine has it: its row draws the rewritten text
    // soon after. In the store only once sent.
    let was: Original | undefined
    await update($, originals, now => {
      was = now[hash]
      return remembered(now, hash, sent.original)
    })
    const entered = await next({ ...e, text: sent.text })
    if ('drop' in entered) {
      await update($, originals, now => forgotten(now, hash, was))
    } else {
      const keys = await $.store.keys()
      await editOriginals($, now => stored(now, hash, keys))
      await clearPending($)
      replies = promptSent(replies, hash, sent.original.count)
      await update($, sessionPrompts, now => (now.includes(hash) ? now : [...now, hash]))
    }
    return entered
  }).catch(($, e, next) => next(e))

  // A long reply's row can stay as it was drawn mid-stream, before its
  // Citations were complete; drawing the rows again once the turn ends
  // shows them.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    $.ui.invalidate('ui.render')
    // The main loop's turn ends (a subagent's carries its agentId): the
    // replies noted for it are checked and kept, and the poll keeps doing so
    // for rows drawn after.
    if (e.agentId === undefined && replies.answering !== null) {
      replies = ended(replies)
      await keepReplies($)
    } else {
      await refreshSession($, false)
    }
    return done
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    rememberRole(e.requestId, e.component, e.props)
    replies = drawn(replies, e.requestId, e.props.text)
    // Only a row with a directive reads the counts (not the originals,
    // written at every start): every reply redrawing, or drawing slower,
    // just after a launch moves the transcript under a drag about to start.
    const hasDirective = e.props.text.includes(':annotation{')
    const [list, counts] = await Promise.all([read($, pending), hasDirective ? read($, replyCounts) : {}])
    const id = e.requestId
    const text = replyText(e.props.text, id, list, bound(replies, id, counts))
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    rememberRole(e.requestId, e.component, e.props)
    if (e.props.origin.kind !== 'composer') return next(e)
    const [list, map] = await Promise.all([read($, pending), read($, originals)])
    const view = promptRowView({ text: e.props.text, requestId: e.requestId, isExpanded: e.props.isExpanded, surface: e.surface }, originalOf(map, e.props.text), list)
    if (view.kind === 'text') return view.text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text: view.text } })
    // In the terminal Claude Code draws the prompt as typed, and the mod its
    // 📎 row beneath: a button to the pane, and a card on hover.
    if (e.requestId !== undefined) promptRows.set(view.hash, e.requestId)
    const engine = await next({ ...e, props: { ...e.props, text: view.text } })
    return promptRow(
      $.ui.resolve(e),
      engine,
      { hash: view.hash, count: view.count, annotations: view.annotations, columns: e.viewport?.columns ?? 80 },
      () => showSentPrompt($, view.hash, e.requestId),
    )
  })

  // The rows nothing here draws on are seen only for their Source.
  on('ui.render', { component: [...TOOL_ROWS, ...SYSTEM_ROWS] }, async ($, e, next) => {
    rememberRole(e.requestId, e.component, e.props)
    return next(e)
  })

  // The person closing the pane (its ✕, ctrl+x x) keeps it closed until
  // they ask for it again with /add-to-chat.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)
    return next(e)
  })

  // While Annotations are pending, the line under the prompt counts them,
  // and a click shows the pane or hides it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    const list = await read($, pending)
    if (list.length === 0) return engine
    const isDrawn = await read($, isPaneDrawn)
    return promptHint($.ui.resolve(e), engine, list.length, isDrawn, () => (isDrawn ? hidePane($) : openPane($)))
  })

  // A rewind or a step through the prompt history (no edit, and not this
  // plugin's own fill): see boxChanged.
  on('prompt.change', async ($, e, next) => {
    const changed = await next(e)
    if (e.origin.kind === 'clear') {
      // An emptied box shows the prompt no more: what came back with it
      // goes. But a submit empties the box too, before its prompt.submit
      // has read pending: so a moment later, and only if they are still
      // pending as that prompt's (a submit has taken them, and forgotten).
      const last = await read($, recalled)
      if (last !== null) $.clock.after(CLEAR_GRACE_MS, () => void dropRecalled($, last))
    } else if (e.origin.kind !== 'plugin') {
      await boxChanged($, e.text, e.origin.kind)
    }
    return changed
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    // Mobile has no text field to edit a Comment in.
    if (e.surface === 'mobile') return next(e)
    const [offer, note, list, tab, saves, isEmpty, mode, map, inSession] = await Promise.all([
      read($, candidate),
      read($, selectionNote),
      read($, pending),
      read($, paneTab),
      read($, commentSaves),
      read($, isDraftEmpty),
      read($, paneMode),
      read($, originals),
      read($, sessionPrompts),
    ])
    const canJump = mode.kind === 'sent' && (mode.requestId ?? promptRows.get(mode.hash)) !== undefined
    return paneView(
      $.ui.resolve(e),
      {
        offer,
        note,
        pending: list,
        tab,
        commentSaves: saves,
        isDraftEmpty: isEmpty,
        isFullscreen: e.viewport?.isFullscreen === true,
        columns: e.props.bodyColumns,
        mode,
        sent: sentPrompts(map, inSession),
        canJump,
      },
      {
        add: async () => {
          const added = await addSelection($)
          // A click leaves the keyboard with the prompt, so this only
          // moves the ring when the pane was focused.
          if ('annotation' in added) {
            await $.ui.focus({ requestId: PANE_ID, key: commentKey(added.annotation.index, await read($, commentSaves)) }).catch(() => undefined)
          }
        },
        dismiss: () => dismissOffer($),
        show: index => editPending($, p => shown(p, index)),
        remove: index => removeAnnotation($, index),
        draft: (index, value) => update($, commentDrafts, now => drafted(now, index, value)),
        comment: (index, value) => saveComment($, index, value),
        send: () => $.prompt.fill({ text: SEND_PLACEHOLDER }),
        openHistory: async () => {
          await Promise.all([refreshSession($, false), keepDrafts($)])
          await update($, paneMode, () => ({ kind: 'history' }) as const)
        },
        openSent: hash => update($, paneMode, () => ({ kind: 'sent', hash, tab: 1 }) as const),
        showSent: index => update($, paneMode, now => (now.kind === 'sent' ? { ...now, tab: index } : now)),
        back: () => update($, paneMode, now => (now.kind === 'sent' ? { kind: 'history' } : { kind: 'pending' }) as PaneMode),
        jump: () => jumpToSent($),
      },
    )
  })
}
