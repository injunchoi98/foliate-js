const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect, includePartialStart = false) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            // A line clipped by the scroll viewport is still being read.
            // Save its first character, rather than the end of that line.
            if (includePartialStart) return p.right > start ? -1 : 1
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #textDirection
    #rootStyles
    #column = true
    #size
    #layout = {}
    #destroyed = false
    #cancelLoad
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (this.#destroyed) throw new DOMException('View destroyed', 'AbortError')
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.#iframe.removeEventListener('load', onLoad)
                this.#iframe.removeEventListener('error', onError)
                this.#cancelLoad = null
            }
            const onError = () => {
                cleanup()
                reject(new Error(`Failed to load ${src}`))
            }
            const onLoad = async () => {
                try {
                    const doc = this.document
                    afterLoad?.(doc)

                    // it needs to be visible for Firefox to get computed style
                    this.#iframe.style.display = 'block'
                    const { vertical, rtl } = getDirection(doc)
                    const background = getBackground(doc)
                    const rootStyle = doc.defaultView.getComputedStyle(doc.documentElement)
                    this.#rootStyles = {
                        direction: rootStyle.direction,
                        'writing-mode': rootStyle.writingMode,
                        contain: rootStyle.contain,
                    }
                    this.#textDirection = doc.defaultView.getComputedStyle(doc.body).direction
                    this.#iframe.style.display = 'none'

                    this.#vertical = vertical
                    this.#rtl = rtl

                    this.#contentRange.selectNodeContents(doc.body)
                    const layout = beforeRender?.({ vertical, rtl, background })
                    this.#iframe.style.display = 'block'
                    this.render(layout)
                    this.#observer.observe(doc.body)

                    // The observer misses font changes in Firefox. Await the
                    // first font layout before resolving a saved CFI as well.
                    await doc.fonts.ready
                    if (this.#destroyed) return
                    this.expand()
                    cleanup()
                    resolve()
                } catch (error) {
                    cleanup()
                    reject(error)
                }
            }
            this.#cancelLoad = () => {
                cleanup()
                reject(new DOMException('View destroyed', 'AbortError'))
            }
            Promise.resolve(src).then(value => {
                if (this.#destroyed) return
                if (typeof value !== 'string') throw new Error(`${value} is not string`)
                this.#iframe.addEventListener('load', onLoad, { once: true })
                this.#iframe.addEventListener('error', onError, { once: true })
                this.#iframe.src = value
            }).catch(error => {
                cleanup()
                reject(error)
            })
        })
    }
    render(layout) {
        if (!layout || !this.#rootStyles) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        this.#rtl = layout.rtl ?? this.#rtl
        if (!this.#vertical) {
            // Containment stops body's bidi direction from also controlling the columns.
            setStylesImportant(this.document.documentElement, this.#column ? {
                direction: this.#rtl ? 'rtl' : 'ltr',
                'writing-mode': 'horizontal-tb',
                contain: this.#rtl !== (this.#textDirection === 'rtl')
                    && this.#rootStyles.contain === 'none' ? 'style' : this.#rootStyles.contain,
            } : this.#rootStyles)
            setStylesImportant(this.document.body, { direction: this.#textDirection })
        }
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        if (this.#destroyed) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                // The column branch above sets style.width to expandedSize
                // (e.g. 5520) when in paginated mode. In scrolled mode `side`
                // is 'height', so the line above only updates height. Without
                // explicitly clearing width, the inline 5520 lingers and
                // inflates ancestor scrollWidth. Reset to 100% to track the
                // wrapper.
                this.#overlayer.element.style[otherSide] = '100%'
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
        if (this.document) this.expand()
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        this.#destroyed = true
        this.#cancelLoad?.()
        this.#observer.disconnect()
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
        'max-column-count-portrait',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #selectionScrollOffset = null
    #selectionScrollProp = null
    #lastVisibleRange
    #views = []
    #topSentinel = document.createElement('div')
    #bottomSentinel = document.createElement('div')
    #continuousObserver
    #continuousQueue = Promise.resolve()
    #continuousGeneration = 0
    #continuousNavigating = false
    #navigationRequest = 0
    #continuousCheckTimeout
    #continuousCheckRAF = 0
    #continuousTrimTimeout
    #scrollDelta = 0
    #scrollDeltaTimeout
    #prevScrollOffset = 0
    #continuousPreload = 1200
    #continuousKeepAround = 1
    #pendingContinuousAnchor = null
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
            position: relative;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #container::-webkit-scrollbar {
            display: none;
            width: 0;
            height: 0;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => {
            const offset = this.#selectionScrollOffset
            const scrollProp = this.#selectionScrollProp
            if (offset === null || !scrollProp || this.scrolled) return
            if (this.#container[scrollProp] !== offset)
                this.#container[scrollProp] = offset
        })
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', () => {
            if (this.scrolled && this.#views.length) this.#onContinuousScroll()
        })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#views.length) this.#afterContinuousScroll('scroll')
                else if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        Object.assign(this.#topSentinel.style, {
            width: '1px',
            height: '1px',
            pointerEvents: 'none',
        })
        Object.assign(this.#bottomSentinel.style, {
            width: '1px',
            height: '1px',
            pointerEvents: 'none',
        })
        this.#topSentinel.setAttribute('aria-hidden', 'true')
        this.#bottomSentinel.setAttribute('aria-hidden', 'true')

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            let pointerScrollOffset = null
            doc.addEventListener('pointerdown', () => {
                isPointerSelecting = true
                pointerScrollOffset = this.#container[this.scrollProp]
                const sel = doc.getSelection()
                if (sel?.rangeCount && !sel.isCollapsed)
                    this.#lockSelectionScroll(pointerScrollOffset)
            }, { capture: true })
            const endPointerSelection = () => {
                isPointerSelecting = false
                const sel = doc.getSelection()
                if (this.hasAttribute('lock-selection-scroll')
                    && sel?.rangeCount && !sel.isCollapsed) {
                    this.#lockSelectionScroll(pointerScrollOffset)
                    return
                }
                pointerScrollOffset = null
                this.#unlockSelectionScroll()
            }
            doc.addEventListener('pointerup', endPointerSelection, { capture: true })
            doc.addEventListener('pointercancel', endPointerSelection, { capture: true })
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const sel = doc.getSelection()
                if (!sel?.rangeCount || sel.isCollapsed) {
                    if (!isPointerSelecting) {
                        pointerScrollOffset = null
                        this.#unlockSelectionScroll()
                    }
                    return
                }
                if (this.hasAttribute('lock-selection-scroll'))
                    this.#lockSelectionScroll(pointerScrollOffset)
                const range = this.#lastVisibleRange
                if (!range) return
                if (isPointerSelecting && sel.type === 'Range') {
                    if (!this.hasAttribute('lock-selection-scroll'))
                        checkPointerSelection(range, sel)
                }
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, oldValue, value) {
        switch (name) {
            case 'flow':
                if (oldValue === value) return
                if (value === 'scrolled')
                    this.#enterContinuous(this.#lastVisibleRange ?? this.#anchor)
                else this.#exitContinuous()
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
            case 'max-column-count-portrait':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.#scrollToAnchor(this.#anchor),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #queueContinuous(task) {
        const generation = this.#continuousGeneration
        const runTask = () => generation === this.#continuousGeneration ? task() : undefined
        const run = this.#continuousQueue.then(runTask, runTask)
        this.#continuousQueue = run.catch(() => {})
        return run
    }
    #invalidateContinuous() {
        this.#continuousGeneration++
        this.#continuousQueue = Promise.resolve()
        this.#continuousNavigating = false
        this.#locked = false
    }
    #ensureContinuousSentinels() {
        if (!this.#topSentinel.parentNode)
            this.#container.insertBefore(this.#topSentinel, this.#container.firstChild)
        if (!this.#bottomSentinel.parentNode)
            this.#container.append(this.#bottomSentinel)
    }
    #enterContinuous(anchor = this.#anchor) {
        this.#pendingContinuousAnchor = anchor
        this.#ensureContinuousSentinels()
        if (this.#view && this.#index >= 0 && !this.#views.length)
            this.#views = [{ index: this.#index, view: this.#view }]
        // Mirror of the reset in #exitContinuous. Coming from paginated mode,
        // the container retains the previous flow's scroll offset (scrollLeft
        // for horizontal). After the CSS overflow swap, that stale offset
        // doesn't auto-clamp on iOS WebKit, so the viewport ends up shifted
        // into empty space and the kept view is invisible.
        this.#container.scrollTop = 0
        this.#container.scrollLeft = 0
        this.#installContinuousObserver()
        this.#prevScrollOffset = this.#continuousStart()
        this.#scheduleContinuousCheck(0)
    }
    #exitContinuous() {
        this.#invalidateContinuous()
        this.#pendingContinuousAnchor = null
        this.#disconnectContinuousObserver()
        clearTimeout(this.#continuousCheckTimeout)
        clearTimeout(this.#continuousTrimTimeout)
        if (this.#continuousCheckRAF) {
            cancelAnimationFrame(this.#continuousCheckRAF)
            this.#continuousCheckRAF = 0
        }
        if (!this.#views.length) {
            this.#topSentinel.remove()
            this.#bottomSentinel.remove()
            return
        }

        const active = this.#getActiveViewRecord()
        const anchor = active ? this.#getVisibleRangeForRecord(active) : this.#anchor
        for (const record of this.#views.slice()) {
            if (record === active) continue
            this.#removeContinuousRecord(record)
        }
        this.#views = []
        this.#topSentinel.remove()
        this.#bottomSentinel.remove()
        if (active) {
            this.#view = active.view
            this.#index = active.index
            this.#anchor = anchor ?? 0
            // The continuous-mode scroll axis (scrollTop for horizontal,
            // scrollLeft for vertical) has a non-zero offset from scrolling
            // through the document. After flow flips, paginated mode uses the
            // orthogonal axis. The stale offset shifts the wrapper off-screen
            // (e.g. scrollTop=1472 hides the columnized content). Reset both.
            this.#container.scrollTop = 0
            this.#container.scrollLeft = 0
        }
        requestAnimationFrame(() =>
            this.#view && !this.scrolled
                ? this.#scrollToAnchor(this.#anchor).catch(() => {}) : null)
    }
    #installContinuousObserver() {
        this.#disconnectContinuousObserver()
        if (!globalThis.IntersectionObserver) return
        const margin = this.#vertical
            ? `0px ${this.#continuousPreload}px`
            : `${this.#continuousPreload}px 0px`
        this.#continuousObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting))
                this.#scheduleContinuousCheck(0)
        }, {
            root: this.#container,
            rootMargin: margin,
            threshold: 0,
        })
        this.#continuousObserver.observe(this.#topSentinel)
        this.#continuousObserver.observe(this.#bottomSentinel)
    }
    #disconnectContinuousObserver() {
        this.#continuousObserver?.disconnect()
        this.#continuousObserver = null
    }
    #scheduleContinuousCheck(delay = 30) {
        if (!this.scrolled || this.#continuousNavigating) return
        // delay=0 means "as soon as possible" — align to the next browser
        // frame so multiple onExpand/scroll triggers within one frame coalesce
        // into a single check, and layout reads happen right before paint.
        if (delay === 0) {
            if (this.#continuousCheckRAF) return
            this.#continuousCheckRAF = requestAnimationFrame(() => {
                this.#continuousCheckRAF = 0
                this.#checkContinuousEdges().catch(e => console.warn(e))
            })
            return
        }
        clearTimeout(this.#continuousCheckTimeout)
        this.#continuousCheckTimeout = setTimeout(() =>
            this.#checkContinuousEdges().catch(e => console.warn(e)), delay)
    }
    #scheduleContinuousTrim(delay = 350) {
        clearTimeout(this.#continuousTrimTimeout)
        this.#continuousTrimTimeout = setTimeout(() => {
            if (this.#scrollDelta > 2) {
                this.#scheduleContinuousTrim(120)
                return
            }
            this.#queueContinuous(() => this.#trimContinuous())
        }, delay)
    }
    #onContinuousScroll() {
        const offset = this.#continuousStart()
        this.#scrollDelta += Math.abs(offset - this.#prevScrollOffset)
        this.#prevScrollOffset = offset
        clearTimeout(this.#scrollDeltaTimeout)
        this.#scrollDeltaTimeout = setTimeout(() => this.#scrollDelta = 0, 150)
        this.#scheduleContinuousCheck(30)
        this.#scheduleContinuousTrim(350)
    }
    #hasContinuousRecord(index) {
        return this.#views.some(record => record.index === index)
    }
    async #loadContinuousRecord(index, prepend) {
        if (!this.#canGoToIndex(index) || this.#hasContinuousRecord(index)) return null
        this.#ensureContinuousSentinels()

        const view = new View({
            container: this,
            onExpand: () => this.#scheduleContinuousCheck(0),
        })
        const record = { index, view, staged: true, loaded: false }
        // Stage the wrapper out-of-flow during iframe load so it doesn't push
        // visible content. iframe still loads and lays out (its width inherits
        // 100% of container via absolute positioning). Caller commits to flow
        // synchronously after load, in the same block as scroll compensation.
        Object.assign(view.element.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            visibility: 'hidden',
            pointerEvents: 'none',
        })
        if (prepend) {
            const ref = this.#views[0]?.view.element ?? this.#bottomSentinel
            this.#container.insertBefore(view.element, ref)
            this.#views.unshift(record)
        } else {
            this.#container.insertBefore(view.element, this.#bottomSentinel)
            this.#views.push(record)
        }

        const afterLoad = doc => {
            if (doc.head) {
                const $styleBefore = doc.createElement('style')
                doc.head.prepend($styleBefore)
                const $style = doc.createElement('style')
                doc.head.append($style)
                this.#styleMap.set(doc, [$styleBefore, $style])
            }
            this.#applyStylesToDocument(doc, this.#styles)
            this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
        }
        try {
            const src = Promise.resolve(this.sections[index].load()).then(src => {
                record.loaded = true
                // Release an abandoned load when it completes, rather than
                // unloading before its resources have actually been created.
                if (!this.#hasContinuousRecord(index) && this.#index !== index)
                    this.sections[index]?.unload?.()
                return src
            })
            await view.load(src, afterLoad, this.#beforeRender.bind(this))
            if (!this.#views.includes(record)) return null
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            return record
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.warn(e)
                console.warn(new Error(`Failed to load section ${index}`))
            }
            this.#removeContinuousRecord(record)
            return null
        }
    }
    #commitRecordToFlow(record) {
        if (!record || !record.staged) return
        const el = record.view.element
        // View wrappers must stay positioned because overlays are absolutely
        // positioned inside them. Clearing this after continuous-mode staging
        // makes highlights anchor to the scroller instead of the section.
        el.style.position = 'relative'
        el.style.top = ''
        el.style.left = ''
        el.style.visibility = ''
        el.style.pointerEvents = ''
        record.staged = false
    }
    async #appendContinuous(index) {
        const record = await this.#loadContinuousRecord(index, false)
        if (!this.#views.includes(record)) return null
        if (record) {
            // Append below visible content: revealing it doesn't push the
            // active record (it grows downward), so no scroll compensation.
            this.#commitRecordToFlow(record)
            if (!this.#view) {
                this.#view = record.view
                this.#index = record.index
            }
        }
        return record
    }
    async #prependContinuous(index) {
        const record = await this.#loadContinuousRecord(index, true)
        if (!record || !this.#views.includes(record)) return null
        const anchor = this.#views.find(r => !r.staged && r !== record)
        if (!anchor) {
            this.#commitRecordToFlow(record)
            return record
        }
        const before = this.#recordViewportStart(anchor)
        this.#commitRecordToFlow(record)
        const after = this.#recordViewportStart(anchor)
        const delta = after - before
        if (delta) {
            this.#container[this.scrollProp] += delta
            this.#justAnchored = true
        }
        return record
    }
    #continuousContentLength() {
        return this.#vertical ? this.#container.scrollWidth : this.#container.scrollHeight
    }
    #continuousScrollProp() {
        return this.#vertical ? 'scrollLeft' : 'scrollTop'
    }
    #continuousSideProp() {
        return this.#vertical ? 'width' : 'height'
    }
    #continuousSize() {
        return this.#container.getBoundingClientRect()[this.#continuousSideProp()]
    }
    #continuousStart() {
        return Math.abs(this.#container[this.#continuousScrollProp()])
    }
    #continuousEnd() {
        return this.#continuousStart() + this.#continuousSize()
    }
    #shouldAppendContinuous() {
        return this.#continuousStart() + this.#continuousSize() + this.#continuousPreload
            >= this.#continuousContentLength()
    }
    #shouldPrependContinuous() {
        return this.#continuousStart() <= this.#continuousPreload
    }
    async #checkContinuousEdges() {
        return this.#queueContinuous(async () => {
            if (!this.scrolled || this.#continuousNavigating || !this.#views.length) return false
            const generation = this.#continuousGeneration
            let changed = false

            while (this.#shouldAppendContinuous()) {
                const last = this.#views[this.#views.length - 1]
                const next = this.#adjacentIndex(1, last.index)
                if (next == null) break
                const record = await this.#appendContinuous(next)
                if (generation !== this.#continuousGeneration) return false
                if (!record) break
                changed = true
            }

            while (this.#shouldPrependContinuous()) {
                const first = this.#views[0]
                const prev = this.#adjacentIndex(-1, first.index)
                if (prev == null) break
                const record = await this.#prependContinuous(prev)
                if (generation !== this.#continuousGeneration) return false
                if (!record) break
                changed = true
            }

            if (changed) {
                this.#afterContinuousScroll('anchor')
                this.#scheduleContinuousTrim(350)
            }
            return changed
        })
    }
    #recordSize(record) {
        return record.view.element.getBoundingClientRect()[this.#continuousSideProp()]
    }
    #recordOffset(record) {
        return this.#vertical
            ? this.#continuousStart() + this.#container.getBoundingClientRect().right
                - record.view.element.getBoundingClientRect().right
            : record.view.element.offsetTop
    }
    #recordViewportStart(record) {
        const rect = record.view.element.getBoundingClientRect()
        return this.#vertical ? rect.left : rect.top
    }
    #getRectMapperForRecord(record) {
        return this.#getRectMapper(this.#recordSize(record), true)
    }
    #getLocalBounds(record) {
        const offset = this.#recordOffset(record)
        const size = this.#recordSize(record)
        return {
            size,
            start: Math.max(0, this.#continuousStart() - offset),
            end: Math.min(size, this.#continuousEnd() - offset),
        }
    }
    #getAnchorOffset(record, anchor) {
        const target = typeof anchor === 'function'
            ? anchor(record.view.document) : anchor
        const rects = uncollapse(target)?.getClientRects?.()
        if (rects) {
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return this.#recordOffset(record)
            const recordOffset = this.#recordOffset(record)
            const mapped = this.#getRectMapperForRecord(record)(rect).left
            return recordOffset + mapped - this.#margin
        }
        const fraction = typeof target === 'number' ? target : 0
        return this.#recordOffset(record) + fraction * this.#recordSize(record)
    }
    async #scrollToAnchorInRecord(record, anchor, reason = 'navigation') {
        this.#anchor = anchor
        await this.#scrollTo(this.#getAnchorOffset(record, anchor), reason)
    }
    async #fillContinuousViewport(record, anchor) {
        const generation = this.#continuousGeneration
        while (this.#getAnchorOffset(record, anchor) + this.#continuousSize()
            > this.#continuousContentLength()) {
            const last = this.#views[this.#views.length - 1]
            const next = this.#adjacentIndex(1, last.index)
            if (next == null) break
            const appended = await this.#appendContinuous(next)
            if (generation !== this.#continuousGeneration) return false
            if (!appended) break
        }
        return true
    }
    #getActiveViewRecord() {
        if (!this.#views.length) return null
        const containerRect = this.#container.getBoundingClientRect()
        let best = null
        let bestOverlap = -1
        let nearest = null
        let nearestDistance = Infinity
        const center = this.#vertical
            ? (containerRect.left + containerRect.right) / 2
            : (containerRect.top + containerRect.bottom) / 2
        for (const record of this.#views) {
            if (record.staged) continue
            const rect = record.view.element.getBoundingClientRect()
            const start = this.#vertical
                ? Math.max(rect.left, containerRect.left)
                : Math.max(rect.top, containerRect.top)
            const end = this.#vertical
                ? Math.min(rect.right, containerRect.right)
                : Math.min(rect.bottom, containerRect.bottom)
            const overlap = Math.max(0, end - start)
            // Reading resumes at the first visible section, even if only a
            // few lines remain above a much taller following section.
            if (overlap > 0) {
                const range = this.#getVisibleRangeForRecord(record)
                // A leftover margin/blank tail is not a reading position.
                if (!range.collapsed || range.startContainer !== record.view.document.body)
                    return record
            }
            if (overlap > bestOverlap) {
                best = record
                bestOverlap = overlap
            }
            const recordCenter = this.#vertical
                ? (rect.left + rect.right) / 2
                : (rect.top + rect.bottom) / 2
            const distance = Math.abs(recordCenter - center)
            if (distance < nearestDistance) {
                nearest = record
                nearestDistance = distance
            }
        }
        return bestOverlap > 0 ? best : nearest
    }
    #getVisibleRangeForRecord(record) {
        const { start, end, size } = this.#getLocalBounds(record)
        const from = Math.max(0, start + this.#margin)
        const to = Math.max(from, Math.min(size, end - this.#margin))
        return getVisibleRange(record.view.document, from, to,
            this.#getRectMapperForRecord(record), true)
    }
    #getSectionFractionForRecord(record) {
        const { start, size } = this.#getLocalBounds(record)
        return size > 0 ? Math.max(0, Math.min(1, start / size)) : 0
    }
    #getVisibleFractionForRecord(record) {
        const { start, end, size } = this.#getLocalBounds(record)
        return size > 0 ? Math.max(0, Math.min(1, (end - start) / size)) : 0
    }
    #afterContinuousScroll(reason) {
        if (this.#continuousNavigating) return
        const record = this.#getActiveViewRecord()
        if (!record) return
        const range = this.#getVisibleRangeForRecord(record)
        this.#lastVisibleRange = range
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        this.#view = record.view
        this.#index = record.index
        this.#background.style.background = getBackground(record.view.document)
        this.dispatchEvent(new CustomEvent('relocate', {
            detail: {
                reason,
                range,
                index: record.index,
                fraction: this.#getSectionFractionForRecord(record),
                size: this.#getVisibleFractionForRecord(record),
            },
        }))
    }
    async #trimContinuous() {
        if (!this.scrolled || this.#views.length <= this.#continuousKeepAround * 2 + 1)
            return
        const active = this.#getActiveViewRecord()
        if (!active) return
        const activeIndex = this.#views.indexOf(active)
        // Pixel guard: only trim records that lie OUTSIDE the container's
        // preload window. Without this, the count-based keepAround can remove
        // short pages that are still close to the viewport, which immediately
        // re-triggers prepend → infinite trim/prepend duel.
        // Note: must use container viewport (not active record), because what
        // matters is whether the record overlaps the preload zone that drives
        // shouldPrepend/shouldAppend.
        const sideProp = this.#continuousSideProp()
        const containerRect = this.#container.getBoundingClientRect()
        const cMin = sideProp === 'height' ? containerRect.top : containerRect.left
        const cMax = sideProp === 'height' ? containerRect.bottom : containerRect.right
        const preload = this.#continuousPreload
        const remove = this.#views.filter((rec, index) => {
            if (rec === active) return false
            if (Math.abs(index - activeIndex) <= this.#continuousKeepAround) return false
            const r = rec.view.element.getBoundingClientRect()
            const rMin = sideProp === 'height' ? r.top : r.left
            const rMax = sideProp === 'height' ? r.bottom : r.right
            return rMax < cMin - preload || rMin > cMax + preload
        })
        if (!remove.length) return

        const before = this.#recordViewportStart(active)
        for (const record of remove) this.#removeContinuousRecord(record)
        const after = this.#recordViewportStart(active)
        const delta = after - before
        this.#container[this.scrollProp] += delta
    }
    #removeContinuousRecord(record) {
        const index = this.#views.indexOf(record)
        if (index < 0) return
        this.#views.splice(index, 1)
        record.view.destroy()
        record.view.element.remove()
        if (record.loaded !== false) this.sections[record.index]?.unload?.()
        if (this.#view === record.view) {
            const active = this.#getActiveViewRecord()
            this.#view = active?.view ?? null
            this.#index = active?.index ?? -1
        }
    }
    #clearContinuousViews() {
        this.#pendingContinuousAnchor = null
        this.#disconnectContinuousObserver()
        clearTimeout(this.#continuousCheckTimeout)
        clearTimeout(this.#continuousTrimTimeout)
        if (this.#continuousCheckRAF) {
            cancelAnimationFrame(this.#continuousCheckRAF)
            this.#continuousCheckRAF = 0
        }
        const records = this.#views.slice()
        for (const record of records) this.#removeContinuousRecord(record)
        if (this.#view) {
            this.#view.destroy()
            this.#view.element.remove()
            this.sections[this.#index]?.unload?.()
        }
        this.#views = []
        this.#view = null
        this.#index = -1
        this.#topSentinel.remove()
        this.#bottomSentinel.remove()
    }
    #beforeRender({ vertical, rtl, background }) {
        const flow = this.getAttribute('flow')
        if (flow !== 'scrolled' && !vertical && ['ltr', 'rtl'].includes(this.bookDir))
            rtl = this.bookDir === 'rtl'
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.#background.style.background = background

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        // Continuous vertical writing places chapters next to each other,
        // starting at the right edge, rather than stacking them below it.
        this.#container.style.display = flow === 'scrolled' && vertical ? 'flex' : ''
        this.#topSentinel.style.flexShrink = this.#bottomSentinel.style.flexShrink = '0'
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth, rtl }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth, rtl }
    }
    render() {
        if (this.scrolled && this.#views.length) {
            const active = this.#getActiveViewRecord()
            const entering = this.#pendingContinuousAnchor !== null
            const anchor = this.#pendingContinuousAnchor
                ?? (active ? this.#getVisibleRangeForRecord(active) : this.#anchor)
            this.#pendingContinuousAnchor = null
            if (entering && active) this.#continuousNavigating = true
            for (const record of this.#views.filter(record => !record.staged))
                record.view.render(this.#beforeRender(getDirection(record.view.document)))
            if (entering && active) this.#queueContinuous(async () => {
                const generation = this.#continuousGeneration
                try {
                    if (!await this.#fillContinuousViewport(active, anchor)) return
                    this.#continuousNavigating = false
                    await this.#scrollToAnchorInRecord(active, anchor, 'anchor')
                } finally {
                    if (generation === this.#continuousGeneration) {
                        this.#continuousNavigating = false
                        this.#scheduleContinuousCheck(0)
                    }
                }
            }).catch(e => console.warn(e))
            else if (active && !this.#continuousNavigating)
                this.#scrollToAnchorInRecord(active, anchor, 'anchor').catch(e => console.warn(e))
            this.#installContinuousObserver()
            this.#scheduleContinuousCheck(0)
            return
        }
        if (!this.#view?.document?.body) return
        const layout = this.#beforeRender(getDirection(this.#view.document))
        this.#view.render(layout)
        this.#scrollToAnchor(this.#anchor)
    }
    #lockSelectionScroll(offset) {
        if (!this.hasAttribute('lock-selection-scroll') || this.scrolled) return
        if (this.#selectionScrollOffset !== null) return
        this.#selectionScrollProp = this.scrollProp
        this.#selectionScrollOffset = typeof offset === 'number'
            ? offset : this.#container[this.#selectionScrollProp]
    }
    #unlockSelectionScroll() {
        this.#selectionScrollOffset = null
        this.#selectionScrollProp = null
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        if (this.scrolled && this.#views.length)
            return this.#continuousContentLength()
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper(viewSize = this.viewSize, forceScrolled = false) {
        if (forceScrolled || this.scrolled) {
            const size = viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const element = this.#container
        const { scrollProp, size } = this
        const generation = this.#continuousGeneration
        if (element[scrollProp] === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            element[scrollProp], offset, 300, easeOutQuad,
            x => {
                if (generation === this.#continuousGeneration) element[scrollProp] = x
            },
        ).then(() => {
            if (generation !== this.#continuousGeneration) return
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            element[scrollProp] = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        if (this.scrolled && this.#views.length) {
            const doc = anchor?.startContainer?.ownerDocument ?? anchor?.ownerDocument
            const record = doc
                ? this.#views.find(record => !record.staged && record.view.document === doc)
                : this.#getActiveViewRecord()
            if (record) return this.#scrollToAnchorInRecord(record, anchor, reason)
            return
        }
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        if (this.scrolled && this.#views.length) return this.#afterContinuousScroll(reason)
        if (!this.#view) return
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    reportLocation() {
        if (this.scrolled) this.#afterContinuousScroll('scroll')
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goToContinuous({ index, anchor, select }) {
        if (!this.#canGoToIndex(index)) return
        this.#invalidateContinuous()
        const generation = this.#continuousGeneration
        this.#locked = true
        this.#continuousNavigating = true
        try {
            this.#clearContinuousViews()
            this.#ensureContinuousSentinels()
            const record = await this.#appendContinuous(index)
            if (!record || generation !== this.#continuousGeneration) return
            const target = (typeof anchor === 'function' ? anchor(record.view.document) : anchor) ?? 0
            // Without enough content below the CFI the browser clamps the
            // initial scroll offset. Fill the visible area before publishing
            // the position; the larger preload buffer can load afterwards.
            if (!await this.#fillContinuousViewport(record, target)) return
            if (generation !== this.#continuousGeneration) return
            this.#view = record.view
            this.#index = record.index
            this.#installContinuousObserver()
            this.#continuousNavigating = false
            await this.#scrollToAnchorInRecord(record, target,
                select ? 'selection' : 'navigation')
        } finally {
            if (generation === this.#continuousGeneration) {
                this.#continuousNavigating = false
                this.#locked = false
                this.#scheduleContinuousCheck(0)
            }
        }
    }
    async #goTo({ index, anchor, select}) {
        if (this.scrolled) return this.#goToContinuous({ index, anchor, select })
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked && !this.scrolled) return
        const request = ++this.#navigationRequest
        const resolved = await target
        if (request !== this.#navigationRequest) return
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    async #scrollPrev(distance) {
        if (!this.#view) return true
        const generation = this.#continuousGeneration
        if (this.scrolled) {
            if (this.start > 0) {
                await this.#scrollTo(
                    Math.max(0, this.start - (distance ?? this.size)), null, true)
                this.#scheduleContinuousCheck(0)
                return false
            }
            if (this.#views.length) {
                const first = this.#views[0]
                const prev = this.#adjacentIndex(-1, first.index)
                if (prev != null) {
                    const record = await this.#prependContinuous(prev)
                    if (!record || generation !== this.#continuousGeneration) return false
                    await this.#scrollTo(
                        Math.max(0, this.start - (distance ?? this.size)), null, true)
                    return false
                }
            }
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    async #scrollNext(distance) {
        if (!this.#view) return true
        const generation = this.#continuousGeneration
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) {
                await this.#scrollTo(
                    Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
                this.#scheduleContinuousCheck(0)
                return false
            }
            if (this.#views.length) {
                const last = this.#views[this.#views.length - 1]
                const next = this.#adjacentIndex(1, last.index)
                if (next != null) {
                    const record = await this.#appendContinuous(next)
                    if (!record || generation !== this.#continuousGeneration) return false
                    await this.#scrollTo(
                        Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
                    return false
                }
            }
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        if (this.scrolled && this.#views.length) {
            const first = this.#views[0]
            return this.#adjacentIndex(-1, first.index) == null && this.start <= 1
        }
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        if (this.scrolled && this.#views.length) {
            const last = this.#views[this.#views.length - 1]
            return this.#adjacentIndex(1, last.index) == null
                && this.#continuousContentLength() - this.end <= 2
        }
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir, from = this.#index) {
        for (let index = from + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        const generation = this.#continuousGeneration
        this.#locked = true
        try {
            const prev = dir === -1
            const scroll = () => prev ? this.#scrollPrev(distance) : this.#scrollNext(distance)
            // 2026-08-09 — Keep smooth absolute-offset writes in the same queue as
            // continuous iframe insertion, so prepend compensation cannot be overwritten.
            const shouldGo = await (this.scrolled
                ? this.#queueContinuous(scroll)
                : scroll())
            if (generation !== this.#continuousGeneration) return
            if (shouldGo) await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: prev ? () => 1 : () => 0,
            })
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } finally {
            if (generation === this.#continuousGeneration) this.#locked = false
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.scrolled && this.#views.length) return this.#views.map(({ index, view }) => ({
            index,
            overlayer: view.overlayer,
            doc: view.document,
        }))
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    #applyStylesToDocument(doc, styles) {
        if (!doc) return
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles
    }
    setStyles(styles) {
        this.#styles = styles
        if (this.scrolled && this.#views.length) {
            for (const { view } of this.#views) this.#applyStylesToDocument(view.document, styles)
        } else this.#applyStylesToDocument(this.#view?.document, styles)

        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() =>
            this.#view
                ? this.#background.style.background = getBackground(this.#view.document)
                : null)

        // needed because the resize observer doesn't work in Firefox
        if (this.scrolled && this.#views.length) {
            for (const { view } of this.#views)
                view.document?.fonts?.ready?.then(() => view.expand())
        } else {
            const view = this.#view
            view?.document?.fonts?.ready?.then(() => view.expand())
        }
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#navigationRequest++
        this.#invalidateContinuous()
        clearTimeout(this.#continuousCheckTimeout)
        clearTimeout(this.#continuousTrimTimeout)
        clearTimeout(this.#scrollDeltaTimeout)
        if (this.#continuousCheckRAF) {
            cancelAnimationFrame(this.#continuousCheckRAF)
            this.#continuousCheckRAF = 0
        }
        this.#disconnectContinuousObserver()
        this.#observer.unobserve(this.#container)
        for (const record of this.#views.slice()) this.#removeContinuousRecord(record)
        if (this.#view) {
            this.#view.destroy()
            this.sections[this.#index]?.unload?.()
        }
        this.#view = null
        this.#views = []
        this.#topSentinel.remove()
        this.#bottomSentinel.remove()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
