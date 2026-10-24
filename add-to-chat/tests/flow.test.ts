import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { hashText } from '../hooks/hash'
import { originalKey, replyKey } from '../hooks/originals'
import { NOT_DRAWN } from '../hooks/labels'
import { renderTemplate } from '../hooks/template'
import { addText, changeBox, clearBox, drawBand, drawRow, endTurn, mountHint, mountPane, mountPrompt, runCommand, start, storedOriginals, submit, tick } from './world'

const SURFACES = ['terminal', 'desktop'] as const

type Mounted = Awaited<ReturnType<typeof mountPane<'terminal'>>>

type Sent = { index: number; text: string; source: { role: string; requestId?: string }; annotation?: string }

/** The Annotations a prompt rendered by the template gives the model, read back from its XML. */
function sentAnnotations(prompt: string): Sent[] {
  const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const item = /<annotation index="(\d+)" source="(\w+)"(?: requestId="([^"]*)")?>\n<excerpt>([\s\S]*?)<\/excerpt>(?:\n<comment>([\s\S]*?)<\/comment>)?\n<\/annotation>/g
  return [...prompt.matchAll(item)].map(m => ({
    index: Number(m[1]),
    text: unescape(m[4]!),
    source: { role: m[2]!, ...(m[3] === undefined ? {} : { requestId: unescape(m[3]) }) },
    ...(m[5] === undefined ? {} : { annotation: unescape(m[5]) }),
  }))
}

/** Sends a prompt and resolves the Annotations the model was given. */
async function submitted($: Engine, w: Awaited<ReturnType<typeof start>>): Promise<Sent[]> {
  await submit($, 'q')
  return sentAnnotations(w.submitted.at(-1)!.text)
}

/** Everything a mounted pane shows, with tab `index` open (the current one if omitted). */
async function shown(pane: Mounted, index?: number): Promise<string> {
  if (index !== undefined) await pane.press({ key: `show-${index}` })
  const buttons = (await pane.findAll({ type: 'Button' })).map(b => b.text).join(' ')
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  return `${buttons}\n${text}`
}

/** Everything the pane shows, mounted for the look. */
async function paneText($: Engine, index?: number): Promise<string> {
  const pane = await mountPane($)
  const text = await shown(pane, index)
  await pane.unmount()
  return text
}

/** How many tabs a mounted pane has: the pending Annotations. */
async function tabsOf(pane: Mounted): Promise<number> {
  return (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('show-')).length
}

/** How many tabs the pane has, mounted for the count. */
async function tabCount($: Engine): Promise<number> {
  const pane = await mountPane($)
  const tabs = await tabsOf(pane)
  await pane.unmount()
  return tabs
}

/** The open tab's Comment field: its key (a new one after each save) and the text it is drawn with. */
async function commentField(pane: { findAll: (query: { type: string }) => Promise<{ key: string | undefined; props: Record<string, unknown> }[]> }): Promise<{ key: string; value: unknown }> {
  const field = (await pane.findAll({ type: 'Input' }))[0]!
  return { key: field.key!, value: field.props.value }
}

/** Writes a Comment in the pane's field for Annotation `index`: saved with Enter, or with `kind: 'change'` only typed. */
async function commentInPane($: Engine, index: number, text: string, kind: 'submit' | 'change' = 'submit') {
  const pane = await mountPane($)
  await pane.press({ key: `show-${index}` })
  await pane.input({ key: (await commentField(pane)).key, text, kind })
  await pane.unmount()
}

const REPLY = 'Run `npm test` before you **commit the change**.'

