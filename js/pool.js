/* ---------------------------------------------------------------------------
 * The concurrency budget for <video> elements.
 *
 * THE performance constraint of this page. A segment carries up to ~33 clips
 * and the viewer wants them playing together, but browsers degrade badly past
 * roughly sixteen live media elements: decoding stops, frames freeze, and in
 * the worst case the tab stops responding. Nothing about that failure is loud
 * -- you just get a page that looks broken.
 *
 * So cells do not own their <video>; they rent one. This pool decides who is
 * holding a slot right now, on two rules:
 *
 *   1. context and ground-truth cells are pinned -- they are the reference
 *      everything else is judged against, so they never lose a slot,
 *   2. everything else is ranked by distance from the centre of the viewport,
 *      because that is a decent proxy for what the viewer is looking at.
 *
 * Cells that lose out are detached completely and show a play affordance. The
 * viewer can press it to force a slot, which evicts the furthest-away cell.
 * That is honest: the alternative is a grid that silently stops working.
 * ------------------------------------------------------------------------- */

import { MAX_LIVE_VIDEOS, ATTACH_MARGIN } from "./config.js";

/** How much of a head start a cell that already holds a slot keeps. */
const HYSTERESIS_PX = 150;

/** Backstop for a rebalance when requestAnimationFrame is not being served. */
const REBALANCE_FALLBACK_MS = 200;

export class VideoPool {
  /**
   * @param {object} opts
   *   onChange {function}     called with {live, candidates, total} after every
   *                           rebalance, so the UI can say what is happening
   */
  constructor(opts = {}) {
    this.max = opts.max || MAX_LIVE_VIDEOS;
    this.onChange = opts.onChange || (() => {});

    this.cells = new Set();
    this.visible = new Set();
    this.attached = new Set();
    // Cells the viewer pressed play on. They outrank proximity until they
    // scroll away, so an explicit request is never silently undone.
    this.forced = new Set();

    this._scheduled = false;
    this._rafId = null;
    this._timerId = null;
    this._rebalance = this._rebalance.bind(this);
    this.schedule = this.schedule.bind(this);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cell = entry.target.__cell;
          if (!cell) continue;
          if (entry.isIntersecting) {
            this.visible.add(cell);
          } else {
            this.visible.delete(cell);
            this.forced.delete(cell);
          }
        }
        this.schedule();
      },
      { root: null, rootMargin: ATTACH_MARGIN, threshold: 0 }
    );

    // IntersectionObserver only fires when a cell crosses the margin, but the
    // *ranking* among already-visible cells changes continuously as you scroll.
    // Without this, scrolling within one screenful would never hand the slot to
    // the cell you just scrolled towards.
    this._onScroll = () => this.schedule();
    window.addEventListener("resize", this._onScroll, { passive: true });
    // Capture phase on the document, because scroll events do NOT bubble and
    // each row section is its own horizontal scroller. One capturing listener
    // catches the page and every section without having to know about them.
    document.addEventListener("scroll", this._onScroll, { passive: true, capture: true });
  }

  /** Register a cell. Its element must already be (or soon be) in the DOM. */
  add(cell) {
    this.cells.add(cell);
    cell.el.__cell = cell;
    this.observer.observe(cell.el);
  }

  /** Drop every cell. Called whenever the grid is rebuilt. */
  clear() {
    for (const cell of this.cells) {
      this.observer.unobserve(cell.el);
      cell.el.__cell = null;
      cell.detach();
    }
    this.cells.clear();
    this.visible.clear();
    this.attached.clear();
    this.forced.clear();
  }

  /** The viewer explicitly asked for this clip. Give it a slot now. */
  request(cell) {
    this.forced.add(cell);
    this.visible.add(cell);
    this.schedule();
  }

  /** Every cell currently holding a <video>. */
  live() {
    return [...this.attached];
  }

  /**
   * Coalesce rebalances to one per frame.
   *
   * A frame callback is the right cadence when the page is being drawn, but
   * requestAnimationFrame is suspended outright for occluded or off-screen
   * windows -- and it happens while visibilityState still reads "visible". On
   * rAF alone the pool would then never attach anything and the page would sit
   * empty. Whichever of the two fires first wins and cancels the other.
   */
  schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    this._rafId = requestAnimationFrame(this._rebalance);
    this._timerId = setTimeout(this._rebalance, REBALANCE_FALLBACK_MS);
  }

  _rebalance() {
    if (!this._scheduled) return;
    this._scheduled = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    if (this._timerId !== null) clearTimeout(this._timerId);
    this._rafId = null;
    this._timerId = null;

    const centre = window.innerHeight / 2;
    const ranked = [];
    for (const cell of this.visible) {
      if (!cell.el.isConnected) continue;
      const rect = cell.el.getBoundingClientRect();
      // Zero-sized means display:none -- a cell hidden by a filter must not
      // hold a slot that a visible cell could use.
      if (rect.width === 0 && rect.height === 0) continue;
      let distance = Math.abs(rect.top + rect.height / 2 - centre);
      // Hysteresis. Without it, a cell can be attached, evicted and reattached
      // inside a few frames as the observer reports the rest of the grid --
      // which shows up as aborted range requests and a visible flicker. An
      // incumbent has to be beaten by a clear margin, not a pixel.
      if (this.attached.has(cell)) distance -= HYSTERESIS_PX;
      ranked.push({ cell, distance });
    }

    ranked.sort((a, b) => {
      const pa = this._priority(a.cell);
      const pb = this._priority(b.cell);
      if (pa !== pb) return pa - pb;
      return a.distance - b.distance;
    });

    const wanted = new Set(ranked.slice(0, this.max).map((r) => r.cell));

    // Detach first, so the slots are actually free before anything claims one.
    for (const cell of [...this.attached]) {
      if (!wanted.has(cell)) {
        cell.detach();
        this.attached.delete(cell);
      }
    }
    for (const cell of wanted) {
      if (!this.attached.has(cell)) {
        cell.attach();
        this.attached.add(cell);
      }
    }

    this.onChange({
      live: this.attached.size,
      candidates: ranked.length,
      total: this.cells.size,
      max: this.max,
    });
  }

  /** Lower sorts earlier, i.e. keeps its slot. */
  _priority(cell) {
    if (cell.pinned) return 0;
    if (this.forced.has(cell)) return 1;
    return 2;
  }

  destroy() {
    this.clear();
    this.observer.disconnect();
    window.removeEventListener("resize", this._onScroll);
    document.removeEventListener("scroll", this._onScroll, { capture: true });
  }
}
