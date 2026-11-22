// SHEP-90: the artifact picture viewer's zoom, its Copy (a PNG on the clipboard, asked for in the click itself), what a
// failed Copy says, and which full screen the viewer gets
import { describe, expect, test } from 'bun:test'
import { clampZoom, percent, toggledZoom } from './pictures.ts'
import { canCopyPicture, copyPicture, copyProblem, type ClipEnv } from './copy.ts'
import { fullscreenWay, liftToTop, overHost } from './fullscreen.ts'

class Item {
  constructor(public parts: Record<string, Promise<Blob> | Blob>) {}
}

describe('zoom', () => {
  test('never below fitted, never past 800% of its own pixels', () => {
    expect(clampZoom(0.5, 0.25)).toBe(1)
    expect(clampZoom(3, 0.25)).toBe(3)
    expect(clampZoom(100, 0.25)).toBe(32)
    expect(clampZoom(100, 1)).toBe(8)
  })
  test('the % is the drawn size over its own', () => {
    expect(percent(1, 0.5)).toBe('50%')
    expect(percent(2, 0.5)).toBe('100%')
  })
  test('the % button: fitted to its own size, and back; a small picture doubles', () => {
    expect(toggledZoom(1, 0.5)).toBe(2)
    expect(toggledZoom(2, 0.5)).toBe(1)
    expect(toggledZoom(1, 1)).toBe(2)
  })
})

describe('Copy', () => {
  const env = (o: Partial<ClipEnv> & { log?: unknown[] } = {}): ClipEnv => ({
    secure: true,
    write: async (items) => { o.log?.push(...items) },
    Item: Item as unknown as ClipEnv['Item'],
    ...o,
  })

  test('only where the browser can put a picture on the clipboard: https and ClipboardItem', () => {
    expect(canCopyPicture(env())).toBe(true)
    expect(canCopyPicture(env({ secure: false }))).toBe(false)
    expect(canCopyPicture(env({ Item: undefined }))).toBe(false)
    expect(canCopyPicture(env({ write: undefined }))).toBe(false)
  })

  test('the clipboard is asked at once, with the PNG still to come; it gets the picture made a PNG', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(new Blob(['gif'], { type: 'image/gif' })) })
    try {
      const log: unknown[] = []
      let wrote = 0
      const e = env({ log, write: async (items) => { wrote++; log.push(...items) } })
      const p = copyPicture(`http://localhost:${server.port}/a.gif`, async (b) => new Blob([`png of ${await b.text()}`], { type: 'image/png' }), e)
      // in the click: before anything awaited
      expect(wrote).toBe(1)
      await p
      const part = (log[0] as Item).parts['image/png'] as Promise<Blob>
      const png = await part
      expect(png.type).toBe('image/png')
      expect(await png.text()).toBe('png of gif')
    } finally {
      server.stop(true)
    }
  })

  test('a picture that does not load, or a browser that says no, fails in plain words', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('gone', { status: 404 }) })
    try {
      // the browser waits for the picture before it writes: the write fails with the load's error
      const e = env({ write: async (items) => { await (items[0] as Item).parts['image/png'] } })
      await expect(copyPicture(`http://localhost:${server.port}/x.png`, async (b) => b, e)).rejects.toThrow("The picture didn't load (404).")
    } finally {
      server.stop(true)
    }
    const denied = env({ write: async () => { throw Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }) } })
    await expect(copyPicture('http://localhost:1/x.png', async (b) => b, denied)).rejects.toThrow("The browser didn't allow it")
    await expect(copyPicture('x.png', async (b) => b, env({ secure: false }))).rejects.toThrow('needs the app over https')
    expect(copyProblem(null, env({ Item: undefined }))).toBe("This browser can't put a picture on the clipboard: save it instead.")
  })
})

describe('full screen', () => {
  const el = { requestFullscreen: async () => undefined }
  test("the browser's own where it has one for an element", () => {
    expect(fullscreenWay({ fullscreenEnabled: true }, el)).toBe('browser')
    expect(fullscreenWay({ fullscreenEnabled: false, webkitFullscreenEnabled: true }, { webkitRequestFullscreen: () => undefined } as never)).toBe('browser')
  })
  test("an iPhone's Safari (none for an element), or one turned off: the page's", () => {
    expect(fullscreenWay({ fullscreenEnabled: false }, {} as never)).toBe('page')
    expect(fullscreenWay({ fullscreenEnabled: false }, el)).toBe('page')
    expect(fullscreenWay(undefined, undefined)).toBe('page')
  })
})

describe("the page's full screen on the top layer (SHEP-107)", () => {
  const fake = (pop: boolean, fails = false) => {
    const attrs = new Map<string, string>()
    const log: string[] = []
    const el = {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
      ...(pop ? {
        showPopover: () => { if (fails) throw new Error('not connected'); log.push(`show ${attrs.get('popover')}`) },
        hidePopover: () => void log.push('hide'),
      } : {}),
    }
    return { el, attrs, log }
  }
  test('lifted as a manual popover (Esc stays the app\'s), and put back as it was', () => {
    const { el, attrs, log } = fake(true)
    const back = liftToTop(el)
    expect(log).toEqual(['show manual'])
    expect(attrs.has('data-full-page')).toBe(true)
    back!()
    expect(log).toEqual(['show manual', 'hide'])
    expect([...attrs.keys()]).toEqual([])
  })
  test('a browser without popovers, or one that refuses: left as it was, only its classes fill the page', () => {
    const none = fake(false)
    expect(liftToTop(none.el)).toBeNull()
    expect([...none.attrs.keys()]).toEqual([])
    const refused = fake(true, true)
    expect(liftToTop(refused.el)).toBeNull()
    expect([...refused.attrs.keys()]).toEqual([])
  })
  test('the picture viewer opens inside the full-screen artifact, of either kind, else in the body', () => {
    const body = { b: 1 } as never, full = { f: 1 } as never, lifted = { l: 1 } as never
    const doc = (fs: unknown, page: unknown) => ({ fullscreenElement: fs as never, querySelector: (s: string) => (s === '[data-full-page]' ? page : null) as never, body })
    expect(overHost(doc(full, null))).toBe(full)
    expect(overHost(doc(null, lifted))).toBe(lifted)
    expect(overHost(doc(null, null))).toBe(body)
  })
})
