/* ---------------------------------------------------------------------------
 * The segment list.
 *
 * ~580 entries, filtered as you type. Two things keep that responsive on a
 * laptop: the match itself is a plain lowercase substring test over a string
 * precomputed once, and at most PICKER_RENDER_CAP rows are ever put in the DOM
 * (the count of the remainder is reported instead). Rebuilding 580 rows per
 * keystroke is visibly janky; rebuilding 200 is not, and nobody scrolls past
 * the first screenful before refining the search anyway.
 * ------------------------------------------------------------------------- */

import { PICKER_RENDER_CAP } from "./config.js";

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
    for (const row of this.els.list.querySelectorAll("[data-seg]")) {
      row.classList.toggle("is-selected", row.dataset.seg === segmentId);
    }
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
    const shown = found.slice(0, PICKER_RENDER_CAP);

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
      meta.textContent = `${this.labeller.dataset(seg.dataset)} · ${seg.n_clips} clips · ${nSys} systems`;
      row.appendChild(meta);

      frag.appendChild(row);
    }

    this.els.list.textContent = "";
    this.els.list.appendChild(frag);

    if (!found.length) {
      this.els.count.textContent = "No segments match";
    } else if (found.length > shown.length) {
      this.els.count.textContent = `${shown.length} of ${found.length} shown — refine the search`;
    } else {
      this.els.count.textContent = `${found.length} segment${found.length === 1 ? "" : "s"}`;
    }
  }
}
