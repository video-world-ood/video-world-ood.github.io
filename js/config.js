/* ---------------------------------------------------------------------------
 * Site configuration.
 *
 * Everything tunable lives here so switching from the hand-made development
 * fixture to the real published index is a one-line change and nothing else.
 * ------------------------------------------------------------------------- */

/**
 * Directory holding `index.json` and `v/<segment_id>.json`, relative to
 * index.html.
 *
 * "data/sample" -> the hand-made fixture committed next to the site, used
 *                  while the build pipeline is still producing real shards.
 * "data"        -> the real index written by build_index.py.
 *
 * THIS IS THE ONE LINE TO CHANGE when the real data lands.
 */
export const DATA_DIR = "data";

/**
 * Hard ceiling on simultaneously *attached* <video> elements.
 *
 * Browsers do not fail loudly past roughly sixteen concurrent media elements;
 * they quietly stop decoding, stall the compositor, or hang the tab. A segment
 * can carry ~33 clips, so an unguarded grid would blow straight through that.
 * Every cell therefore competes for a slot in the pool (see js/pool.js) and a
 * cell without a slot holds no <video> at all -- not a paused one, none.
 *
 * Kept below sixteen rather than at it, because the enlarge dialog and the
 * browser's own preloading also consume decoder slots.
 */
export const MAX_LIVE_VIDEOS = 14;

/**
 * How far outside the viewport a cell may be and still be considered worth
 * attaching. One screen of lookahead buys smooth scrolling without doubling
 * the number of contending cells.
 */
export const ATTACH_MARGIN = "300px";

/**
 * The segment picker holds ~580 entries. Building 580 rows on every keystroke
 * is measurably janky on a laptop, and nobody reads past the first screenful
 * anyway, so the list renders at most this many matches and reports the count
 * of the rest.
 */
export const PICKER_RENDER_CAP = 200;

/**
 * How often the master transport advances the clock, checks for the
 * end-of-timeline wrap and corrects drift.
 *
 * A timer rather than requestAnimationFrame, deliberately -- see the comment
 * on Transport._start(). The scrub bar spans a whole segment, so this rate is
 * far finer than one pixel of travel.
 */
export const TICK_MS = 150;

/**
 * Clips that drift further than this many seconds from the master clock get
 * nudged back.
 *
 * The floor is set by how visible a correction is: a seek under ~0.1s reads as
 * a stutter for no gain. The ceiling is set by how much misalignment makes the
 * comparison dishonest. Measured worst-case drift is roughly this value plus
 * one tick of playback, so the observed spread stays near a fifth of a second
 * on clips streamed over the network.
 */
export const SYNC_TOLERANCE = 0.15;
