/* ---------------------------------------------------------------------------
 * One transport for every clip on screen.
 *
 * Comparing continuations only works if they are all showing the same moment,
 * so there is exactly one play/pause/restart/scrub and it drives all of them.
 *
 * The timeline is ABSOLUTE SECONDS, not a normalised fraction. Clips differ in
 * length -- the closed systems were asked for a shorter continuation window
 * than the open ones -- and normalising would put second 1 of a 3-second clip
 * next to second 2 of a 6-second one and call them the same instant. A short
 * clip simply sits on its last frame once the master clock passes its end.
 *
 * A cell that scrolls into view mid-playback is attached at the master time and
 * starts playing, so the grid stays coherent while you scroll.
 * ------------------------------------------------------------------------- */

import { SYNC_TOLERANCE, TICK_MS } from "./config.js";

const SCRUB_STEPS = 1000;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const cs = Math.floor((seconds - s) * 10);
  return `${s}.${cs}s`;
}

export class Transport {
  /**
   * @param {object} opts
   *   clock    shared intent object from makeClock()
   *   pool     VideoPool, queried for the cells that currently hold a <video>
   *   els      {play, pause, restart, scrub, time, loop, status}
   */
  constructor({ clock, pool, els }) {
    this.clock = clock;
    this.pool = pool;
    this.els = els;

    this.maxDuration = 0;
    this.scrubbing = false;
    this._timer = null;
    this._lastLeaderTime = 0;
    this._tick = this._tick.bind(this);

    els.play.addEventListener("click", () => this.play());
    els.pause.addEventListener("click", () => this.pause());
    els.restart.addEventListener("click", () => this.restart());

    // "Loop" is a property of the comparison, not of any one clip: see the
    // note in video.js on why individual clips never loop.
    els.loop.addEventListener("change", () => {
      this.clock.loop = els.loop.checked;
    });

    // pointerdown/up rather than only 'input': while the viewer is dragging we
    // must stop the tick loop from yanking the thumb back under their finger.
    els.scrub.addEventListener("pointerdown", () => { this.scrubbing = true; });
    const endScrub = () => { this.scrubbing = false; };
    els.scrub.addEventListener("pointerup", endScrub);
    els.scrub.addEventListener("pointercancel", endScrub);
    els.scrub.addEventListener("keydown", () => { this.scrubbing = true; });
    els.scrub.addEventListener("keyup", endScrub);
    els.scrub.addEventListener("blur", endScrub);

    els.scrub.addEventListener("input", () => {
      const fraction = Number(els.scrub.value) / SCRUB_STEPS;
      this.seek(fraction * (this.maxDuration || 0));
    });
    els.scrub.addEventListener("change", endScrub);

    this._syncButtons();
  }

  /**
   * Called by the app whenever a clip reports its duration, and once per
   * segment with the shard's `max_duration_s` when the build knows it.
   *
   * Seeding from the shard is what makes the scrub bar correct on FIRST PAINT
   * instead of growing under the viewer's cursor as clips load -- which used
   * to make an early drag land somewhere other than where it was aimed. It
   * only ever grows the timeline, so a stale or missing cache degrades to the
   * old loadedmetadata-driven behaviour rather than truncating anything.
   */
  noteDuration(seconds) {
    if (Number.isFinite(seconds) && seconds > this.maxDuration) {
      this.maxDuration = seconds;
      this._render();
    }
  }

  /** Forget durations; called when the grid is rebuilt for a new segment. */
  reset() {
    this.pause();
    this.maxDuration = 0;
    this.clock.time = 0;
    this._lastLeaderTime = 0;
    this._render();
  }

  play() {
    this.clock.playing = true;
    for (const cell of this.pool.live()) cell.play();
    this._syncButtons();
    this._start();
  }

  pause() {
    this.clock.playing = false;
    for (const cell of this.pool.live()) cell.pause();
    this._syncButtons();
    this._stop();
  }

  /** Seek everything back to zero. Also the way to re-sync after drift. */
  restart() {
    this.seek(0);
    if (this.clock.playing) {
      for (const cell of this.pool.live()) cell.play();
    }
  }

  seek(seconds) {
    this.clock.time = Math.max(0, seconds);
    this._lastLeaderTime = this.clock.time;
    for (const cell of this.pool.live()) cell.seek(this.clock.time);
    this._render();
  }

  _syncButtons() {
    this.els.play.hidden = this.clock.playing;
    this.els.pause.hidden = !this.clock.playing;
  }

