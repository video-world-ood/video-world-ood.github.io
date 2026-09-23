/* ---------------------------------------------------------------------------
 * Entry point.
 *
 * Load index.json once, then one shard per segment the viewer opens. Rendering
 * is a straight function of (shard, view state): every control writes the state
 * and calls render(), rather than reaching into the DOM to patch it. With a
 * grid this sparse, a full rebuild is cheaper to reason about than a diff and
 * fast enough that nobody can tell -- the expensive things are the <video>
 * elements, and those are rented from the pool, not rebuilt.
 * ------------------------------------------------------------------------- */

import { DATA_DIR } from "./config.js";
import { makeLabeller } from "./labels.js";
import { readState, writeState, absoluteUrl, toggleFilter, emptyState } from "./state.js";
import { VideoCell, makeClock } from "./video.js";
import { VideoPool } from "./pool.js";
import { buildModel, renderGrid, axesInShard, systemsInShard } from "./grid.js";
import { Transport } from "./transport.js";
import { SegmentPicker } from "./picker.js";

const $ = (id) => document.getElementById(id);

const el = {
  app: $("app"),
  loading: $("loading"),
  error: $("error"),
  errorText: $("error-text"),
  siteTitle: $("site-title"),
  siteDesc: $("site-desc"),
  search: $("seg-search"),
  dataset: $("seg-dataset"),
  list: $("seg-list"),
  count: $("seg-count"),
  segTitle: $("segment-title"),
  segMeta: $("segment-meta"),
  tabs: $("tabs"),
  tabNote: $("tab-note"),
  filters: $("filters"),
  pinned: $("pinned-strip"),
  pinnedWrap: $("pinned-wrap"),
  gridWrap: $("grid-wrap"),
  empty: $("empty"),
  play: $("t-play"),
  pause: $("t-pause"),
  restart: $("t-restart"),
  scrub: $("t-scrub"),
  time: $("t-time"),
  loop: $("t-loop"),
  budget: $("t-budget"),
  copy: $("copy-link"),
  copyNote: $("copy-note"),
  dialog: $("zoom"),
  dialogVideo: $("zoom-video"),
  dialogTitle: $("zoom-title"),
  dialogClose: $("zoom-close"),
};

let index = null;
let labeller = null;
let picker = null;
let pool = null;
let transport = null;
let state = emptyState();
const clock = makeClock();
const shards = new Map();      // segment id -> parsed shard
let shard = null;              // the one on screen
let cells = [];                // VideoCells in the current render

/* --- boot ---------------------------------------------------------------- */

async function boot() {
  try {
    index = await fetchJson(`${DATA_DIR}/index.json`);
  } catch (err) {
    return fail(`Could not load the index from ${DATA_DIR}/index.json. ${err.message}`);
  }
  if (!index || index.version !== 1) {
    return fail("The index is missing or is a version this page does not understand.");
  }

  labeller = makeLabeller(index);
  applySiteText();

  pool = new VideoPool({
    onChange: (s) => {
      // Say out loud when the budget is binding. A viewer who sees a paused
      // tile needs to know it is a deliberate cap and not a broken clip.
      el.budget.textContent =
        s.candidates > s.live
          ? `${s.live} of ${s.candidates} on-screen clips playing (cap ${s.max}) — scroll to swap`
          : `${s.live} playing`;
      el.budget.classList.toggle("is-capped", s.candidates > s.live);
    },
  });

  transport = new Transport({ clock, pool, els: el });

  picker = new SegmentPicker({
    index,
    labeller,
    els: { search: el.search, dataset: el.dataset, list: el.list, count: el.count },
    onPick: (id) => {
      state.segment = id;
      writeState(state, { push: true });
      openSegment(id);
    },
  });

  wireChrome();

  state = readState();
  picker.setFilters({ query: state.query, dataset: state.dataset });

  el.loading.hidden = true;
  el.app.hidden = false;

  // Landing with no segment on a comparison site should still show a
  // comparison, so the first segment stands in until one is chosen.
  const first = (index.segments || [])[0];
  const wanted = state.segment || (first ? first.id : null);
  if (wanted) {
    state.segment = wanted;
    writeState(state);
    await openSegment(wanted);
  } else {
    el.empty.hidden = false;
  }
}

