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

import { DATA_DIR } from "./config.js?v=8963beab725f";
import { makeLabeller } from "./labels.js?v=8963beab725f";
import { readState, writeState, absoluteUrl, toggleFilter, emptyState } from "./state.js?v=8963beab725f";
import { VideoCell, makeClock } from "./video.js?v=8963beab725f";
import { VideoPool } from "./pool.js?v=8963beab725f";
import { buildModel, renderGrid, axesInShard, systemsInShard, showableClips } from "./grid.js?v=8963beab725f";
import { Transport } from "./transport.js?v=8963beab725f";
import { SegmentPicker } from "./picker.js?v=8963beab725f";

const $ = (id) => document.getElementById(id);

const el = {
  app: $("app"),
  loading: $("loading"),
  error: $("error"),
  errorText: $("error-text"),
  siteTitle: $("site-title"),
  siteDesc: $("site-desc"),
  toggleSidebar: $("toggle-sidebar"),
  openHelp: $("open-help"),
  helpDialog: $("help-dialog"),
  helpClose: $("help-close"),
  search: $("seg-search"),
  dataset: $("seg-dataset"),
  list: $("seg-list"),
  count: $("seg-count"),
  segPrev: $("seg-prev"),
  segNext: $("seg-next"),
  segRand: $("seg-rand"),
  segTitle: $("segment-title"),
  segMeta: $("segment-meta"),
  segNote: $("segbar-note"),
  tabbar: $("tabbar"),
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
  stepBack: $("t-step-back"),
  stepFwd: $("t-step-fwd"),
  pnrBtn: $("t-pnr"),
  pnrLabel: $("t-pnr-label"),
  pnrMark: $("t-pnr-mark"),
  scrub: $("t-scrub"),
  time: $("t-time"),
  speed: $("t-speed"),
  loop: $("t-loop"),
  budget: $("t-budget"),
  copy: $("copy-link"),
  copyNote: $("copy-note"),
  dialog: $("zoom"),
  dialogStage: $("zoom-stage"),
  dialogRefPane: $("zoom-ref-pane"),
  dialogRefVideo: $("zoom-ref-video"),
  dialogMainPill: $("zoom-main-pill"),
  dialogVideo: $("zoom-video"),
  dialogTitle: $("zoom-title"),
  dialogNav: $("zoom-nav"),
  dialogPos: $("zoom-pos"),
  dialogPrev: $("zoom-prev"),
  dialogNext: $("zoom-next"),
  dialogCompare: $("zoom-compare"),
  dialogSpeed: $("zoom-speed"),
  dialogClose: $("zoom-close"),
  dialogTransport: $("zoom-transport"),
  ztPlay: $("zt-play"),
  ztPause: $("zt-pause"),
  ztRestart: $("zt-restart"),
  ztPnr: $("zt-pnr"),
  ztScrub: $("zt-scrub"),
  ztTime: $("zt-time"),
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
let generatedCells = [];       // generated cells in reading order, for zoom stepping
let groundtruthClip = null;    // current segment's real continuation clip, if any
let filterGroups = [];         // filter menus currently on screen
let resizeObserver = null;

// Zoom modal state (including side-by-side comparison against Real continuation).
let zoomActiveCell = null;
let zoomIndex = -1;
let zoomComparing = false;
let zoomScrubbing = false;
let zoomTimer = null;

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
          ? `${s.live}/${s.candidates} live (cap ${s.max})`
          : "";
      el.budget.title =
        s.candidates > s.live
          ? `${s.live} of ${s.candidates} on-screen clips playing (browser cap ${s.max}) — scroll or click a tile to swap`
          : `${s.live} clips live`;
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
  groundtruthClip = (shard.clips || []).find((c) => c.role === "groundtruth") || null;

  // Before the first paint, so a segment seen earlier comes back in its own
  // shape rather than snapping into it once a clip has loaded.
  applyAspect(id);
  transport.reset();
  transport.noteDuration(declaredMaxDuration(shard));

  const ctxClip = (shard.clips || []).find((c) => c.role === "context");
  if (ctxClip && Number.isFinite(ctxClip.duration_s) && ctxClip.duration_s > 0) {
    transport.setPnr(ctxClip.duration_s);
  }

  renderFilters();
  render();
}