describe('the pane', () => {
  for (const surface of SURFACES) {
    test(`a hint, then the offer, then Add to chat makes a tab (${surface})`, async ($, on) => {
      const w = await start($, on)
      await drawRow($, w, 'AssistantMessage', 'r1', REPLY)
      const pane = await mountPane($, surface)
      expect(await pane.find({ key: 'add' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: /Select text in the transcript/ })).toBeDefined()

      w.selection = { text: 'npm test before you commit', requestId: 'r1' }
      await tick(w)
      expect(await pane.find({ type: 'Text', text: /npm test before you commit/ })).toBeDefined()

      await pane.press({ key: 'add' })
      expect(await pane.find({ key: 'add' })).toBeUndefined()
      expect(await pane.find({ key: 'show-1' })).toBeDefined()
      const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')
      expect(text).toContain('npm test before you commit')
      expect(text).toContain("from Claude's reply")

      await pane.input({ key: (await commentField(pane)).key, text: 'is this needed?' })
      expect((await submitted($, w))[0]!.annotation).toBe('is this needed?')

      // The same selection keeps being returned; it is not offered again.
      await tick(w)
      expect(await pane.find({ key: 'add' })).toBeUndefined()
      await pane.unmount()
    })
  }

  test('the offer keeps to one row, cut to the pane\'s width', async ($, on) => {
    const w = await start($, on)
    w.selection = { text: 'a phrase long enough to need far more room than a narrow pane has to give it', requestId: 'r1' }
    await tick(w)
    const pane = await mountPane($, 'terminal', 36)
    const offer = (await pane.find({ key: 'offer' }))?.text ?? ''
    expect(offer).toContain('…”')
    expect(offer).toContain('✕')
  })

  test('one tab per Annotation, the last added open; closing a tab removes it and renumbers the rest', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'UserMessage', 'u1', 'my earlier idea about caching')
    await addText($, w, 'a long excerpt that the pane shows whole, every word of it, never cut', 'r1')
    await addText($, w, 'earlier idea', 'u1')
    await addText($, w, 'third', 'r1')
    const pane = await mountPane($)
    expect(await shown(pane)).toContain('\nthird')
    const first = await shown(pane, 1)
    expect(first).toContain('every word of it, never cut')
    expect(first).toContain('① from the transcript')
    expect(await shown(pane, 2)).toContain('from your prompt')
    await pane.press({ key: 'close-1' })
    expect(await shown(pane, 1)).toContain('\nearlier idea')
    expect(await shown(pane, 2)).toContain('\nthird')
    expect(await pane.find({ key: 'show-3' })).toBeUndefined()
  })

  test('the first nine tabs answer to their digit; the tenth carries its number', async ($, on) => {
    const w = await start($, on)
    for (let i = 1; i <= 10; i += 1) await addText($, w, `excerpt ${i}`, `r${i}`)
    const pane = await mountPane($)
    expect((await pane.find({ key: 'show-1' }))?.props).toMatchObject({ hotkey: '1', label: 'Transcript' })
    expect((await pane.find({ key: 'show-9' }))?.props).toMatchObject({ hotkey: '9' })
    const tenth = await pane.find({ key: 'show-10' })
    expect(tenth?.props.hotkey).toBeUndefined()
    expect(tenth?.text).toBe('10: Transcript')
  })

  for (const surface of SURFACES) {
    test(`while Annotations are pending, the line under the prompt counts them and shows or hides the pane (${surface})`, async ($, on) => {
      const w = await start($, on)
      await addText($, w, 'one', 'r1')
      await addText($, w, 'two', 'r1')
      await tick(w)
      const hint = await mountHint($, surface)
      expect((await hint.find({ key: 'hint-clip' }))?.text).toBe('📎 2 annotations · hide pane')
      await hint.press({ key: 'hint-clip' })
      expect(w.panes.has('add-to-chat')).toBe(false)
      expect((await hint.find({ key: 'hint-clip' }))?.text).toBe('📎 2 annotations · show pane')
      // Hidden from here, it stays hidden: the band does not open it.
      await drawBand($)
      expect(w.panes.has('add-to-chat')).toBe(false)
      await hint.press({ key: 'hint-clip' })
      expect(w.panes.has('add-to-chat')).toBe(true)
      expect((await hint.find({ key: 'hint-clip' }))?.text).toBe('📎 2 annotations · hide pane')
      await hint.unmount()
    })
  }

  test('the line under the prompt says nothing with nothing pending', async ($, on) => {
    const w = await start($, on)
    w.panes.delete('add-to-chat')
    await tick(w)
    const hint = await mountHint($)
    expect(await hint.find({ key: 'hint-clip' })).toBeUndefined()
  })

  test("Enter saves the Comment and draws its field anew holding it, Enter again too (the terminal empties a field on Enter)", async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'one', 'r1')
    const pane = await mountPane($)
    const first = await commentField(pane)
    await pane.input({ key: first.key, text: 'why?' })
    const second = await commentField(pane)
    expect(second.key).not.toBe(first.key)
    expect(second.value).toBe('why?')
    await pane.input({ key: second.key, text: 'why?' })
    const third = await commentField(pane)
    expect(third.key).not.toBe(second.key)
    expect(third.value).toBe('why?')
    expect((await submitted($, w))[0]!.annotation).toBe('why?')
  })

  test('a Comment typed and not saved goes with the prompt, and is kept with it', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'one', 'r1')
    await commentInPane($, 1, 'typed, never saved', 'change')
    const sent = await submitted($, w)
    expect(sent[0]!.annotation).toBe('typed, never saved')
    const kept = Object.values(storedOriginals(w))
    expect(kept[0]!.annotations?.[0]?.comment).toBe('typed, never saved')
  })

  test('a Comment field left for another tab keeps what it holds; one emptied drops the Comment', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'one', 'r1')
    await addText($, w, 'two', 'r1')
    await commentInPane($, 1, 'saved')
    const pane = await mountPane($)
    await pane.press({ key: 'show-2' })
    await pane.input({ key: (await commentField(pane)).key, text: 'typed in two', kind: 'change' })
    await pane.press({ key: 'show-1' })
    await pane.input({ key: (await commentField(pane)).key, text: '', kind: 'change' })
    await pane.press({ key: 'show-2' })
    expect((await commentField(pane)).value).toBe('typed in two')
    await pane.unmount()
    expect((await submitted($, w)).map(a => a.annotation)).toEqual([undefined, 'typed in two'])
  })

  test('the pane stays open with nothing pending, and says so', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'one', 'r1')
    const pane = await mountPane($)
    await pane.press({ key: 'close-1' })
    expect(await shown(pane)).toContain('Nothing added yet.')
  })

  test('the pane does not open by itself: drawing the band leaves it closed', async ($, on) => {
    const w = await start($, on)
    await drawBand($)
    expect(w.panes.has('add-to-chat')).toBe(false)
    // The band itself is Claude Code's: add-to-chat draws nothing there.
    expect(w.drawnProps.band).toBeDefined()
  })

  test('/add-to-chat with nothing selected hides a pane in sight and shows it again', async ($, on) => {
    const w = await start($, on)
    await runCommand($, w)
    expect(w.panes.has('add-to-chat')).toBe(true)
    await runCommand($, w)
    expect(w.panes.has('add-to-chat')).toBe(false)
    await runCommand($, w)
    expect(w.panes.has('add-to-chat')).toBe(true)
  })

  test('/add-to-chat opens the pane, and adds the selection when there is one', async ($, on) => {
    const w = await start($, on)
    await runCommand($, w)
    expect(w.panes.has('add-to-chat')).toBe(true)
    expect(w.toasts).toEqual([])
    await addText($, w, 'npm test', 'r1')
    expect(w.toasts.at(-1)).toMatch(/Added ①/)
  })

  test('/add-to-chat outside fullscreen says fullscreen is needed and opens nothing', async ($, on) => {
    const w = await start($, on)
    w.isFullscreen = false
    const ran = await runCommand($, w)
    expect(ran.text).toBeUndefined()
    expect(w.toasts.at(-1)).toMatch(/fullscreen/)
    expect(w.panes.has('add-to-chat')).toBe(false)
  })

  for (const surface of SURFACES) {
    test(`with an empty draft, Send fills the prompt (${surface})`, async ($, on) => {
      const w = await start($, on)
      await addText($, w, 'npm test', 'r1')
      await tick(w)
      const pane = await mountPane($, surface)
      await pane.press({ key: 'send' })
      expect(w.fills).toEqual(['(see annotations)'])
      await tick(w)
      expect(await pane.find({ key: 'send' })).toBeUndefined()
    })
  }

  test("the offer's ✕ takes it away until another selection", async ($, on) => {
    const w = await start($, on)
    const pane = await mountPane($)
    w.selection = { text: 'not this', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'dismiss' })
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeUndefined()
    w.selection = { text: 'this one', requestId: 'r1' }
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeDefined()
  })

  test("closing an Annotation's tab offers its selection again, still reported, to be added again", async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'AssistantMessage', 'r1', REPLY)
    const pane = await mountPane($)
    w.selection = { text: 'npm test before you commit', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'add' })
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeUndefined()
    await pane.press({ key: 'close-1' })
    await tick(w)
    await pane.press({ key: 'add' })
    expect(await tabsOf(pane)).toBe(1)
  })

  test('the first row says a selection is added, as ①; dismissed, it goes back to the hint', async ($, on) => {
    const w = await start($, on)
    const pane = await mountPane($)
    // With nothing offered, the first row is a lone Text, the pane's first.
    const firstRow = async () => (await pane.findAll({ type: 'Text' }))[0]?.text ?? ''
    w.selection = { text: 'npm test', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'add' })
    await tick(w)
    expect(await firstRow()).toBe('“npm test” added as ①')
    w.selection = { text: 'not this', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'dismiss' })
    await tick(w)
    expect(await firstRow()).toContain('Select text in the transcript')
    w.selection = undefined
    await tick(w)
    expect(await firstRow()).toContain('Select text in the transcript')
  })

  test('/add-to-chat adds a selection whose offer was dismissed; one pending it still does not add twice', async ($, on) => {
    const w = await start($, on)
    const pane = await mountPane($)
    w.selection = { text: 'not this', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'dismiss' })
    await runCommand($, w)
    expect(w.toasts.at(-1)).toBe('Added ①: a Comment can go with it in the pane')
    expect(await tabsOf(pane)).toBe(1)
    await runCommand($, w)
    expect(w.toasts.at(-1)).toMatch(/already added/)
    expect(await tabsOf(pane)).toBe(1)
  })

  test('closing a tab leaves a dismissed offer dismissed', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'one', 'r1')
    const pane = await mountPane($)
    w.selection = { text: 'not this', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'dismiss' })
    await pane.press({ key: 'close-1' })
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeUndefined()
  })

  test('once the selection is gone (a command, the turn ended), the same text selected again is offered', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'AssistantMessage', 'r1', REPLY)
    const pane = await mountPane($)
    w.selection = { text: 'npm test before you commit', requestId: 'r1' }
    await tick(w)
    await pane.press({ key: 'add' })
    await submit($, 'q')
    // Until the turn ends the selection is still reported: not offered.
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeUndefined()
    w.selection = undefined
    await tick(w)
    w.selection = { text: 'npm test before you commit', requestId: 'r1' }
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeDefined()
  })
})