function applySiteText() {
  const site = index.site || {};
  if (site.title) {
    el.siteTitle.textContent = site.title;
    document.title = site.title;
  }
  if (site.description) el.siteDesc.textContent = site.description;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fail(message) {
  el.loading.hidden = true;
  el.app.hidden = true;
  el.error.hidden = false;
  el.errorText.textContent = message;
}

/* --- segments ------------------------------------------------------------ */

async function openSegment(id) {
  picker.select(id);
  el.empty.hidden = true;

  if (!shards.has(id)) {
    el.gridWrap.setAttribute("aria-busy", "true");
    try {
      shards.set(id, await fetchJson(`${DATA_DIR}/v/${encodeURIComponent(id)}.json`));
    } catch (err) {
      el.gridWrap.removeAttribute("aria-busy");
      transport.reset();
      teardownGrid();
      el.gridWrap.innerHTML =
        `<p class="notice">Could not load this segment (${escapeText(err.message)}).</p>`;
      return;
    }
    el.gridWrap.removeAttribute("aria-busy");
  }

  shard = shards.get(id);
  transport.reset();
  transport.noteDuration(declaredMaxDuration(shard));
  renderFilters();
  render();
}

/**
 * How long this segment's timeline is, according to the build.
 *
 * `max_duration_s` and the per-clip `duration_s` are optional and absent
 * together when the duration cache has not been built, so this returns 0 and
 * the transport falls back to growing the timeline from loadedmetadata. The
 * per-clip maximum is a belt-and-braces path for a shard that somehow carries
 * clip durations without the rolled-up one.
 */
function declaredMaxDuration(s) {
  if (!s) return 0;
  if (Number.isFinite(s.max_duration_s) && s.max_duration_s > 0) return s.max_duration_s;
  let best = 0;
  for (const clip of s.clips || []) {
    if (Number.isFinite(clip.duration_s) && clip.duration_s > best) best = clip.duration_s;
  }
  return best;
}

/* --- filters ------------------------------------------------------------- */

function renderFilters() {
  el.filters.textContent = "";
  if (!shard) return;

  const groups = [];

  // Systems first: it is the dimension people reach for, and it is the one
  // that halves the width of the grid.
  const systems = systemsInShard(index, shard);
  if (systems.length > 1) {
    groups.push({
      axis: "system",
      heading: "System",
      values: systems.map((s) => ({ raw: s.id, text: labeller.system(s.id) })),
    });
  }

  for (const axis of axesInShard(index, shard)) {
    // Only values this segment actually has, in the order index.axis_values
    // declares. A control for a value with no clip behind it is noise.
    const present = new Set(
      (shard.clips || [])
        .map((c) => (c.axes || {})[axis])
        .filter((v) => v !== undefined && v !== "")
    );
    const ordered = ((index.axis_values || {})[axis] || []).filter((v) => present.has(v));
    for (const v of present) if (!ordered.includes(v)) ordered.push(v);
    if (ordered.length < 2) continue;
    groups.push({
      axis,
      heading: labeller.axis(axis),
      values: ordered.map((raw) => ({ raw, text: labeller.value(axis, raw) })),
    });
  }

  for (const group of groups) {
    const box = document.createElement("fieldset");
    box.className = "filter-group";

    const legend = document.createElement("legend");
    legend.textContent = group.heading;
    box.appendChild(legend);

    for (const { raw, text } of group.values) {
      const label = document.createElement("label");
      label.className = "filter-opt";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = raw;
      const selected = state.filters.get(group.axis);
      // No filter for an axis means everything shows, so every box reads as
      // ticked. Unticking the first one is what creates the filter.
      input.checked = !selected || !selected.size || selected.has(raw);
      input.addEventListener("change", () => {
        onFilterToggle(group, raw, input.checked);
      });
      label.appendChild(input);
      const span = document.createElement("span");
      span.textContent = text;
      label.appendChild(span);
      box.appendChild(label);
    }

    const all = document.createElement("button");
    all.type = "button";
    all.className = "filter-reset";
    all.textContent = "All";
    all.addEventListener("click", () => {
      state.filters.delete(group.axis);
      writeState(state);
      renderFilters();
      render();
    });
    box.appendChild(all);

    el.filters.appendChild(box);
  }
}

function onFilterToggle(group, raw, checked) {
  const existing = state.filters.get(group.axis);
  if (!existing || !existing.size) {
    // First interaction with this axis: "all" becomes an explicit set of
    // everything, minus the box just cleared.
    const all = new Set(group.values.map((v) => v.raw));
    if (!checked) all.delete(raw);
    state.filters.set(group.axis, all);
  } else {
    toggleFilter(state, group.axis, raw, checked);
  }
  // An empty selection would show an empty grid, which reads as a bug. Treat
  // "nothing ticked" as "no filter" and re-tick the boxes.
  const now = state.filters.get(group.axis);
  if (now && now.size === 0) state.filters.delete(group.axis);

  writeState(state);
  renderFilters();
  render();
}

/* --- rendering ----------------------------------------------------------- */

function teardownGrid() {
  if (pool) pool.clear();
  for (const cell of cells) cell.destroy();
  cells = [];
  el.gridWrap.textContent = "";
  el.pinned.textContent = "";
  // Hide the heading too, or a failed load leaves an empty "Reference"
  // section behind from the segment before it.
  el.pinnedWrap.hidden = true;
}

function videoUrl(clip) {
  // index.video_base is expected to end in "/", but a build that forgets it
  // should not produce a page of broken clips.
  const base = index.video_base || "";
  const sep = base && !base.endsWith("/") ? "/" : "";
  return base + sep + clip.path;
}

/** "Cinematic prompt · Baseline · Run 1" -- the clip's own configuration. */
function axesSummary(clip) {
  return Object.entries(clip.axes || {})
    .map(([a, v]) => labeller.value(a, v))
    .join(" · ");
}

function makeCellFor(clip, { pinned = false } = {}) {
  // The caption carries the clip's AXES, not its system name. The column
  // header already says which system it is, so repeating that wasted the only
  // line of per-cell text; with declared rows, what a reader cannot otherwise
  // recover is which exact run landed in this cell -- several configurations
  // can legitimately satisfy the same row.
  const title = pinned ? labeller.role(clip.role) : axesSummary(clip) || labeller.system(clip.system);
  const subtitle = pinned
    ? ""
    : Object.entries(clip.axes || {})
        .map(([a, v]) => `${labeller.axis(a)}: ${labeller.value(a, v)}`)
        .join(" · ");

  const cell = new VideoCell({
    url: videoUrl(clip),
    title,
    subtitle,
    role: clip.role,
    pinned,
    duration: clip.duration_s,
    clock,
    onReady: (c) => transport.noteDuration(c.duration),
    onEnded: () => transport.noteCellEnded(),
    onEnlarge: (c) => openZoom(c, title, subtitle),
    onWantSlot: (c) => pool.request(c),
  });
  cells.push(cell);
  pool.add(cell);
  return cell.el;
}

function render() {
  teardownGrid();
  if (!shard) return;

  const model = buildModel(index, shard, state);

  // Header.
  el.segTitle.textContent = shard.id;
  const hidden = model.totalCount - model.keptCount;
  const bits = [
    labeller.dataset(shard.dataset),
    `${model.keptCount} of ${model.totalCount} generated clips`,
  ];
  if (hidden > 0) bits.push(`${hidden} hidden by filters`);
  // A clip whose `rows` list is empty matches no declared row and so has no
  // cell. Say so rather than dropping it silently -- it is published data that
  // this view cannot show.
  if (model.unrowed > 0) bits.push(`${model.unrowed} outside any row section`);
  el.segMeta.textContent = bits.join(" · ");

  // Context / ground truth, pinned above the grid. They are the reference the
  // whole page is judged against, so they are never inside the scrolling body
  // and never compete for a slot in the pool.
  el.pinnedWrap.hidden = model.pinned.length === 0;
  for (const clip of model.pinned) {
    el.pinned.appendChild(makeCellFor(clip, { pinned: true }));
  }

  // Tabs. One per declared row section, and only ever one section rendered:
  // the three comparisons have different column sets and different questions,
  // so showing them at once made the page one very long scroll in which the
  // model names were almost always off screen.
  const active = renderTabs(model);
  const shown = active ? model.sections.filter((s) => s.id === active) : model.sections;

  if (!shown.length) {
    el.gridWrap.innerHTML =
      '<p class="notice">No generated clips match the current filters.</p>';
  } else {
    renderGrid({
      container: el.gridWrap,
      model,
      labeller,
      cellFactory: (clip) => makeCellFor(clip),
      // The tab strip names the section and prints its note, so the in-grid
      // heading would only be a second copy taking height off the videos.
      showHeads: !active,
      sections: shown,
    });
  }

  pool.schedule();
}

/* --- tabs ---------------------------------------------------------------- */

/**
 * Draw the tab strip and return the id of the section to render.
 *
 * Returns null when tabs do not apply -- the derived-axes fallback model has a
 * single unnamed section, and a one-tab strip named after nothing is worse
 * than no strip. `state.tab` is honoured when it names a section this segment
 * actually has, so a shared link opens on the comparison it was made from and
 * a link to a tab that a later filter removed still opens on something.
 */
function renderTabs(model) {
  const named = model.sections.filter((s) => s.label);
  el.tabs.textContent = "";
  if (named.length < 2) {
    el.tabs.hidden = true;
    el.tabNote.hidden = true;
    el.tabNote.textContent = "";
    return null;
  }

  const ids = named.map((s) => s.id);
  const active = ids.includes(state.tab) ? state.tab : ids[0];
  // Normalise the address bar onto the tab actually on screen, so "Copy link"
  // never hands on a tab id that this page fell back from.
  if (state.tab !== active) {
    state.tab = active;
    writeState(state);
  }

  for (const section of named) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.setAttribute("role", "tab");
    btn.textContent = section.label;
    const on = section.id === active;
    btn.setAttribute("aria-selected", on ? "true" : "false");
    if (on) btn.classList.add("is-active");
    btn.addEventListener("click", () => {
      if (state.tab === section.id) return;
      state.tab = section.id;
      writeState(state);
      render();
      // A tab is a change of what you are looking at, not of where you are in
      // it: start the new grid at the top rather than wherever the last one
      // happened to be scrolled to.
      const scroller = el.gridWrap.querySelector(".grid-wrap");
      if (scroller) scroller.scrollTop = 0;
    });
    el.tabs.appendChild(btn);
  }
  el.tabs.hidden = false;

  const note = (named.find((s) => s.id === active) || {}).note || "";
  el.tabNote.textContent = note;
  el.tabNote.hidden = !note;

  return active;
}

