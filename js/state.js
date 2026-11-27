/* ---------------------------------------------------------------------------
 * View state <-> URL query string.
 *
 * The whole point of this site is showing someone else a specific comparison,
 * so the URL has to carry it: which segment, which way round the grid is, and
 * which axis values are on screen. Everything here is RAW ids -- never display
 * text -- so a wording change in labels.yaml cannot break a link someone
 * already sent.
 *
 * Query keys:
 *   seg      segment id
 *   tab      id of the row section on screen (see index.row_sections)
 *   q        segment picker search text
 *   ds       segment picker dataset filter
 *   f.<axis> comma-joined raw axis values that are SHOWN (absent = show all)
 *   f.system comma-joined system ids that are SHOWN (absent = show all)
 * ------------------------------------------------------------------------- */

const FILTER_PREFIX = "f.";

/** The shape every consumer in the app expects. */
export function emptyState() {
  return {
    segment: null,
    // Which row section is on screen. "" means "whichever comes first", so a
    // link made before the tabs existed still opens on something.
    tab: "",
    query: "",
    dataset: "",
    // Map<axisId|"system", Set<string>>. An axis absent from this map means
    // "no filter", which is different from "every value selected" only in that
    // it survives the data changing under it.
    filters: new Map(),
  };
}

export function readState(search = window.location.search) {
  const params = new URLSearchParams(search);
  const state = emptyState();

  state.segment = params.get("seg") || null;
  state.tab = params.get("tab") || "";
  state.query = params.get("q") || "";
  state.dataset = params.get("ds") || "";

  for (const [key, raw] of params.entries()) {
    if (!key.startsWith(FILTER_PREFIX)) continue;
    const axis = key.slice(FILTER_PREFIX.length);
    if (!axis) continue;
    const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length) state.filters.set(axis, new Set(values));
  }

  return state;
}

export function toQueryString(state) {
  const params = new URLSearchParams();
  if (state.segment) params.set("seg", state.segment);
  if (state.tab) params.set("tab", state.tab);
  if (state.query) params.set("q", state.query);
  if (state.dataset) params.set("ds", state.dataset);

  // Sorted so the same view always produces byte-identical links, which makes
  // them comparable and cache-friendly.
  for (const axis of [...state.filters.keys()].sort()) {
    const values = state.filters.get(axis);
    if (!values || !values.size) continue;
    params.set(FILTER_PREFIX + axis, [...values].sort().join(","));
  }

  const qs = params.toString();
  return qs ? "?" + qs : "";
}

export function absoluteUrl(state) {
  const { origin, pathname } = window.location;
  return origin + pathname + toQueryString(state);
}

/**
 * Push the state into the address bar.
 *
 * replaceState, not pushState: ticking a filter checkbox is not a navigation,
 * and stacking one history entry per checkbox would make the back button
 * useless. Choosing a different segment is a navigation, so that one pushes.
 */
export function writeState(state, { push = false } = {}) {
  const url = window.location.pathname + toQueryString(state);
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

/** True when `value` passes the filter for `axis` (no filter = everything passes). */
export function passes(state, axis, value) {
  const allowed = state.filters.get(axis);
  if (!allowed || !allowed.size) return true;
  return allowed.has(value);
}

export function toggleFilter(state, axis, value, on) {
  const current = new Set(state.filters.get(axis) || []);
  if (on) current.add(value);
  else current.delete(value);
  if (current.size) state.filters.set(axis, current);
  else state.filters.delete(axis);
}
