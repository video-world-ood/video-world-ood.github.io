/* ---------------------------------------------------------------------------
 * Turning one shard into a grid.
 *
 * Rows are DECLARED, not derived. `index.row_sections` names each row and the
 * systems it spans, and `clip.rows` says which rows a clip belongs to -- a list,
 * because one run is legitimately several things at once (a Cosmos 3 cinematic
 * baseline is both the zero-shot comparison and the cinematic conditioning row).
 *
 * This replaced an earlier grid that keyed rows on the raw `clip.axes` tuple.
 * That version was honest but unreadable: the systems do not share axes -- the
 * closed models vary only `setting`, the open ones vary conditioning, variant
 * and iteration -- so the tuples never lined up and the matrix came out 77%
 * "Not available" with no good name for any row.
 *
 * The crux of the fix is that EACH SECTION CARRIES ITS OWN COLUMN SET. A
 * section about method components must not show columns for closed API models
 * that have no components to vary; rendering all five systems everywhere is
 * precisely what produced the empty space.
 *
 * `buildSectionModel` is used whenever `row_sections` is present. When it is
 * not -- an index built before the sections landed -- `buildAxisModel` still
 * produces the old derived grid, so a mid-transition deploy degrades to the
 * previous page rather than to a blank one.
 * ------------------------------------------------------------------------- */

import { passes } from "./state.js";

const KEY_SEP = "";

/** Why a cell has no video. Each reads differently to the viewer. */
export const CELL_NONE = "none";        // this system is not part of this row
export const CELL_MISSING = "missing";  // it should have a run, and does not
export const CELL_FILTERED = "filtered";// it has one, hidden by a filter

/** Axis ids in a stable order: the order `index.systems` introduces them. */
export function unionAxes(index) {
  const seen = [];
  for (const sys of index.systems || []) {
    for (const axis of sys.axes || []) {
      if (!seen.includes(axis)) seen.push(axis);
    }
  }
  return seen;
}

/**
 * Which axes does a shard actually use? Filter controls are built from this so
 * a segment that never varied `iteration` does not grow a dead control.
 */
export function axesInShard(index, shard) {
  const order = unionAxes(index);
  const present = new Set();
  for (const clip of shard.clips || []) {
    for (const axis of Object.keys(clip.axes || {})) present.add(axis);
  }
  return order.filter((a) => present.has(a));
}

/** Systems that appear at least once in this shard, in index order. */
export function systemsInShard(index, shard) {
  const present = new Set();
  for (const clip of shard.clips || []) {
    if (clip.system) present.add(clip.system);
  }
  return (index.systems || []).filter((s) => present.has(s.id));
}

/** Context and ground truth, in the order they happened. */
function splitPinned(shard) {
  const pinned = [];
  const generated = [];
  for (const clip of shard.clips || []) {
    // `role` is authoritative; `system: null` is only corroboration, so a
    // reference clip that later gains a system id still pins to the front.
    if (clip.role === "context" || clip.role === "groundtruth") pinned.push(clip);
    else generated.push(clip);
  }
  const ORDER = { context: 0, groundtruth: 1 };
  pinned.sort((a, b) => (ORDER[a.role] ?? 9) - (ORDER[b.role] ?? 9));
  return { pinned, generated };
}

function makeClipFilter(state) {
  return (clip) => {
    if (!passes(state, "system", clip.system)) return false;
    for (const [axis, value] of Object.entries(clip.axes || {})) {
      if (!passes(state, axis, value)) return false;
    }
    return true;
  };
}

/* --- the declared-section model ------------------------------------------ */