describe('adding a selection', () => {
  test('a prompt row is Source user, a tool row tool, a notification system; outside any row, transcript', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'UserMessage', 'u1', 'my earlier idea about caching')
    await drawRow($, w, 'UserMessage', 'n1', 'Background command finished', { origin: { kind: 'task-notification' } })
    await $.ui.render({ component: 'ToolUse', requestId: 'toolu_1', surface: 'terminal', props: {} } as never)
    await addText($, w, 'earlier idea', 'u1')
    await addText($, w, 'Bash(ls)', 'toolu_1')
    await addText($, w, 'command finished', 'n1')
    await addText($, w, 'Bash(ls)\n  a.txt')
    expect((await submitted($, w)).map(a => a.source.role)).toEqual(['user', 'tool', 'system', 'transcript'])
  })

  test('an Excerpt already pending is not offered or added again', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'npm test', 'r1')
    await addText($, w, 'something else', 'r1')
    w.selection = { text: 'npm test', requestId: 'r1' }
    await tick(w)
    const pane = await mountPane($)
    expect(await pane.find({ key: 'add' })).toBeUndefined()
    await runCommand($, w)
    expect(w.toasts.at(-1)).toMatch(/already added/)
    expect(await tabsOf(pane)).toBe(2)
    // The same words in another row are another Excerpt.
    w.selection = { text: 'npm test', requestId: 'r2' }
    await tick(w)
    expect(await pane.find({ key: 'add' })).toBeDefined()
  })

  describe('selections that are not transcript text are not offered', () => {
    test('the 📎 line under a rewritten prompt', async ($, on) => {
      const w = await start($, on)
      await addText($, w, '📎 2 annotations', 'u1')
      await addText($, w, '📎 2 annot', 'u1')
      expect(await tabCount($)).toBe(0)
      w.selection = { text: 'my question\n  📎', requestId: 'u1' }
      await tick(w)
      const pane = await mountPane($)
      expect(await pane.find({ type: 'Text', text: '“my question”' })).toBeDefined()
      await runCommand($, w)
      expect(await shown(pane)).toContain('\nmy question')
    })

    test('the draft in the prompt box', async ($, on) => {
      const w = await start($, on)
      w.draft = 'DRAFT-TEXT here in the prompt box'
      w.selection = { text: 'DRAFT-TEXT here' }
      await tick(w)
      const pane = await mountPane($)
      expect(await pane.find({ key: 'add' })).toBeUndefined()
      await runCommand($, w)
      expect(await tabsOf(pane)).toBe(0)
    })

    test("the pane's own words", async ($, on) => {
      const w = await start($, on)
      await addText($, w, 'npm test', 'r1')
      await commentInPane($, 1, 'why?')
      for (const text of ['Select text in the transcript', '1: Transcript ✕', '① from the transcript', 'npm test', 'Comment: why?', '[ Send ] now, or type', 'They go with your next prompt', '│ npm test │']) {
        await addText($, w, text)
      }
      expect(await tabCount($)).toBe(1)
    })

    test('a selection spanning rows that is not pane text is still offered, and stays offered', async ($, on) => {
      const w = await start($, on)
      w.draft = 'unrelated draft'
      w.selection = { text: 'end of one reply\n\nstart of the next' }
      await tick(w)
      const pane = await mountPane($)
      expect(await pane.find({ key: 'add' })).toBeDefined()
      // Its preview in the pane is not pane text that hides it again.
      await tick(w)
      expect(await pane.find({ key: 'add' })).toBeDefined()
    })
  })

  test('/clear drops pending Annotations', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'npm test', 'r1')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
    await submit($, 'fresh start')
    expect(w.submitted[0]).toEqual({ text: 'fresh start', context: undefined })
  })
})