/**
 * How long this segment's timeline is, according to the build.
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

/**
 * Use semantic Model + Task filters whenever the index declares a single
 * cross-model section (so heterogeneous raw axes like closed `setting` vs open
 * `conditioning` never split a row asymmetrically). Multi-section or fallback
 * indices keep the raw-axis filters as well.
 */
function isSingleSemanticSection() {
  const sections = index && Array.isArray(index.row_sections) ? index.row_sections : [];
  return sections.length === 1 && Array.isArray(sections[0].rows) && sections[0].rows.length > 0;
}

function renderFilters() {
  el.filters.textContent = "";
  filterGroups = [];
  if (!shard) return;

  const groups = [];

  // 1. Models (systems) -- with family metadata for Closed / Open presets.
  const systems = systemsInShard(index, shard);
  if (systems.length > 1) {
    groups.push({
      axis: "system",
      heading: "Models",
      values: systems.map((s) => ({
        raw: s.id,
        text: labeller.system(s.id),
        family: s.family || "",
      })),
    });
  }

  // 2. Semantic Task rows (Zero-shot, Detection-conditioned, ...) when using
  // declared sections. Avoids the raw-axis split between `setting` and
  // `conditioning`, and avoids the redundant `variant` alias.
  if (isSingleSemanticSection()) {
    const sec = index.row_sections[0];
    if (sec.rows.length > 1) {
      groups.push({
        axis: "row",
        heading: "Task",
        values: sec.rows.map((r) => ({ raw: r.id, text: r.label })),
      });
    }
  } else {
    for (const axis of axesInShard(index, shard)) {
      const present = new Set(
        showableClips(shard)
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
  }

  filterGroups = groups;

  for (const group of groups) {
    const menu = document.createElement("details");
    menu.className = "filter-menu";
    menu.dataset.axis = group.axis;

    const sum = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "filter-name";
    name.textContent = group.heading;
    sum.appendChild(name);
    const st = document.createElement("span");
    st.className = "filter-state";
    sum.appendChild(st);
    menu.appendChild(sum);

    const pop = document.createElement("div");
    pop.className = "filter-pop";

    // Quick Closed / Open presets inside the Models filter popover.
    if (group.axis === "system") {
      const closedIds = group.values.filter((v) => v.family === "closed").map((v) => v.raw);
      const openIds = group.values.filter((v) => v.family === "open").map((v) => v.raw);
      if (closedIds.length && openIds.length) {
        const presets = document.createElement("div");
        presets.className = "filter-presets";
        const mkPreset = (label, ids) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "filter-preset-btn";
          b.textContent = label;
          b.addEventListener("click", () => {
            if (!ids) state.filters.delete("system");
            else state.filters.set("system", new Set(ids));
            writeState(state);
            syncFilters();
            render();
          });
          return b;
        };
        presets.appendChild(mkPreset("All", null));
        presets.appendChild(mkPreset("Closed API", closedIds));
        presets.appendChild(mkPreset("Open weights", openIds));
        pop.appendChild(presets);
      }
    }

    for (const { raw, text, family } of group.values) {
      const label = document.createElement("label");
      label.className = "filter-opt";
      if (family) label.classList.add("family-" + family);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = raw;
      const selected = state.filters.get(group.axis);
      input.checked = !selected || !selected.size || selected.has(raw);
      input.addEventListener("change", () => {
        onFilterToggle(group, raw, input.checked);
      });
      label.appendChild(input);
      const span = document.createElement("span");
      span.textContent = text;
      label.appendChild(span);
      pop.appendChild(label);
    }

    const all = document.createElement("button");
    all.type = "button";
    all.className = "filter-reset";
    all.textContent = "Show all";
    all.addEventListener("click", () => {
      state.filters.delete(group.axis);
      writeState(state);
      syncFilters();
      render();
    });
    pop.appendChild(all);
    menu.appendChild(pop);

    menu.addEventListener("toggle", () => {
      if (!menu.open || !menu.isConnected) return;
      for (const other of el.filters.querySelectorAll("details.filter-menu[open]")) {
        if (other !== menu) other.open = false;
      }
    });

    el.filters.appendChild(menu);
  }
  syncFilters();
}

function syncFilters() {
  for (const menu of el.filters.querySelectorAll("details.filter-menu")) {
    const group = filterGroups.find((g) => g.axis === menu.dataset.axis);
    if (!group) continue;
    const selected = state.filters.get(group.axis);
    const shown = !selected || !selected.size
      ? group.values.length
      : group.values.filter((v) => selected.has(v.raw)).length;
    const narrowed = shown !== group.values.length;

    menu.classList.toggle("is-narrowed", narrowed);
    menu.querySelector(".filter-state").textContent =
      narrowed ? `${shown}/${group.values.length}` : "all";
    menu.querySelector("summary").title = narrowed
      ? `${group.heading}: showing ${shown} of ${group.values.length}. Open to change, or Show all.`
      : `${group.heading}: all ${group.values.length} shown. Open to narrow.`;

    for (const input of menu.querySelectorAll(".filter-opt input")) {
      input.checked = !selected || !selected.size || selected.has(input.value);
    }
  }
}

function onFilterToggle(group, raw, checked) {
  const existing = state.filters.get(group.axis);
  if (!existing || !existing.size) {
    const all = new Set(group.values.map((v) => v.raw));
    if (!checked) all.delete(raw);
    state.filters.set(group.axis, all);
  } else {
    toggleFilter(state, group.axis, raw, checked);
  }
  const now = state.filters.get(group.axis);
  if (now && now.size === 0) state.filters.delete(group.axis);

  writeState(state);
  syncFilters();
  render();
}

/* --- rendering ----------------------------------------------------------- */

function teardownGrid() {
  if (pool) pool.clear();
  for (const cell of cells) cell.destroy();
  cells = [];
  generatedCells = [];
  el.gridWrap.textContent = "";
  el.pinned.textContent = "";
  el.pinnedWrap.hidden = true;
}

function videoUrl(clip) {
  const base = index.video_base || "";
  const sep = base && !base.endsWith("/") ? "/" : "";
  return base + sep + clip.path;
}

/**
 * Concise single-line caption for a grid cell.
 * Drops constant single-value `iteration` ("Run 1") and avoids echoing the row
 * label verbatim, keeping the complete configuration in the hover tooltip.
 */
function conciseCaption(clip, ctx) {
  const axes = clip.axes || {};
  const singleIter = ((index.axis_values || {}).iteration || []).length <= 1;

  // For closed models whose only axis (`setting`) matches the row label,
  // say how the model was prompted rather than repeating the row title.
  if (ctx && ctx.column && ctx.column.family === "closed") {
    return "Direct prompt";
  }

  const parts = [];
  for (const [a, v] of Object.entries(axes)) {
    if (a === "iteration" && singleIter) continue;
    // The row label already conveys Baseline vs Detection-conditioned in the
    // cross-model table; highlight the method stack cleanly on one line.
    if (ctx && ctx.row && a === "conditioning" && isSingleSemanticSection()) continue;
    parts.push(labeller.value(a, v));
  }
  if (parts.length) return parts.join(" · ");
  return Object.entries(axes)
    .filter(([a]) => !(a === "iteration" && singleIter))
    .map(([a, v]) => labeller.value(a, v))
    .join(" · ") || labeller.system(clip.system);
}

function makeCellFor(clip, { pinned = false, ctx = null } = {}) {
  const title = pinned ? labeller.role(clip.role) : conciseCaption(clip, ctx);
  const fullAxes = Object.entries(clip.axes || {})
    .map(([a, v]) => `${labeller.axis(a)}: ${labeller.value(a, v)}`)
    .join(" · ");
  const modelName = clip.system ? labeller.system(clip.system) : labeller.role(clip.role);
  const rowName = ctx && ctx.row && ctx.row.label ? ctx.row.label : "";
  const zoomTitle = pinned
    ? labeller.role(clip.role)
    : [modelName, rowName].filter(Boolean).join(" · ");
  const subtitle = pinned ? "" : [zoomTitle, fullAxes].filter(Boolean).join(" — ");

  const cell = new VideoCell({
    url: videoUrl(clip),
    title,
    subtitle,
    role: clip.role,
    pinned,
    duration: clip.duration_s,
    showProgress: true,
    meta: { clip, modelName, rowName, zoomTitle, fullAxes },
    clock,
    onReady: (c) => {
      transport.noteDuration(c.duration);
      if (c.role === "context" && c.duration > 0) transport.setPnr(c.duration);
      noteAspect(c);
    },
    onEnded: () => transport.noteCellEnded(),
    onEnlarge: (c) => openZoom(c),
    onWantSlot: (c) => pool.request(c),
  });
  cells.push(cell);
  if (!pinned) generatedCells.push(cell);
  pool.add(cell);
  return cell.el;
}

function render() {
  teardownGrid();
  if (!shard) return;

  const model = buildModel(index, shard, state);

  // Header: clean, honest counts about what is actually in this comparison.
  el.segTitle.textContent = shard.id;
  const dsLabel = labeller.dataset(shard.dataset);
  const active = renderTabs(model);
  const shown = active ? model.sections.filter((s) => s.id === active) : model.sections;

  if (model.kind === "sections" && shown.length === 1) {
    const sec = shown[0];
    const nShown = model.sectionClipCount;
    const nTotal = model.sectionTotalCount;
    const shape = `${sec.rows.length} task${sec.rows.length === 1 ? "" : "s"} × ${sec.columns.length} model${sec.columns.length === 1 ? "" : "s"}`;
    const countText = nShown < nTotal
      ? `${nShown} of ${nTotal} clips (${shape})`
      : `${nShown} clips (${shape})`;
    el.segMeta.textContent = `${dsLabel} · ${countText}`;
  } else {
    const bits = [dsLabel, `${model.keptCount} of ${model.totalCount} clips`];
    el.segMeta.textContent = bits.join(" · ");
  }

  // When there is a single section (no tab bar), surface its note neatly on
  // the segment bar instead of rendering a redundant .section-head row.
  const singleNote = !active && shown.length === 1 ? (shown[0].note || "") : "";
  el.segNote.textContent = singleNote;
  el.segNote.hidden = !singleNote;
  if (singleNote) el.segNote.title = singleNote;
  else el.segNote.removeAttribute("title");

  // Context / ground truth, pinned in the reference rail.
  el.pinnedWrap.hidden = model.pinned.length === 0;
  for (const clip of model.pinned) {
    el.pinned.appendChild(makeCellFor(clip, { pinned: true }));
  }

  if (!shown.length) {
    el.gridWrap.innerHTML =
      '<p class="notice">No generated clips match the current filters.</p>';
  } else {
    renderGrid({
      container: el.gridWrap,
      model,
      labeller,
      cellFactory: (clip, ctx) => makeCellFor(clip, { ctx }),
      // Single section puts its note in .segbar; multi-section puts it in .tabbar.
      showHeads: false,
      sections: shown,
    });
  }

  fitGrid();
  pool.schedule();
}

/* --- the shape of a clip ------------------------------------------------- */

const aspectVotes = new Map();
let lastAspect = null;

function noteAspect(cell) {
  const v = cell.video;
  if (!v || !v.videoWidth || !v.videoHeight) return;
  if (!shard) return;
  const ratio = Math.round((v.videoWidth / v.videoHeight) * 100) / 100;
  if (!(ratio > 0.1) || ratio > 10) return;
  let votes = aspectVotes.get(shard.id);
  if (!votes) aspectVotes.set(shard.id, (votes = new Map()));
  votes.set(ratio, (votes.get(ratio) || 0) + 1);
  applyAspect(shard.id);
}

function applyAspect(segId) {
  const votes = aspectVotes.get(segId);
  let best = null;
  let most = 0;
  if (votes) {
    for (const [ratio, n] of votes) {
      if (n > most) { most = n; best = ratio; }
    }
  }
  if (best === null) best = lastAspect;
  if (best === null) return;
  lastAspect = best;
  const now = document.body.style.getPropertyValue("--cell-ar");
  if (now === String(best)) return;
  document.body.style.setProperty("--cell-ar", String(best));
  scheduleFit();
}

/* --- fitting the grid to the window ------------------------------------- */

const FIT_MQ = window.matchMedia("(min-width: 1081px)");

function fitGrid() {
  const grid = el.gridWrap.querySelector(".grid-wrap .grid");
  const rows = grid ? Number(grid.dataset.rows || 0) : 0;
  if (!grid || !rows || !FIT_MQ.matches) {
    if (grid) grid.style.removeProperty("--frame-max-h");
    return;
  }

  const scroller = grid.parentElement;
  const styles = getComputedStyle(grid);
  const gap = parseFloat(styles.rowGap) || 0;
  const head = grid.querySelector(".grid-colhead");
  const headH = head ? head.getBoundingClientRect().height : 0;

  // Measure the TALLEST caption bar in the grid, not just the first cell:
  // measuring a 1-line PixVerse bar when another column wraps to 2 lines
  // overestimates the vertical budget and causes a tiny scrollbar.
  let barH = 26;
  for (const b of grid.querySelectorAll(".cell-bar")) {
    const h = b.getBoundingClientRect().height;
    if (h > barH) barH = h;
  }

  const padBottom = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
  const budget = scroller.clientHeight - padBottom - headH - gap * rows - rows * barH - 6;
  grid.style.setProperty("--frame-max-h", `${Math.max(96, Math.floor(budget / rows))}px`);
}

let fitPending = false;
function scheduleFit() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    fitGrid();
  });
}