export function buildSectionModel(index, shard, state) {
  const { pinned, generated } = splitPinned(shard);
  const clipPasses = makeClipFilter(state);
  const systemsById = new Map((index.systems || []).map((s) => [s.id, s]));

  // Index every generated clip by (row id, system). A LIST, because `rows` is
  // a list and nothing guarantees one clip per cell; if the data ever puts two
  // runs in one cell we show both rather than silently picking one.
  const all = new Map();
  const kept = new Map();
  let unrowed = 0;
  for (const clip of generated) {
    const rows = clip.rows || [];
    if (!rows.length) unrowed += 1;
    for (const rowId of rows) {
      const key = rowId + KEY_SEP + clip.system;
      if (!all.has(key)) all.set(key, []);
      all.get(key).push(clip);
      if (clipPasses(clip)) {
        if (!kept.has(key)) kept.set(key, []);
        kept.get(key).push(clip);
      }
    }
  }

  const sections = [];
  for (const rawSection of index.row_sections || []) {
    // A section's columns are its own declared systems, in index order,
    // narrowed by the system filter.
    const declared = (rawSection.systems || []).filter((id) => passes(state, "system", id));
    const columns = (index.systems || []).filter((s) => declared.includes(s.id));

    const rows = [];
    for (const rawRow of rawSection.rows || []) {
      const rowSystems = new Set(rawRow.systems || []);
      const cells = new Map();
      let keptHere = 0;
      for (const col of columns) {
        const key = rawRow.id + KEY_SEP + col.id;
        const keptClips = kept.get(key) || [];
        const anyClips = all.get(key) || [];
        keptHere += keptClips.length;
        let state_;
        if (keptClips.length) state_ = null;
        else if (anyClips.length) state_ = CELL_FILTERED;
        else if (!rowSystems.has(col.id)) state_ = CELL_NONE;
        else state_ = CELL_MISSING;
        cells.set(col.id, { clips: keptClips, empty: state_ });
      }
      // Every declared row is rendered, including one that is empty right
      // across. The sections ARE the paper's comparison tables, so a row that
      // silently vanished on the segments where a model has no run would make
      // two segments' grids disagree about what was even compared. A missing
      // run is shown as a blank cell instead, which is the honest rendering
      // and the one asked for.
      void keptHere;
      rows.push({ id: rawRow.id, label: rawRow.label, cells });
    }

    if (rows.length && columns.length) {
      sections.push({
        id: rawSection.id,
        label: rawSection.label,
        note: rawSection.note,
        columns,
        rows,
      });
    }
  }

  const keptTotal = generated.filter(clipPasses).length;
  let cellCount = 0;
  let filledCount = 0;
  for (const s of sections) {
    for (const r of s.rows) {
      for (const cell of r.cells.values()) {
        cellCount += 1;
        if (cell.clips.length) filledCount += 1;
      }
    }
  }

  return {
    kind: "sections",
    pinned,
    sections,
    unrowed,
    keptCount: keptTotal,
    totalCount: generated.length,
    cellCount,
    filledCount,
    systemsById,
  };
}

/* --- the derived-axes model, kept as a fallback --------------------------- */

function rowKeyFor(axes, axisOrder) {
  return axisOrder.map((a) => (axes && axes[a] !== undefined ? axes[a] : "")).join(KEY_SEP);
}

function valueRank(index, axis, value) {
  if (value === undefined || value === "") return -1;
  const values = (index.axis_values || {})[axis] || [];
  const i = values.indexOf(value);
  return i === -1 ? values.length : i;
}

export function buildAxisModel(index, shard, state) {
  const axisOrder = unionAxes(index);
  const { pinned, generated } = splitPinned(shard);
  const clipPasses = makeClipFilter(state);

  const rows = new Map();
  const systemIndex = new Map((index.systems || []).map((s, i) => [s.id, i]));
  for (const clip of generated) {
    const key = rowKeyFor(clip.axes, axisOrder);
    let row = rows.get(key);
    if (!row) {
      row = { key, axes: { ...(clip.axes || {}) }, systemRank: Infinity };
      rows.set(key, row);
    }
    row.systemRank = Math.min(row.systemRank, systemIndex.get(clip.system) ?? Infinity);
  }

  const kept = generated.filter(clipPasses);
  const keptRowKeys = new Set(kept.map((c) => rowKeyFor(c.axes, axisOrder)));
  const rowList = [...rows.values()]
    .filter((r) => keptRowKeys.has(r.key))
    .sort((a, b) => {
      if (a.systemRank !== b.systemRank) return a.systemRank - b.systemRank;
      for (const axis of axisOrder) {
        const d = valueRank(index, axis, a.axes[axis]) - valueRank(index, axis, b.axes[axis]);
        if (d !== 0) return d;
      }
      return a.key < b.key ? -1 : 1;
    });

  const cells = new Map();
  for (const clip of kept) {
    const k = rowKeyFor(clip.axes, axisOrder) + KEY_SEP + clip.system;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(clip);
  }

  const columns = systemsInShard(index, shard)
    .filter((s) => passes(state, "system", s.id))
    .filter((s) => kept.some((c) => c.system === s.id));

  // Re-expressed as one unnamed section so the renderer has a single shape.
  const rowsOut = rowList.map((r) => {
    const cellMap = new Map();
    for (const col of columns) {
      const got = cells.get(r.key + KEY_SEP + col.id) || [];
      cellMap.set(col.id, { clips: got, empty: got.length ? null : CELL_MISSING });
    }
    return { id: r.key, label: null, axes: r.axes, cells: cellMap };
  });

  return {
    kind: "axes",
    axisOrder,
    pinned,
    sections: rowsOut.length && columns.length
      ? [{ id: "all", label: null, note: null, columns, rows: rowsOut }]
      : [],
    unrowed: 0,
    keptCount: kept.length,
    totalCount: generated.length,
    cellCount: rowsOut.length * columns.length,
    filledCount: kept.length,
  };
}

/** Pick whichever model the data supports. */
export function buildModel(index, shard, state) {
  const hasSections = Array.isArray(index.row_sections) && index.row_sections.length > 0;
  const hasRows = (shard.clips || []).some((c) => Array.isArray(c.rows));
  return hasSections && hasRows
    ? buildSectionModel(index, shard, state)
    : buildAxisModel(index, shard, state);
}