describe('marks in the transcript', () => {
  test('a pending Annotation is marked after its Excerpt; cleared after submit', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'AssistantMessage', 'r1', REPLY)
    await addText($, w, 'commit the change', 'r1')
    expect(await drawRow($, w, 'AssistantMessage', 'r1', REPLY)).toBe('Run `npm test` before you **commit the change**`⁽¹⁾`.')
    expect(await drawRow($, w, 'AssistantMessage', 'r2', REPLY)).toBe(REPLY)
    await submit($, 'go')
    expect(await drawRow($, w, 'AssistantMessage', 'r1', REPLY)).toBe(REPLY)
  })

  test('ctrl+o draws marks on the full prompt the model read', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'UserMessage', 'u1', 'please refactor the parser')
    await addText($, w, 'refactor', 'u1')
    expect(await drawRow($, w, 'UserMessage', 'u1', 'please refactor the parser', { isExpanded: true })).toBe(
      'please refactor`⁽¹⁾` the parser',
    )
  })

  test('an Excerpt not found in the markdown is marked at the head of the row', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'AssistantMessage', 'r1', 'Some reply text.')
    await addText($, w, 'text the markdown never had', 'r1')
    expect(await drawRow($, w, 'AssistantMessage', 'r1', 'Some reply text.')).toBe('`①` Some reply text.')
  })

  test('a background-task notification row is not one of your prompts', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'UserMessage', 'n1', 'Background command "sleep" completed', {
      origin: { kind: 'task-notification' },
      task: { id: 't1', status: 'completed' },
    })
    await addText($, w, 'Background command', 'n1')
    await submit($, 'what finished?')
    expect(w.submitted[0]!.text).toContain('source="system"')
    // Its row is drawn as the engine has it: no mark, no rewrite.
    expect(
      await drawRow($, w, 'UserMessage', 'n1', 'Background command "sleep" completed', { origin: { kind: 'task-notification' } }),
    ).toBe('Background command "sleep" completed')
  })

  test('a summary block keeps its isSummary when marked', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'AssistantMessage', 's1', 'Checked the parser and the lexer.', { isSummary: true })
    await addText($, w, 'the lexer', 's1')
    await drawRow($, w, 'AssistantMessage', 's1', 'Checked the parser and the lexer.', { isSummary: true })
    expect(w.drawnProps.s1).toMatchObject({ text: 'Checked the parser and the lexer`⁽¹⁾`.', isSummary: true })
  })

  test('a Citation is drawn as its number and the directive is hidden', async ($, on) => {
    const w = await start($, on)
    const drawn = await drawRow($, w, 'AssistantMessage', 'r9', 'Done :annotation{index="2"}.')
    expect(drawn).toBe('Done `②`.')
  })
})

