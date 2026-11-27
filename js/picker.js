/* ---------------------------------------------------------------------------
 * The segment list.
 *
 * ~580 entries, filtered as you type. Two things keep that responsive on a
 * laptop: the match itself is a plain lowercase substring test over a string
 * precomputed once, and at most PICKER_RENDER_CAP rows are ever put in the DOM
 * (the count of the remainder is reported instead). Rebuilding 580 rows per
 * keystroke is visibly janky; rebuilding 200 is not, and nobody scrolls past
 * the first screenful before refining the search anyway.
 *
 * When a deep-linked or stepped segment sits past PICKER_RENDER_CAP, the
 * render window expands just enough to include it so the active row is always
 * visible and scrolled into view.
 * ------------------------------------------------------------------------- */

import { PICKER_RENDER_CAP } from "./config.js?v=8963beab725f";

export class SegmentPicker {
  /**
   * @param {object} opts
   *   index     the parsed index.json
   *   labeller  from makeLabeller()
   *   els       {search, dataset, list, count}
   *   onPick    called with a segment id
   */
  constructor({ index, labeller, els, onPick }) {
    this.labeller = labeller;
    this.els = els;
    this.onPick = onPick;
    this.selected = null;
    this.query = "";
    this.dataset = "";
    this._pending = null;

    // Precomputed haystack: searching it is the hot path, and the id plus the
    // dataset's display name is everything a viewer would plausibly type.
    this.entries = (index.segments || []).map((seg) => ({
      seg,
      haystack: (
        seg.id + " " + labeller.dataset(seg.dataset) + " " + (seg.systems || []).join(" ")
      ).toLowerCase(),
    }));

    // Dataset options come from index.datasets so the labels stay reviewed.
    const ds = els.dataset;
    for (const d of index.datasets || []) {
      const opt = document.createElement("option");
      opt.value = d.id;
      const n = Number.isFinite(d.n_segments) ? ` (${d.n_segments})` : "";
      opt.textContent = labeller.dataset(d.id) + n;
      ds.appendChild(opt);
    }

    els.search.addEventListener("input", () => {
      this.query = els.search.value.trim().toLowerCase();
      this._scheduleRender();
    });
    ds.addEventListener("change", () => {
      this.dataset = ds.value;
      this._scheduleRender();
    });

    // One delegated listener instead of one per row: with 200 rows rebuilt on
    // every keystroke, per-row listeners are pure garbage-collector pressure.
    els.list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-seg]");
      if (row) this.onPick(row.dataset.seg);
    });
  }

  /** Restore the controls from a deep link without firing a re-pick. */
  setFilters({ query = "", dataset = "" }) {
    this.query = query.trim().toLowerCase();
    this.dataset = dataset;
    this.els.search.value = query;
    this.els.dataset.value = dataset;
    this.render();
  }

  select(segmentId) {
    this.selected = segmentId;
    let activeRow = null;
    for (const row of this.els.list.querySelectorAll("[data-seg]")) {
      const hit = row.dataset.seg === segmentId;
      row.classList.toggle("is-selected", hit);
      if (hit) activeRow = row;
    }
    // If the selected segment is outside the rendered cap (e.g. via a deep
    // link or Prev/Next wrap), re-render so it appears in the list.
    if (!activeRow && segmentId && this.render === SegmentPicker.prototype.render) {
      const found = this.matches();
      if (found.some((s) => s.id === segmentId)) {
        this.render();
        activeRow = this.els.list.querySelector(".seg-row.is-selected");
      }
    }
    if (activeRow && typeof activeRow.scrollIntoView === "function") {
      activeRow.scrollIntoView({ block: "nearest" });
    }
  }

  /** Step to the previous (-1) or next (+1) matching segment. */
  step(delta) {
    const found = this.matches();
    if (!found.length) return;
    const idx = found.findIndex((s) => s.id === this.selected);
    const nextIdx = idx === -1
      ? 0
      : (idx + delta + found.length) % found.length;
    this.onPick(found[nextIdx].id);
  }

  /** Pick a random matching segment, avoiding the currently open one. */
  random() {
    const found = this.matches();
    if (!found.length) return;
    if (found.length === 1) {
      this.onPick(found[0].id);
      return;
    }
    let pick = found[Math.floor(Math.random() * found.length)];
    if (pick.id === this.selected) {
      const idx = found.findIndex((s) => s.id === this.selected);
      pick = found[(idx + 1 + Math.floor(Math.random() * (found.length - 1))) % found.length];
    }
    this.onPick(pick.id);
  }

  /** 1-based position of the selected segment in the filtered list. */
  position() {
    const found = this.matches();
    const idx = found.findIndex((s) => s.id === this.selected);
    return { index: idx === -1 ? 0 : idx + 1, total: found.length };
  }

  _scheduleRender() {
    if (this._pending) return;
    this._pending = requestAnimationFrame(() => {
      this._pending = null;
      this.render();
    });
  }

  matches() {
    const q = this.query;
    const ds = this.dataset;
    const out = [];
    for (const entry of this.entries) {
      if (ds && entry.seg.dataset !== ds) continue;
      if (q && !entry.haystack.includes(q)) continue;
      out.push(entry.seg);
    }
    return out;
  }

  render() {
    const found = this.matches();
    let cap = PICKER_RENDER_CAP;
    if (this.selected) {
      const selIdx = found.findIndex((s) => s.id === this.selected);
      if (selIdx >= cap) cap = selIdx + 20;
    }
    const shown = found.slice(0, cap);

    const frag = document.createDocumentFragment();
    for (const seg of shown) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "seg-row";
      row.dataset.seg = seg.id;
      if (seg.id === this.selected) row.classList.add("is-selected");

      const name = document.createElement("span");
      name.className = "seg-id";
      name.textContent = seg.id;
      row.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "seg-meta";
      const nSys = (seg.systems || []).length;
      meta.textContent = `${this.labeller.dataset(seg.dataset)} · ${nSys} model${nSys === 1 ? "" : "s"}`;
      row.appendChild(meta);

      frag.appendChild(row);
    }

    this.els.list.textContent = "";
    this.els.list.appendChild(frag);

    if (!found.length) {
      this.els.count.textContent = "No segments match";
    } else if (found.length > shown.length) {
      this.els.count.textContent = `${shown.length} of ${found.length} shown — refine search`;
    } else {
      this.els.count.textContent = `${found.length} segment${found.length === 1 ? "" : "s"}`;
    }
  }
}