/* --- rendering ----------------------------------------------------------- */

/** The stack of labelled axis chips that identifies one configuration. */
function axisChips(axes, axisOrder, labeller) {
  const wrap = document.createElement("div");
  wrap.className = "axis-stack";
  let any = false;
  for (const axis of axisOrder || []) {
    const raw = axes[axis];
    if (raw === undefined || raw === "") continue;
    any = true;
    const chip = document.createElement("span");
    chip.className = "chip chip-" + axis;
    const k = document.createElement("span");
    k.className = "chip-k";
    k.textContent = labeller.axis(axis);
    const v = document.createElement("span");
    v.className = "chip-v";
    v.textContent = labeller.value(axis, raw);
    chip.appendChild(k);
    chip.appendChild(v);
    wrap.appendChild(chip);
  }
  if (!any) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "—";
    wrap.appendChild(chip);
  }
  return wrap;
}

function systemHead(system, labeller) {
  const wrap = document.createElement("div");
  wrap.className = "system-head family-" + (system.family || "unknown");
  const name = document.createElement("span");
  name.className = "system-name";
  name.textContent = labeller.system(system.id);
  wrap.appendChild(name);
  return wrap;
}

/** An empty cell, styled by WHY it is empty. */
function emptyCell(kind) {
  const cell = document.createElement("div");
  cell.className = "cell cell-empty cell-" + kind;
  const frame = document.createElement("div");
  frame.className = "cell-frame";
  const text = document.createElement("span");
  text.className = "missing-text";
  // "No run" is the quiet permanent case: this system is simply not part of
  // this comparison. "Not available" is the anomaly: it should be here.
  text.textContent =
    kind === CELL_NONE ? "—" : kind === CELL_FILTERED ? "Hidden by filter" : "Not available";
  if (kind === CELL_NONE) cell.title = "This system is not part of this row";
  frame.appendChild(text);
  cell.appendChild(frame);
  return cell;
}

/**
 * Render the grid into `container`.
 *
 * @param {function} cellFactory  clip -> HTMLElement (registers with the pool)
 * @param {Array}    sections     subset of `model.sections` to draw; null for
 *   all of them. The tabbed page draws exactly one.
 * @param {boolean}  showHeads    draw each section's own name and note. False
 *   when the page is in tabs: the tab already carries the name and the note is
 *   printed beside the tab strip, so repeating both here would cost a third of
 *   the height that the grid needs.
 */
export function renderGrid({
  container,
  model,
  labeller,
  cellFactory,
  showHeads = true,
  sections = null,
}) {
  container.textContent = "";

  for (const section of sections || model.sections) {
    const wrap = document.createElement("section");
    wrap.className = "rowsection";

    if (showHeads && section.label) {
      const head = document.createElement("header");
      head.className = "section-head";
      const h = document.createElement("h3");
      h.textContent = section.label;
      head.appendChild(h);
      if (section.note) {
        const note = document.createElement("p");
        note.className = "section-note";
        note.textContent = section.note;
        head.appendChild(note);
      }
      wrap.appendChild(head);
    }

    const scroller = document.createElement("div");
    scroller.className = "grid-wrap";

    const grid = document.createElement("div");
    grid.className = "grid";
    grid.style.setProperty("--cols", String(section.columns.length));

    const corner = document.createElement("div");
    corner.className = "grid-corner";
    grid.appendChild(corner);

    for (const col of section.columns) {
      const head = document.createElement("div");
      head.className = "grid-colhead";
      head.appendChild(systemHead(col, labeller));
      grid.appendChild(head);
    }

    for (const row of section.rows) {
      const head = document.createElement("div");
      head.className = "grid-rowhead";
      if (row.label) {
        const name = document.createElement("span");
        name.className = "row-name";
        name.textContent = row.label;
        head.appendChild(name);
      } else {
        // Fallback model: the row has no declared name, only its axes.
        head.appendChild(axisChips(row.axes || {}, model.axisOrder, labeller));
      }
      grid.appendChild(head);

      for (const col of section.columns) {
        const cell = row.cells.get(col.id);
        if (!cell || !cell.clips.length) {
          grid.appendChild(emptyCell((cell && cell.empty) || CELL_MISSING));
          continue;
        }
        if (cell.clips.length === 1) {
          grid.appendChild(cellFactory(cell.clips[0]));
          continue;
        }
        // More than one run landed in the same cell. Show them all stacked
        // rather than picking one arbitrarily; each is still its own pooled
        // cell, so the video budget is unaffected.
        const stack = document.createElement("div");
        stack.className = "cell-stack";
        for (const clip of cell.clips) stack.appendChild(cellFactory(clip));
        grid.appendChild(stack);
      }
    }

    scroller.appendChild(grid);
    wrap.appendChild(scroller);
    container.appendChild(wrap);
  }

  return container;
}