describe('sending', () => {
  test('the template rewrites the prompt; the row draws the original, its 📎 line drawn by the mod', async ($, on) => {
    const w = await start($, on)
    await drawRow($, w, 'AssistantMessage', 'r1', REPLY)
    await addText($, w, 'npm test', 'r1')
    const entered = await submit($, 'why?')
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]!.text).toStartWith('<annotations>\n<annotation index="1" source="assistant" requestId="r1">\n<excerpt>npm test</excerpt>')
    expect(w.submitted[0]!.text).toEndWith('<request>\nwhy?\n</request>')
    expect(entered.text).toBe(w.submitted[0]!.text)

    // In the terminal Claude Code draws what was typed; the 📎 row is the mod's.
    expect(await drawRow($, w, 'UserMessage', 'u2', w.submitted[0]!.text)).toBe('why?')
    expect(await drawRow($, w, 'UserMessage', 'u2', w.submitted[0]!.text, { isExpanded: true })).toBe(w.submitted[0]!.text)

    // The list is empty afterwards: the next prompt goes as typed.
    await submit($, 'plain')
    expect(w.submitted[1]).toEqual({ text: 'plain', context: undefined })
  })

  test('the original is kept in the store', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'npm test', 'r1')
    await submit($, 'why?')
    expect(storedOriginals(w)).toEqual({
      [hashText(w.submitted[0]!.text)]: { text: 'why?', count: 1, annotations: [{ index: 1, text: 'npm test', source: 'transcript', requestId: 'r1' }] },
    })
  })

  test('a resumed session draws the original from the store', async ($, on) => {
    const rewritten = '<annotations>\n...\n</annotations>\n\n<request>\nwhy?\n</request>'
    const kept = [
      { index: 1, text: 'one', source: 'assistant' as const },
      { index: 2, text: 'two', source: 'user' as const },
    ]
    const w = await start($, on, { originals: { [hashText(rewritten)]: { text: 'why?', count: 2, annotations: kept } } })
    expect(await drawRow($, w, 'UserMessage', 'u1', rewritten)).toBe('why?')
    const row = await mountPrompt($, 'u1', rewritten)
    expect((await row.find({ key: `clip-${hashText(rewritten)}` }))?.text).toBe('📎 2 annotations ↗')
  })

  test('prompts not typed by the person are left alone', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'npm test', 'r1')
    await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' }, wait: false })
    expect(w.submitted[0]!.text).toBe('done')
  })

  for (const kind of ['bridge', 'sdk', 'task-notification', 'peer', 'channel', 'scheduled-trigger'] as const) {
    test(`a ${kind} prompt is left alone and keeps the Annotations for the person's own`, async ($, on) => {
      const w = await start($, on)
      await addText($, w, 'npm test', 'r1')
      await $.prompt.submit({ text: 'from elsewhere', origin: { kind }, wait: false } as never)
      expect(w.submitted[0]).toEqual({ text: 'from elsewhere', context: undefined })
      await submit($, 'mine')
      expect(sentAnnotations(w.submitted[1]!.text).map(a => a.text)).toEqual(['npm test'])
    })
  }

  test('a prompt another plugin drops keeps the Annotations', async ($, on) => {
    const w = await start($, on)
    w.dropWhen = text => text.includes('DROP')
    await addText($, w, 'npm test', 'r1')
    const dropped = await submit($, 'DROP me')
    expect(dropped).toEqual({ drop: 'refused' })
    expect(await tabCount($)).toBe(1)
  })

  test('a prompt another plugin drops keeps no Original, and lets none go', async ($, on) => {
    const seeded = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [originalKey(`h${i}`), { text: `t${i}`, count: 1 }]))
    const w = await start($, on, seeded)
    w.dropWhen = text => text.includes('DROP')
    await addText($, w, 'npm test', 'r1')
    await submit($, 'DROP me')
    expect(Object.keys(w.store)).toEqual(Object.keys(seeded))
    const rewritten = renderTemplate('DROP me', [{ index: 1, text: 'npm test', source: 'transcript', requestId: 'r1' }])
    expect(await drawRow($, w, 'UserMessage', 'u1', rewritten)).toBe(rewritten)
  })

  test('text that looks like template tags is sent as written', async ($, on) => {
    const w = await start($, on)
    await addText($, w, 'use {{request}} and {{#annotations}}x{{/annotations}}', 'r1')
    await commentInPane($, 1, 'a "quoted" comment\twith <tags> & {{count}}')
    await submit($, 'why?')
    expect(sentAnnotations(w.submitted[0]!.text)[0]).toEqual({
      index: 1,
      text: 'use {{request}} and {{#annotations}}x{{/annotations}}',
      source: { role: 'transcript', requestId: 'r1' },
      annotation: 'a "quoted" comment\twith <tags> & {{count}}',
    })
  })

  test('past fifty Annotations the number is written out', async ($, on) => {
    const w = await start($, on)
    for (let i = 1; i <= 52; i += 1) {
      await addText($, w, `excerpt ${i}`, 'r1')
    }
    expect(await paneText($, 50)).toContain('㊿ from the transcript')
    expect(await paneText($, 52)).toContain('(52) from the transcript')
  })

})

/** Sends `request` with one Annotation, Commented, and resolves the rewritten prompt. */
async function sendOne($: Engine, w: Awaited<ReturnType<typeof start>>, request = 'q'): Promise<string> {
  await addText($, w, 'npm test', 'r1')
  await commentInPane($, 1, 'why?')
  await submit($, request)
  return w.submitted.at(-1)!.text
}

