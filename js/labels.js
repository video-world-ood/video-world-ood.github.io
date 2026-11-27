/* ---------------------------------------------------------------------------
 * Display text.
 *
 * Every visible string that names a system, a dataset, a role or an axis value
 * comes from `index.labels` and from nowhere else. That map is generated from
 * config/labels.yaml, which is the single review gate between internal
 * codenames and public text: a value the reviewer has not signed off on is
 * dropped from the index rather than published under its internal name.
 *
 * So there is deliberately NO fallback to the raw value here. An unlabelled
 * value renders as an em dash. Showing "tedio+ug_future" to a reader because a
 * label was missing would defeat the whole point of that gate.
 * ------------------------------------------------------------------------- */

/** What an unlabelled value looks like. Never the raw value. */
export const UNLABELLED = "—";

/**
 * Axis *identifiers* (`conditioning`, `variant`, ...) are structural, not
 * content: they are the column headings of the data contract, not codenames
 * for anything. SCHEMA.md gives no label map for them, so they are humanised
 * here. Axis VALUES never take this path.
 */
function humaniseAxisId(axisId) {
  return String(axisId)
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function makeLabeller(index) {
  const labels = index.labels || {};
  const systemsById = new Map((index.systems || []).map((s) => [s.id, s]));
  const datasetsById = new Map((index.datasets || []).map((d) => [d.id, d]));
  const warned = new Set();

  function warnOnce(kind, key) {
    const k = kind + ":" + key;
    if (warned.has(k)) return;
    warned.add(k);
    // Surfaced in the console so a missing label is a build bug someone can
    // find, rather than an em dash nobody can explain.
    console.warn(`[labels] no display text for ${kind} "${key}"; showing an em dash`);
  }

  return {
    /** Display text for an axis value, e.g. ("setting", "zero_shot"). */
    value(axisId, raw) {
      if (raw === undefined || raw === null || raw === "") return UNLABELLED;
      const text = labels[axisId] && labels[axisId][raw];
      if (!text) {
        warnOnce(`${axisId} value`, raw);
        return UNLABELLED;
      }
      return text;
    },

    /**
     * Heading for an axis. `labels.axis` is not in SCHEMA.md today; it is read
     * first anyway so the build can start emitting it without a site change.
     */
    axis(axisId) {
      const explicit = labels.axis && labels.axis[axisId];
      return explicit || humaniseAxisId(axisId);
    },

    /** Display name of a system. `index.systems[].label` is the primary source. */
    system(systemId) {
      if (!systemId) return UNLABELLED;
      const sys = systemsById.get(systemId);
      if (sys && sys.label) return sys.label;
      const text = labels.system && labels.system[systemId];
      if (!text) {
        warnOnce("system", systemId);
        return UNLABELLED;
      }
      return text;
    },

    /** "closed" / "open"; used only as a CSS hook, never shown verbatim. */
    family(systemId) {
      const sys = systemsById.get(systemId);
      return (sys && sys.family) || "";
    },

    dataset(datasetId) {
      if (!datasetId) return UNLABELLED;
      const ds = datasetsById.get(datasetId);
      if (ds && ds.label) return ds.label;
      const text = labels.dataset && labels.dataset[datasetId];
      if (!text) {
        warnOnce("dataset", datasetId);
        return UNLABELLED;
      }
      return text;
    },

    role(role) {
      const text = labels.role && labels.role[role];
      if (!text) {
        warnOnce("role", role);
        return UNLABELLED;
      }
      return text;
    },
  };
}