/* --- enlarge ------------------------------------------------------------- */

function openZoom(cell, title, subtitle) {
  el.dialogTitle.textContent = subtitle ? `${title} — ${subtitle}` : title;
  const v = el.dialogVideo;
  v.src = cell.url;
  v.currentTime = 0;
  v.muted = true;
  v.loop = clock.loop;
  if (typeof el.dialog.showModal === "function") el.dialog.showModal();
  else el.dialog.setAttribute("open", "");
  v.addEventListener(
    "loadedmetadata",
    () => {
      v.currentTime = Math.min(clock.time, Math.max(0, v.duration - 0.02));
      if (clock.playing) void v.play().catch(() => {});
    },
    { once: true }
  );
}

function closeZoom() {
  const v = el.dialogVideo;
  try {
    v.pause();
    v.removeAttribute("src");
    v.load();   // release the extra decoder slot the dialog borrowed
  } catch { /* best effort */ }
  if (typeof el.dialog.close === "function" && el.dialog.open) el.dialog.close();
  else el.dialog.removeAttribute("open");
}

/* --- chrome -------------------------------------------------------------- */

function wireChrome() {
  el.copy.addEventListener("click", async () => {
    const url = absoluteUrl(state);
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // The Clipboard API needs a secure context, which a plain http:// static
      // server is not; execCommand needs user activation, which some browsers
      // refuse to grant here. Either way, fall back rather than leave the
      // button doing nothing.
      ok = legacyCopy(url);
    }
    showCopyResult(ok, url);
  });

  el.dialogClose.addEventListener("click", closeZoom);
  el.dialog.addEventListener("close", closeZoom);
  el.dialog.addEventListener("click", (e) => {
    if (e.target === el.dialog) closeZoom();   // click on the backdrop
  });

  // Keep the URL and the page in step when someone uses the back button.
  window.addEventListener("popstate", () => {
    state = readState();
    picker.setFilters({ query: state.query, dataset: state.dataset });
    if (state.segment) openSegment(state.segment);
  });

  el.search.addEventListener("input", () => {
    state.query = el.search.value;
    writeState(state);
  });
  el.dataset.addEventListener("change", () => {
    state.dataset = el.dataset.value;
    writeState(state);
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " ") {
      e.preventDefault();
      clock.playing ? transport.pause() : transport.play();
    } else if (e.key === "r" || e.key === "R") {
      transport.restart();
    }
  });
}

/**
 * Report the outcome of the copy button.
 *
 * When copying failed, put the URL in a focused, pre-selected input instead of
 * telling the viewer to press Ctrl+C with nothing selected -- an instruction
 * that does not work is worse than no instruction.
 */
function showCopyResult(ok, url) {
  el.copyNote.textContent = "";
  if (ok) {
    el.copyNote.textContent = "Link copied";
    el.copyNote.hidden = false;
    setTimeout(() => { el.copyNote.hidden = true; }, 2200);
    return;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.className = "copy-fallback";
  input.value = url;
  el.copyNote.appendChild(input);
  el.copyNote.hidden = false;
  input.focus();
  input.select();
}

function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

boot();