  /**
   * Drive the transport from a TIMER, not requestAnimationFrame.
   *
   * This was rAF originally, which was a design error. rAF is a *rendering*
   * callback: browsers suspend it entirely for occluded or off-screen windows,
   * background tabs, power saving and some embedded webviews -- and they do so
   * while `document.visibilityState` still reports "visible". When it stopped,
   * the clock stopped, drift correction stopped and the end-of-timeline wrap
   * never fired, leaving the transport insisting it was playing while every
   * clip sat on its final frame. A timer keeps running in all of those cases.
   *
   * TICK_MS granularity is plenty: the scrub bar spans a whole segment, so a
   * few hundred milliseconds is well under one pixel of travel.
   */
  _start() {
    if (this._timer === null) this._timer = setInterval(this._tick, TICK_MS);
  }

  _stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * The clock is read from the LONGEST attached clip, because a shorter one
   * reaches its end early and would peg the master time there.
   */
  _leader() {
    let best = null;
    for (const cell of this.pool.live()) {
      if (cell.failed || !cell.video || !(cell.duration > 0)) continue;
      if (!best || cell.duration > best.duration) best = cell;
    }
    return best;
  }

  /**
   * Every playable clip on screen has reached its end.
   *
   * Checked independently of the leader, because a wrap that depends on one
   * designated clip has too many ways to stall: the leader can be detached by
   * the pool, fail to load, or sit buffering. If nothing is left playing there
   * is nothing to wait for, whatever the leader says.
   */
  _allEnded() {
    const live = this.pool.live().filter((c) => !c.failed && c.video);
    if (!live.length) return false;
    return live.every((c) => c.video.ended);
  }

  /** A clip finished. Wrap immediately rather than waiting for the next tick. */
  noteCellEnded() {
    if (this.clock.playing && this._allEnded()) this._wrapOrStop();
  }

  _wrapOrStop() {
    if (this.clock.loop) {
      this.restart();
    } else {
      this.clock.time = this.maxDuration;
      this.pause();
      this._render();
    }
  }

  _tick() {
    if (!this.clock.playing) return;

    // The unconditional backstop, before any leader reasoning.
    if (this._allEnded()) {
      this._wrapOrStop();
      this._render();
      return;
    }

    const leader = this._leader();
    // A seeking leader reports a stale currentTime, which would read as the
    // clock jumping backwards or hitting the end. Coast until it lands.
    if (leader && !leader.isSeeking()) {
      const t = leader.currentTime();
      const atEnd =
        (leader.video && leader.video.ended) ||
        (leader.duration > 0 && t >= leader.duration - 0.05);

      if (atEnd) {
        // The longest clip on screen has run out. Everything restarts together
        // -- a grid where each tile loops on its own schedule stops being a
        // comparison after the first few seconds.
        this._wrapOrStop();
      } else {
        this.clock.time = t;
        this._lastLeaderTime = t;
        this._correctDrift(t);
      }
    }

    this._render();
  }

  _correctDrift(masterTime) {
    for (const cell of this.pool.live()) {
      if (cell.failed || !cell.video) continue;
      // Never correct a clip that is still seeking or still buffering. Its
      // currentTime is stale, so the drift we would measure is imaginary, and
      // acting on it cancels the seek already in flight -- which on real
      // streamed clips deadlocks playback entirely.
      if (cell.isSeeking() || cell.video.readyState < 2) continue;
      // A clip shorter than the master time is legitimately parked on its last
      // frame; nudging it would be wrong, not corrective.
      if (!(cell.duration > masterTime + SYNC_TOLERANCE)) continue;
      if (Math.abs(cell.video.currentTime - masterTime) > SYNC_TOLERANCE) {
        cell.seek(masterTime);
      }
    }
  }

  _render() {
    const max = this.maxDuration || 0;
    if (!this.scrubbing) {
      const fraction = max > 0 ? Math.min(1, this.clock.time / max) : 0;
      this.els.scrub.value = String(Math.round(fraction * SCRUB_STEPS));
    }
    // The stylesheet draws the played portion of the bar and cannot see the
    // clock, so it is handed the position. Read back from the element rather
    // than from the clock so the fill follows the THUMB while dragging --
    // during a drag the clock has not moved yet.
    this.els.scrub.style.setProperty(
      "--pos",
      `${(Number(this.els.scrub.value) / SCRUB_STEPS) * 100}%`
    );
    this.els.time.textContent = max > 0
      ? `${formatTime(this.clock.time)} / ${formatTime(max)}`
      : "–";
  }
}