describe('sent prompts', () => {
  test('a rewind puts a prompt sent with Annotations back: what was typed, its Annotations pending again', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w, 'explain this')
    await addText($, w, 'already pending', 'r2')
    await changeBox($, w, sent, 'engine')
    expect(w.fills.at(-1)).toBe('explain this')
    expect(w.draft).toBe('explain this')
    const pane = await mountPane($)
    expect(await tabsOf(pane)).toBe(2)
    expect(await shown(pane)).toContain('\nnpm test')
    expect((await commentField(pane)).value).toBe('why?')
    await pane.unmount()
    // Once more, and the Annotation already back is not added twice.
    await changeBox($, w, sent, 'engine')
    expect(await tabCount($)).toBe(2)
  })

  test("a rewind's Annotations are the prompt's too: another prompt in the box takes them out, back to it brings them again, an emptied box takes them out", async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w, 'explain this')
    await submit($, 'a later prompt')
    await changeBox($, w, sent, 'engine')
    expect(await tabCount($)).toBe(1)
    await changeBox($, w, 'a later prompt', 'history')
    expect(await tabCount($)).toBe(0)
    await changeBox($, w, 'explain this', 'history')
    expect(await tabCount($)).toBe(1)
    await clearBox($, w)
    // A moment later: a submit empties the box too, before it reads them.
    expect(await tabCount($)).toBe(1)
    await tick(w)
    expect(await tabCount($)).toBe(0)
  })

  test('the box emptied by a submit of a prompt put back: its Annotations go with it', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w, 'explain this')
    await changeBox($, w, sent, 'history')
    expect(await tabCount($)).toBe(1)
    // The engine empties the box, then the prompt reaches prompt.submit.
    await clearBox($, w)
    await submit($, 'explain this')
    expect(sentAnnotations(w.submitted.at(-1)!.text).map(a => [a.text, a.annotation])).toEqual([['npm test', 'why?']])
    await tick(w)
    expect(await tabCount($)).toBe(0)
  })

  test('↑ to a prompt sent with Annotations brings them back; the next step through the history takes them out, a step back to it brings them again', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w, 'explain this')
    await submit($, 'a later prompt')
    await addText($, w, 'added meanwhile', 'r2')
    await changeBox($, w, sent, 'history')
    expect(w.draft).toBe('explain this')
    expect(await tabCount($)).toBe(2)
    await changeBox($, w, 'a later prompt', 'history')
    expect(await tabCount($)).toBe(1)
    expect(await paneText($)).toContain('added meanwhile')
    // The history keeps the entry as the mod filled it: what was typed.
    await changeBox($, w, 'explain this', 'history')
    expect(await tabCount($)).toBe(2)
    await changeBox($, w, '', 'history')
    expect(await tabCount($)).toBe(1)
  })

  test('a Comment typed and not saved stays with its Annotation when a step through the history takes those of a recall out before it', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w, 'explain this')
    await submit($, 'a later prompt')
    await changeBox($, w, sent, 'history')
    await addText($, w, 'added after', 'r2')
    await commentInPane($, 2, 'typed, never saved', 'change')
    await changeBox($, w, 'a later prompt', 'history')
    const pane = await mountPane($)
    expect(await tabsOf(pane)).toBe(1)
    expect(await shown(pane)).toContain('added after')
    expect((await commentField(pane)).value).toBe('typed, never saved')
    await pane.unmount()
    expect((await submitted($, w)).map(a => [a.text, a.annotation])).toEqual([['added after', 'typed, never saved']])
  })

  test("↑ to another conversation's prompt gives back what was typed, and not its Annotations, whose rows this transcript does not hold", async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w, 'explain this')
    await tick(w)
    // A new conversation: its transcript holds none of it.
    w.sessionId = 's2'
    w.messages = []
    await tick(w)
    await changeBox($, w, sent, 'history')
    expect(w.draft).toBe('explain this')
    expect(await tabCount($)).toBe(0)
  })

  test('a prompt typed as it was sent before, without Annotations, is left alone', async ($, on) => {
    const w = await start($, on)
    await submit($, 'plain')
    await changeBox($, w, 'plain', 'history')
    expect(w.fills).toEqual([])
    expect(await tabCount($)).toBe(0)
  })

  test("a reply to a prompt sent with Annotations draws only their numbers; kept with the prompt when the turn ends", async ($, on) => {
    const w = await start($, on)
    const reply = 'one :annotation{index="1"}, two :annotation{index="2"}'
    await drawRow($, w, 'AssistantMessage', 'before', reply)
    const sent = await sendOne($, w)
    expect(await drawRow($, w, 'AssistantMessage', 'a1', reply)).toBe('one `①`, two :annotation{index="2"}')
    // A subagent's turn ending is not this one's.
    await endTurn($, 'sub1')
    await drawRow($, w, 'AssistantMessage', 'a2', 'more :annotation{index="2"}')
    w.messages.push({ role: 'assistant', text: `${reply}\n\nmore :annotation{index="2"}`, toolUses: [] })
    await endTurn($)
    expect(storedOriginals(w)[hashText(sent)]?.replies).toEqual(['a1', 'a2'])
    expect(await drawRow($, w, 'AssistantMessage', 'a1', reply)).toBe('one `①`, two :annotation{index="2"}')
    // A reply drawn before the prompt was sent answers another.
    expect(await drawRow($, w, 'AssistantMessage', 'before', reply)).toBe('one `①`, two `②`')
    // One first drawn after the turn, answering a later prompt, is checked and let go.
    w.messages.push({ role: 'user', text: 'a later prompt', toolUses: [] }, { role: 'assistant', text: 'later :annotation{index="2"}', toolUses: [] })
    await drawRow($, w, 'AssistantMessage', 'after', 'later :annotation{index="2"}')
    await tick(w)
    expect(await drawRow($, w, 'AssistantMessage', 'after', 'later :annotation{index="2"}')).toBe('later `②`')
  })

  test('a reply first drawn just after its turn completes is still kept with the prompt', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    w.messages.push({ role: 'assistant', text: 'short :annotation{index="1"} :annotation{index="2"}', toolUses: [] })
    await endTurn($)
    expect(await drawRow($, w, 'AssistantMessage', 'late', 'short :annotation{index="1"} :annotation{index="2"}')).toBe('short `①` :annotation{index="2"}')
    await tick(w)
    expect(storedOriginals(w)[hashText(sent)]?.replies).toEqual(['late'])
  })

  test('an older reply first drawn during the turn keeps its own prompt\'s bound; one with none is let go by the check', async ($, on) => {
    const earlier = '<annotations>\n...\n</annotations>\n\n<request>\nearlier\n</request>'
    const w = await start($, on, { originals: { [hashText(earlier)]: { text: 'earlier', count: 3, replies: ['kept'] } } }, [earlier])
    w.messages.push({ role: 'assistant', text: 'kept reply :annotation{index="3"}', toolUses: [] }, { role: 'assistant', text: 'unkept reply :annotation{index="3"}', toolUses: [] })
    const sent = await sendOne($, w)
    // Scrolled to while the turn runs: one known to answer an earlier prompt keeps its bound...
    expect(await drawRow($, w, 'AssistantMessage', 'kept', 'kept reply :annotation{index="3"}')).toBe('kept reply `③`')
    // ...one known to answer none is taken for the turn's until the check.
    expect(await drawRow($, w, 'AssistantMessage', 'unkept', 'unkept reply :annotation{index="3"}')).toBe('unkept reply :annotation{index="3"}')
    // A streaming reply is the turn's from its first words.
    expect(await drawRow($, w, 'AssistantMessage', 'a1', 'kept reply :annotation{index="3"}')).toBe('kept reply :annotation{index="3"}')
    await drawRow($, w, 'AssistantMessage', 'a1', 'the answer :annotation{index="1"}')
    w.messages.push({ role: 'assistant', text: 'the answer :annotation{index="1"}', toolUses: [] })
    await endTurn($)
    expect(storedOriginals(w)[hashText(sent)]?.replies).toEqual(['a1'])
    expect(await drawRow($, w, 'AssistantMessage', 'unkept', 'unkept reply :annotation{index="3"}')).toBe('unkept reply `③`')
  })

  test('a resumed session still bounds the Citations of the replies kept with a prompt', async ($, on) => {
    const rewritten = '<annotations>\n...\n</annotations>\n\n<request>\nq\n</request>'
    const w = await start($, on, { originals: { [hashText(rewritten)]: { text: 'q', count: 1, replies: ['a1'] } } }, [rewritten])
    expect(await drawRow($, w, 'AssistantMessage', 'a1', 'x :annotation{index="3"}')).toBe('x :annotation{index="3"}')
  })

  test("in the terminal Claude Code draws the prompt as typed; the mod's 📎 row holds a card of its Annotations", async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    expect(await drawRow($, w, 'UserMessage', 'u2', sent)).toBe('q')
    const row = await mountPrompt($, 'u2', sent)
    expect((await row.find({ key: `clip-${hashText(sent)}` }))?.text).toBe('📎 1 annotation ↗')
    const card = (await row.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(card).toContain('“npm test”')
    expect(card).toContain('why?')
    await row.unmount()
  })

  test('on another surface the row stays text: the prompt and its 📎 line', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    const row = await mountPrompt($, 'u2', sent, 'desktop')
    expect((w.drawnProps.u2 as { text: string }).text).toBe('q\n📎 1 annotation')
    expect(await row.find({ key: `clip-${hashText(sent)}` })).toBeUndefined()
    await row.unmount()
  })

  test('the 📎 opens the pane on that prompt, read-only; back goes to the history, then to the pending view', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    const hash = hashText(sent)
    const row = await mountPrompt($, 'u2', sent)
    await row.press({ key: `clip-${hash}` })
    expect(w.panes.has('add-to-chat')).toBe(true)
    const pane = await mountPane($)
    const view = await shown(pane)
    expect(view).toContain('You sent “q”')
    expect(view).toContain('“npm test”'.slice(1, -1))
    expect(view).toContain('Comment: why?')
    expect(await pane.find({ type: 'Input' })).toBeUndefined()
    await pane.press({ key: 'back' })
    expect(await shown(pane)).toContain('Sent with annotations')
    await pane.press({ key: `sent-${hash}` })
    expect(await shown(pane)).toContain('You sent “q”')
    await pane.press({ key: 'back' })
    await pane.press({ key: 'back' })
    const pendingView = await shown(pane)
    expect(pendingView).toContain('Nothing added yet.')
    expect(pendingView).toContain('History (1) ›')
  })

  // The scroll itself is Claude Code's, and the e2e suite's to see; here no
  // transcript scrolls, so the jump says it could not.
  test('opened from its row, the prompt can be jumped to; a jump that cannot scroll says so', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    const row = await mountPrompt($, 'u2', sent)
    await row.press({ key: `clip-${hashText(sent)}` })
    const pane = await mountPane($)
    await pane.press({ key: 'jump' })
    expect(w.toasts.at(-1)).toBe(NOT_DRAWN)
  })

  test('opened from the history before its row is drawn, there is nothing to jump to', async ($, on) => {
    const sent = renderTemplate('q', [{ index: 1, text: 'npm test', source: 'assistant' }])
    const w = await start($, on, { originals: { [hashText(sent)]: { text: 'q', count: 1, annotations: [{ index: 1, text: 'npm test', source: 'assistant' }] } } }, [sent])
    const pane = await mountPane($)
    await pane.press({ key: 'history' })
    await pane.press({ key: `sent-${hashText(sent)}` })
    expect(await shown(pane)).toContain('You sent “q”')
    expect(await pane.find({ key: 'jump' })).toBeUndefined()
    expect(w.toasts).not.toContain(NOT_DRAWN)
  })

  test('a prompt kept without its Annotations draws the text row, with no 📎 button', async ($, on) => {
    const rewritten = '<annotations>\n...\n</annotations>\n\n<request>\nwhy?\n</request>'
    const w = await start($, on, { originals: { [hashText(rewritten)]: { text: 'why?', count: 2 } } })
    expect(await drawRow($, w, 'UserMessage', 'u1', rewritten)).toBe('why?\n📎 2 annotations')
    const row = await mountPrompt($, 'u1', rewritten)
    expect(await row.find({ key: `clip-${hashText(rewritten)}` })).toBeUndefined()
  })

  test("the history lists this conversation's prompts, not those the store keeps from other sessions", async ($, on) => {
    const other = renderTemplate('from another session', [{ index: 1, text: 'old', source: 'assistant' }])
    const w = await start($, on, { originals: { [hashText(other)]: { text: 'from another session', count: 1, annotations: [{ index: 1, text: 'old', source: 'assistant' }] } } })
    expect(await paneText($)).not.toContain('History (')
    await sendOne($, w)
    const pane = await mountPane($)
    expect(await shown(pane)).toContain('History (1) ›')
    await pane.press({ key: 'history' })
    const list = await shown(pane)
    expect(list).toContain('q')
    expect(list).not.toContain('from another session')
  })

  test('a new session id (/branch, /resume, /clear) brings the originals back from the store; the history follows the new transcript', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    await tick(w)
    // /clear: another id, an empty transcript.
    w.sessionId = 's2'
    w.messages = []
    await tick(w)
    expect(await paneText($)).not.toContain('History (')
    // /resume of the first, or a /branch of it: the prompt is in the transcript again.
    w.sessionId = 's3'
    w.messages = [{ role: 'user', text: sent, toolUses: [] }]
    await tick(w)
    expect(await paneText($)).toContain('History (1) ›')
    expect(await drawRow($, w, 'UserMessage', 'u9', sent)).toBe('q')
  })

  test('adding a selection while the pane shows the history shows the new tab', async ($, on) => {
    const w = await start($, on)
    await sendOne($, w)
    const pane = await mountPane($)
    await pane.press({ key: 'history' })
    await addText($, w, 'another', 'r1')
    const view = await shown(pane)
    expect(view).toContain('“another”'.slice(1, -1))
    expect(view).toContain('① from the transcript')
    expect(view).not.toContain('Sent with annotations')
  })

  test("the history's words are the pane's own, not offered", async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    const pane = await mountPane($)
    await addText($, w, 'History (1)')
    await pane.press({ key: 'history' })
    for (const text of ['Sent with annotations', '← back']) await addText($, w, text)
    await pane.press({ key: `sent-${hashText(sent)}` })
    for (const text of ['You sent', 'Comment: why?', 'No comment']) await addText($, w, text)
    await pane.press({ key: 'back' })
    await pane.press({ key: 'back' })
    expect(await tabsOf(pane)).toBe(0)
  })

  test("the pane's own words with their arrows: the history row's ›, the jump's ↑", async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    // The row drawn, so the sent view offers its jump.
    await drawRow($, w, 'UserMessage', 'u1', sent)
    const pane = await mountPane($)
    await addText($, w, 'History (1) ›')
    await pane.press({ key: 'history' })
    await pane.press({ key: `sent-${hashText(sent)}` })
    await addText($, w, '↑ jump to prompt')
    await pane.press({ key: 'back' })
    await pane.press({ key: 'back' })
    expect(await tabsOf(pane)).toBe(0)
  })
})