/* --- tabs ---------------------------------------------------------------- */

function renderTabs(model) {
  const named = model.sections.filter((s) => s.label);
  el.tabs.textContent = "";
  if (named.length < 2) {
    el.tabbar.hidden = true;
    el.tabs.hidden = true;
    el.tabNote.hidden = true;
    el.tabNote.textContent = "";
    el.tabNote.removeAttribute("title");
    return null;
  }

  const ids = named.map((s) => s.id);
  const active = ids.includes(state.tab) ? state.tab : ids[0];
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
      const scroller = el.gridWrap.querySelector(".grid-wrap");
      if (scroller) scroller.scrollTop = 0;
    });
    el.tabs.appendChild(btn);
  }
  el.tabs.hidden = false;
  el.tabbar.hidden = false;

  const note = (named.find((s) => s.id === active) || {}).note || "";
  el.tabNote.textContent = note;
  el.tabNote.hidden = !note;
  if (note) el.tabNote.title = note;
  else el.tabNote.removeAttribute("title");

  return active;
}

/* --- enlarge modal (with side-by-side Compare w/ Real & stepping) -------- */

function formatZoomTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${s.toFixed(1)}s`;
}

function openZoom(cell) {
  zoomActiveCell = cell;
  zoomIndex = generatedCells.indexOf(cell);

  const meta = cell.meta || {};
  const label = meta.zoomTitle || cell.caption.textContent || "Clip";
  const detail = meta.fullAxes ? `${label} — ${meta.fullAxes}` : label;
  el.dialogTitle.textContent = detail;
  el.dialogTitle.title = detail;

  if (el.dialogMainPill) {
    el.dialogMainPill.textContent = label;
  }

  // Prev/Next navigation when opened from a generated grid cell.
  const canStep = zoomIndex !== -1 && generatedCells.length > 1;
  el.dialogNav.hidden = !canStep;
  if (canStep) {
    el.dialogPos.textContent = `${zoomIndex + 1} / ${generatedCells.length}`;
  }

  // Side-by-side comparison available whenever we have a groundtruth clip and
  // the viewer is not already enlarging the groundtruth clip itself.
  const canCompare = !!groundtruthClip && cell.role !== "groundtruth";
  el.dialogCompare.hidden = !canCompare;
  if (!canCompare) zoomComparing = false;

  // Inherit current playback speed.
  const rate = clock.rate || 1;
  el.dialogSpeed.value = String(rate);

  const v = el.dialogVideo;
  v.src = cell.url;
  v.muted = true;
  v.loop = clock.loop;
  v.playbackRate = rate;

  if (!el.dialog.open) {
    if (typeof el.dialog.showModal === "function") el.dialog.showModal();
    else el.dialog.setAttribute("open", "");
  }

  applyZoomCompareMode(zoomComparing, { initialTime: clock.time, autoPlay: clock.playing });
}

function stepZoom(delta) {
  if (zoomIndex === -1 || generatedCells.length < 2) return;
  const next = (zoomIndex + delta + generatedCells.length) % generatedCells.length;
  openZoom(generatedCells[next]);
}

function stopZoomCompareTimer() {
  if (zoomTimer !== null) {
    clearInterval(zoomTimer);
    zoomTimer = null;
  }
}

function applyZoomCompareMode(on, { initialTime = null, autoPlay = null } = {}) {
  zoomComparing = !!on && !!groundtruthClip && zoomActiveCell && zoomActiveCell.role !== "groundtruth";
  el.dialogCompare.setAttribute("aria-pressed", zoomComparing ? "true" : "false");
  el.dialogStage.classList.toggle("is-comparing", zoomComparing);
  el.dialogRefPane.hidden = !zoomComparing;
  el.dialogMainPill.hidden = !zoomComparing;
  el.dialogTransport.hidden = !zoomComparing;

  const mainV = el.dialogVideo;
  const refV = el.dialogRefVideo;
  const rate = parseFloat(el.dialogSpeed.value) || 1;
  const startT = initialTime !== null ? initialTime : (mainV.currentTime || 0);
  const shouldPlay = autoPlay !== null ? autoPlay : !mainV.paused;

  stopZoomCompareTimer();

  if (!zoomComparing) {
    // Release the reference decoder cleanly and hand native controls back.
    try {
      refV.pause();
      refV.removeAttribute("src");
      refV.load();
    } catch { /* best effort */ }
    mainV.controls = true;
    mainV.loop = clock.loop;
    mainV.playbackRate = rate;
    const seekMain = () => {
      if (Number.isFinite(mainV.duration) && mainV.duration > 0) {
        mainV.currentTime = Math.min(startT, Math.max(0, mainV.duration - 0.02));
      }
      if (shouldPlay) void mainV.play().catch(() => {});
    };
    if (mainV.readyState >= 1) seekMain();
    else mainV.addEventListener("loadedmetadata", seekMain, { once: true });
    return;
  }

  // Side-by-side synchronized mode: hide per-video controls and drive both
  // from #zoom-transport.
  mainV.controls = false;
  mainV.loop = false;
  refV.controls = false;
  refV.loop = false;
  refV.muted = true;
  mainV.playbackRate = rate;
  refV.playbackRate = rate;

  const refUrl = videoUrl(groundtruthClip);
  if (refV.getAttribute("src") !== refUrl) {
    refV.src = refUrl;
  }

  el.ztPnr.hidden = !(transport.pnr > 0);
  if (transport.pnr > 0) {
    el.ztPnr.title = `Jump both to continuation start (${formatZoomTime(transport.pnr)})`;
  }

  const syncSeek = (v, t) => {
    const apply = () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      v.currentTime = d > 0 ? Math.min(t, Math.max(0, d - 0.02)) : Math.max(0, t);
      if (shouldPlay) void v.play().catch(() => {});
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
  };
  syncSeek(mainV, startT);
  syncSeek(refV, startT);

  syncZoomTransportUI(shouldPlay);
  zoomTimer = setInterval(tickZoomCompare, 120);
}

function zoomCompareMaxDur() {
  const dm = Number.isFinite(el.dialogVideo.duration) ? el.dialogVideo.duration : 0;
  const dr = Number.isFinite(el.dialogRefVideo.duration) ? el.dialogRefVideo.duration : 0;
  return Math.max(dm, dr);
}

function syncZoomTransportUI(playing) {
  el.ztPlay.hidden = playing;
  el.ztPause.hidden = !playing;
}

function tickZoomCompare() {
  if (!zoomComparing) return;
  const mainV = el.dialogVideo;
  const refV = el.dialogRefVideo;
  const max = zoomCompareMaxDur();
  const leader = (Number.isFinite(mainV.duration) ? mainV.duration : 0) >=
    (Number.isFinite(refV.duration) ? refV.duration : 0) ? mainV : refV;
  const t = leader.currentTime || 0;
  const playing = !mainV.paused || !refV.paused;

  const leaderEnded = leader.ended || (max > 0 && t >= max - 0.05);
  if (playing && (leaderEnded || (mainV.ended && refV.ended))) {
    if (clock.loop) {
      seekZoomBoth(0, true);
      return;
    }
    mainV.pause();
    refV.pause();
    syncZoomTransportUI(false);
  } else {
    syncZoomTransportUI(playing);
  }

  if (!zoomScrubbing && max > 0) {
    const frac = Math.min(1, t / max);
    el.ztScrub.value = String(Math.round(frac * 1000));
    el.ztScrub.style.setProperty("--pos", `${(frac * 100).toFixed(1)}%`);
  }
  el.ztTime.textContent = max > 0 ? `${formatZoomTime(t)} / ${formatZoomTime(max)}` : "–";
}

function seekZoomBoth(t, playAfter = null) {
  const mainV = el.dialogVideo;
  const refV = el.dialogRefVideo;
  const shouldPlay = playAfter !== null ? playAfter : (!mainV.paused || !refV.paused);
  for (const v of [mainV, refV]) {
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const clamped = d > 0 ? Math.min(Math.max(0, t), Math.max(0, d - 0.02)) : Math.max(0, t);
    try { v.currentTime = clamped; } catch { /* ignore pre-metadata */ }
    if (shouldPlay && (d === 0 || t < d - 0.05)) void v.play().catch(() => {});
  }
  const max = zoomCompareMaxDur();
  if (max > 0) {
    const frac = Math.min(1, Math.max(0, t) / max);
    el.ztScrub.value = String(Math.round(frac * 1000));
    el.ztScrub.style.setProperty("--pos", `${(frac * 100).toFixed(1)}%`);
    el.ztTime.textContent = `${formatZoomTime(t)} / ${formatZoomTime(max)}`;
  }
}

function closeZoom() {
  stopZoomCompareTimer();
  zoomActiveCell = null;
  zoomIndex = -1;
  for (const v of [el.dialogVideo, el.dialogRefVideo]) {
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();   // release decoder slots immediately
    } catch { /* best effort */ }
  }
  if (typeof el.dialog.close === "function" && el.dialog.open) el.dialog.close();
  else el.dialog.removeAttribute("open");
}

/* --- light / dark & sidebar state ---------------------------------------- */

const THEME_KEY = "vwood_theme";
const SIDEBAR_KEY = "vwood_sidebar";

function effectiveTheme() {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* storage blocked */ }
  syncThemeButtons();
}

function syncThemeButtons() {
  const now = effectiveTheme();
  const next = now === "dark" ? "light" : "dark";
  for (const b of document.querySelectorAll("[data-theme-toggle]")) {
    b.textContent = next === "dark" ? "☾" : "☀";
    b.title = `Switch to ${next} mode`;
    b.setAttribute("aria-label", `Switch to ${next} mode`);
  }
}

function wireTheme() {
  for (const b of document.querySelectorAll("[data-theme-toggle]")) {
    b.addEventListener("click", () => setTheme(effectiveTheme() === "dark" ? "light" : "dark"));
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (!document.documentElement.hasAttribute("data-theme")) syncThemeButtons();
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
  syncThemeButtons();
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  if (el.toggleSidebar) {
    el.toggleSidebar.setAttribute("aria-expanded", collapsed ? "false" : "true");
    el.toggleSidebar.title = collapsed ? "Show sidebar (B)" : "Hide sidebar (B)";
  }
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch { /* ignore */ }
  scheduleFit();
}

/* --- chrome wiring ------------------------------------------------------- */

function wireChrome() {
  wireTheme();

  // Restore sidebar preference on desktop.
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === "1") setSidebarCollapsed(true);
  } catch { /* ignore */ }

  if (el.toggleSidebar) {
    el.toggleSidebar.addEventListener("click", () => {
      setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
    });
  }

  // Segment navigation buttons.
  if (el.segPrev) el.segPrev.addEventListener("click", () => picker.step(-1));
  if (el.segNext) el.segNext.addEventListener("click", () => picker.step(1));
  if (el.segRand) el.segRand.addEventListener("click", () => picker.random());

  // Help / Guide modal.
  if (el.openHelp && el.helpDialog) {
    el.openHelp.addEventListener("click", () => {
      if (typeof el.helpDialog.showModal === "function") el.helpDialog.showModal();
      else el.helpDialog.setAttribute("open", "");
    });
    el.helpClose.addEventListener("click", () => {
      if (typeof el.helpDialog.close === "function") el.helpDialog.close();
      else el.helpDialog.removeAttribute("open");
    });
    el.helpDialog.addEventListener("click", (e) => {
      if (e.target === el.helpDialog) {
        if (typeof el.helpDialog.close === "function") el.helpDialog.close();
        else el.helpDialog.removeAttribute("open");
      }
    });
  }

  // Observe layout size changes so fitGrid settles cleanly after sidebar
  // toggles, note wraps, or window resizes.
  window.addEventListener("resize", scheduleFit, { passive: true });
  if (FIT_MQ.addEventListener) FIT_MQ.addEventListener("change", scheduleFit);
  else if (FIT_MQ.addListener) FIT_MQ.addListener(scheduleFit);
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(el.gridWrap);
  }

  document.addEventListener("click", (e) => {
    for (const menu of el.filters.querySelectorAll("details.filter-menu[open]")) {
      if (!menu.contains(e.target)) menu.open = false;
    }
  });

  el.copy.addEventListener("click", async () => {
    const url = absoluteUrl(state);
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      ok = legacyCopy(url);
    }
    showCopyResult(ok, url);
  });

  // Zoom modal controls.
  el.dialogClose.addEventListener("click", closeZoom);
  el.dialog.addEventListener("close", closeZoom);
  el.dialog.addEventListener("click", (e) => {
    if (e.target === el.dialog) closeZoom();
  });
  el.dialogPrev.addEventListener("click", () => stepZoom(-1));
  el.dialogNext.addEventListener("click", () => stepZoom(1));
  el.dialogCompare.addEventListener("click", () => {
    applyZoomCompareMode(!zoomComparing);
  });
  el.dialogSpeed.addEventListener("change", () => {
    const rate = parseFloat(el.dialogSpeed.value) || 1;
    el.dialogVideo.playbackRate = rate;
    el.dialogRefVideo.playbackRate = rate;
  });

  // Zoom synchronized transport (when Compare w/ Real is active).
  el.ztPlay.addEventListener("click", () => {
    void el.dialogVideo.play().catch(() => {});
    void el.dialogRefVideo.play().catch(() => {});
    syncZoomTransportUI(true);
  });
  el.ztPause.addEventListener("click", () => {
    el.dialogVideo.pause();
    el.dialogRefVideo.pause();
    syncZoomTransportUI(false);
  });
  el.ztRestart.addEventListener("click", () => seekZoomBoth(0, true));
  el.ztPnr.addEventListener("click", () => {
    if (transport.pnr > 0) seekZoomBoth(transport.pnr);
  });
  el.ztScrub.addEventListener("pointerdown", () => { zoomScrubbing = true; });
  const endZoomScrub = () => { zoomScrubbing = false; };
  el.ztScrub.addEventListener("pointerup", endZoomScrub);
  el.ztScrub.addEventListener("pointercancel", endZoomScrub);
  el.ztScrub.addEventListener("change", endZoomScrub);
  el.ztScrub.addEventListener("input", () => {
    const max = zoomCompareMaxDur();
    const frac = Number(el.ztScrub.value) / 1000;
    seekZoomBoth(frac * max);
  });

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
    if (e.key === "Escape") {
      for (const menu of el.filters.querySelectorAll("details.filter-menu[open]")) {
        menu.open = false;
      }
      return;
    }

    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" ||
              t.tagName === "TEXTAREA" || t.tagName === "SUMMARY")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // When the Enlarge dialog is open, route arrows and Compare shortcut to it.
    if (el.dialog.open) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepZoom(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepZoom(1);
      } else if (e.key === "c" || e.key === "C") {
        if (!el.dialogCompare.hidden) {
          e.preventDefault();
          applyZoomCompareMode(!zoomComparing);
        }
      } else if (e.key === " " && zoomComparing) {
        e.preventDefault();
        const playing = !el.dialogVideo.paused || !el.dialogRefVideo.paused;
        if (playing) {
          el.dialogVideo.pause();
          el.dialogRefVideo.pause();
          syncZoomTransportUI(false);
        } else {
          void el.dialogVideo.play().catch(() => {});
          void el.dialogRefVideo.play().catch(() => {});
          syncZoomTransportUI(true);
        }
      }
      return;
    }

    if (e.key === "?") {
      e.preventDefault();
      if (el.helpDialog.open) el.helpDialog.close();
      else if (typeof el.helpDialog.showModal === "function") el.helpDialog.showModal();
      return;
    }

    if (el.helpDialog && el.helpDialog.open) return;

    if (e.key === " ") {
      e.preventDefault();
      clock.playing ? transport.pause() : transport.play();
    } else if (e.key === "r" || e.key === "R") {
      transport.restart();
    } else if (e.key === "p" || e.key === "P") {
      transport.jumpToPnr();
    } else if (e.key === ",") {
      e.preventDefault();
      transport.stepFrame(-1);
    } else if (e.key === ".") {
      e.preventDefault();
      transport.stepFrame(1);
    } else if (e.key === "[") {
      e.preventDefault();
      picker.step(-1);
    } else if (e.key === "]") {
      e.preventDefault();
      picker.step(1);
    } else if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
    }
  });
}

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