describe('the store, shared by every session', () => {
  const another = renderTemplate('from session B', [{ index: 1, text: 'b', source: 'assistant' }])
  const bRecord = { text: 'from session B', count: 1, annotations: [{ index: 1, text: 'b', source: 'assistant' as const }] }

  test("a session sending after another wrote keeps the other's Original; a reload brings both", async ($, on) => {
    // Session A loads the store; session B, running too, then keeps its prompt.
    const w = await start($, on)
    w.store[originalKey(hashText(another))] = bRecord
    const sent = await sendOne($, w)
    expect(Object.keys(storedOriginals(w))).toEqual([hashText(another), hashText(sent)])
    expect(storedOriginals(w)[hashText(another)]).toEqual(bRecord)
    // /resume of B in this process: its row draws what B typed.
    await tick(w)
    w.sessionId = 's2'
    w.messages = [{ role: 'user', text: another, toolUses: [] }]
    await tick(w)
    expect(await drawRow($, w, 'UserMessage', 'u9', another)).toBe('from session B')
  })

  test('two sessions keeping replies to the same prompt keep both, whichever writes last; reloaded, each reply keeps the bound of its prompt', async ($, on) => {
    const w = await start($, on)
    const sent = await sendOne($, w)
    const hash = hashText(sent)
    await drawRow($, w, 'AssistantMessage', 'a1', 'one :annotation{index="1"}')
    // A /branch of this conversation sent the same prompt; its session keeps its replies before this turn ends, and after.
    w.store[replyKey(hash, 'b1')] = true
    w.messages.push({ role: 'assistant', text: 'one :annotation{index="1"}', toolUses: [] })
    await endTurn($)
    w.store[replyKey(hash, 'b2')] = true
    expect(storedOriginals(w)[hash]?.replies).toEqual(['b1', 'a1', 'b2'])
    expect(w.store[originalKey(hash)]).toEqual({ text: 'q', count: 1, annotations: [{ index: 1, text: 'npm test', source: 'transcript', requestId: 'r1', comment: 'why?' }] })
    // /resume of the branch: a reply of its own still cites no Annotation past the prompt's one.
    await tick(w)
    w.sessionId = 's2'
    w.messages = [{ role: 'user', text: sent, toolUses: [] }]
    await tick(w)
    expect(await drawRow($, w, 'AssistantMessage', 'b1', 'two :annotation{index="2"}')).toBe('two :annotation{index="2"}')
  })
  test("0.4.0's one map is read, never written: under the records of their own keys, the replies of both; a record another session writes during a load stays as written", async ($, on) => {
    const one = { text: 'one', count: 1, replies: ['r1'] }
    const two = { text: 'two, as 0.4.0 kept it', count: 1, replies: ['old'] }
    const legacy = { h1: one, h2: two, bad: 'not an original' }
    const w = await start($, on, { originals: legacy, [originalKey('h2')]: { text: 'two', count: 1 }, [replyKey('h2', 'new')]: true })
    expect(storedOriginals(w)).toEqual({ h1: one, h2: { text: 'two', count: 1, replies: ['old', 'new'] } })
    // Loaded again (another session id) while another session keeps a newer record of h1 just after the keys are read.
    const keys = Object.keys(w.store)
    const newer = { text: 'one, sent again', count: 1 }
    w.afterKeys = () => {
      w.afterKeys = undefined
      w.store[originalKey('h1')] = newer
    }
    await tick(w)
    w.sessionId = 's2'
    await tick(w)
    expect(w.store[originalKey('h1')]).toEqual(newer)
    expect(w.store.originals).toEqual(legacy)
    expect(Object.keys(w.store)).toEqual([...keys, originalKey('h1')])
  })
  test("past 200 Originals, a prompt only 0.4.0's map holds still draws what was typed: state lets go what the store lets go", async ($, on) => {
    const legacy = '<request>\nold\n</request>'
    const seeded = Object.fromEntries(Array.from({ length: 199 }, (_, i) => [originalKey(`h${i}`), { text: `t${i}`, count: 1 }]))
    const w = await start($, on, { originals: { [hashText(legacy)]: { text: 'old', count: 1 } }, ...seeded })
    await sendOne($, w)
    expect(await drawRow($, w, 'UserMessage', 'u1', legacy)).not.toContain('<request>')
    expect(Object.keys(storedOriginals(w))).toHaveLength(201)
  })

  test('past 200 Originals the oldest goes, with its replies; one sent again counts as the newest', async ($, on) => {
    const seeded = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [originalKey(`h${i}`), { text: `t${i}`, count: 1 }]))
    const w = await start($, on, { ...seeded, [replyKey('h0', 'x')]: true, [replyKey('h1', 'y')]: true })
    const sent = await sendOne($, w)
    const kept = Object.keys(storedOriginals(w))
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('h1')
    // The oldest goes with its replies; the next keeps its own.
    expect(w.store[replyKey('h0', 'x')]).toBeUndefined()
    expect(w.store[replyKey('h1', 'y')]).toBe(true)
    expect(kept.at(-1)).toBe(hashText(sent))
    await sendOne($, w, 'other')
    await addText($, w, 'npm test', 'r1')
    await commentInPane($, 1, 'why?')
    await submit($, 'q')
    expect(Object.keys(storedOriginals(w)).slice(-2)).toEqual([hashText(w.submitted[1]!.text), hashText(sent)])
  })
})
