/* ---------------------------------------------------------------------------
 * One cell of the comparison grid.
 *
 * Deliberately close to the video card in the human-evaluation site: muted,
 * playsinline, no native controls, and an explicit play overlay for the case
 * where the browser refuses autoplay anyway. Muted autoplay is the only kind
 * that runs without a user gesture, and none of these clips carry audio.
 *
 * The one big difference is attach/detach. A cell that is off screen owns NO
 * <video> element at all -- not a paused one, not a src-less one. Holding a
 * detached media element still costs a decoder slot in several browsers, and
 * a segment can carry ~33 clips. See js/pool.js for who decides.
 * ------------------------------------------------------------------------- */

/** Shared playback intent. One instance per page, owned by the transport. */
export function makeClock() {
  return { playing: false, time: 0, loop: true };
}

export class VideoCell {
  /**
   * @param {object} opts
   *   url        {string}   resolved absolute video URL
   *   title      {string}   primary caption (already display text)
   *   subtitle   {string}   secondary caption, may be empty
   *   role       {string}   "context" | "groundtruth" | "generated"
   *   pinned     {boolean}  context/ground-truth cells keep their slot
   *   duration   {number}   clip.duration_s if the build knew it, else 0
   *   clock      {object}   shared transport intent
   *   onReady    {function} called once metadata (and duration) is known
   *   onEnlarge  {function} called with this cell
   *   onWantSlot {function} called when the viewer explicitly asks to play a
   *                         cell the pool has not given a slot to
   */
  constructor(opts) {
    this.url = opts.url;
    this.role = opts.role || "generated";
    this.pinned = !!opts.pinned;
    this.clock = opts.clock;
    this.onReady = opts.onReady || (() => {});
    this.onEnded = opts.onEnded || (() => {});
    this.onEnlarge = opts.onEnlarge || (() => {});
    this.onWantSlot = opts.onWantSlot || (() => {});

    this.video = null;
    // Declared up front from clip.duration_s when the build has a duration
    // cache, so clamping and leader selection are right from the first frame
    // rather than only after loadedmetadata. Both fields are optional, so this
    // is a seed, not a replacement: the measured value overwrites it below.
    this.duration = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : 0;
    this.declaredDuration = this.duration;
    this.failed = false;
    this._lastTime = 0;
    this._seekTarget = null;   // where an in-flight seek is headed, else null

    const cell = document.createElement("div");
    cell.className = "cell cell-" + this.role;
    if (this.pinned) cell.classList.add("cell-pinned");

    const frame = document.createElement("div");
    frame.className = "cell-frame";
    frame.addEventListener("click", () => {
      if (this.video && !this.failed) this.onEnlarge(this);
      else if (!this.video) this.onWantSlot(this);
    });
    cell.appendChild(frame);
    this.frame = frame;

    // Shown whenever the cell holds no <video>: either the pool has not given
    // it a slot yet, or the browser refused autoplay. Both cases need the same
    // affordance -- something obvious to press -- so they share one element.
    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.className = "cell-overlay";
    overlay.innerHTML =
      '<span class="play-glyph" aria-hidden="true">&#9654;</span>' +
      '<span class="overlay-text">Play</span>';
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.video) this.play();
      else this.onWantSlot(this);
    });
    frame.appendChild(overlay);
    this.overlay = overlay;
    this.overlayText = overlay.querySelector(".overlay-text");

    const bar = document.createElement("div");
    bar.className = "cell-bar";

    const caption = document.createElement("span");
    caption.className = "cell-caption";
    caption.textContent = opts.title || "";
    if (opts.subtitle) caption.title = opts.subtitle;
    bar.appendChild(caption);
    this.caption = caption;

    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "cell-zoom";
    zoom.title = "Enlarge";
    zoom.setAttribute("aria-label", "Enlarge " + (opts.title || "clip"));
    zoom.textContent = "⤢";
    zoom.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onEnlarge(this);
    });
    bar.appendChild(zoom);

    cell.appendChild(bar);
    this.el = cell;
  }

  isAttached() {
    return this.video !== null;
  }

  /** Create the <video> and adopt the transport's current intent. */
  attach() {
    if (this.video) return;

    const video = document.createElement("video");
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    video.controls = false;
    video.disablePictureInPicture = true;
    // crossOrigin is deliberately NOT set: the clips are served from another
    // host and nothing here reads their pixels, so asking for a CORS-mode
    // fetch would only add a way for playback to fail.
    video.src = this.url;

    video.addEventListener("loadedmetadata", () => {
      // The file itself is the authority; a cached duration can be stale.
      if (Number.isFinite(video.duration) && video.duration > 0) {
        this.duration = video.duration;
      }
      this._syncToClock();
      this.onReady(this);
    });

    // Lets the transport wrap the moment the last clip finishes, instead of
    // waiting for the next poll. Clips never loop individually, so `ended`
    // firing is always meaningful.
    video.addEventListener("ended", () => this.onEnded(this));

    video.addEventListener("error", () => {
      this.failed = true;
      this.el.classList.add("cell-failed");
      this._showOverlay("Could not load");
      this.overlay.disabled = true;
      // A clip that will not load must not hold the wrap hostage: the grid
      // would otherwise wait forever for a clip that can never end.
      this.onEnded(this);
    });

    // A seek over the network does not settle within a frame. When it lands,
    // pick playback back up if the transport still wants to be playing --
    // otherwise a clip that was seeked while paused-by-buffering stays parked.
    video.addEventListener("seeked", () => {
      this._seekTarget = null;
      if (this.clock.playing && video.paused && !this.failed) this.play();
    });

    this.video = video;
    this.el.classList.add("cell-live");
    this.el.classList.remove("cell-deferred");
    this.frame.insertBefore(video, this.overlay);
    this._syncToClock();
  }

  /**
   * Tear the media element down completely.
   *
   * removeAttribute("src") + load() is the incantation that actually releases
   * the network request and the decoder; pausing alone does not.
   */
  detach() {
    const video = this.video;
    if (!video) return;
    this.video = null;
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch { /* teardown is best-effort */ }
    video.remove();
    this.el.classList.remove("cell-live");
    this.el.classList.add("cell-deferred");
    this._showOverlay("Play");
  }

  _showOverlay(text) {
    this.overlay.hidden = false;
    if (this.overlayText) this.overlayText.textContent = text;
  }

  _hideOverlay() {
    this.overlay.hidden = true;
  }

  /** Bring this clip in line with the shared transport intent. */
  _syncToClock() {
    const video = this.video;
    if (!video || this.failed) return;
    // Never loop an individual clip. The clips differ in length, so per-clip
    // looping pulls the grid apart within seconds: a 3-second continuation
    // would be showing its second pass while a 5-second one is still on its
    // first, and the side-by-side stops meaning anything. A short clip parks
    // on its final frame and the transport loops the whole grid at once.
    video.loop = false;
    this.seek(this.clock.time);
    if (this.clock.playing) this.play();
    else this._hideOverlay();
  }

  play() {
    const video = this.video;
    if (!video || this.failed) return;
    const p = video.play();
    if (p && typeof p.catch === "function") {
      p.then(() => this._hideOverlay()).catch((err) => {
        // AbortError means a seek or pause interrupted this play() -- routine
        // while scrubbing, and NOT a refusal. Showing the play overlay for it
        // would cover a clip that is about to start on its own.
        if (err && err.name === "AbortError") return;
        // Anything else is the browser genuinely declining to autoplay. Leave
        // the viewer something to press rather than a silent still frame.
        this._showOverlay("Play");
      });
    } else {
      this._hideOverlay();
    }
  }

  pause() {
    if (this.video) this.video.pause();
  }

  /**
   * Seek to an absolute time on the master timeline.
   *
   * Clips have different lengths -- the closed systems were asked for a shorter
   * continuation window than the open ones -- so a shared absolute time is
   * clamped rather than scaled. Scaling would line up frames that do not
   * correspond to the same moment, which is exactly the comparison this page
   * exists to make honest.
   */
  /** True while a requested seek has not landed yet. */
  isSeeking() {
    return !!(this.video && (this.video.seeking || this._seekTarget !== null && this._seekTarget !== undefined));
  }

  seek(t) {
    const video = this.video;
    if (!video || this.failed) return;

    // Do not stack seeks. Over the network a seek takes far longer than a
    // frame, and until it lands `currentTime` still reads the OLD position --
    // so a drift correction running every frame sees the same large drift,
    // fires another seek, and cancels the one in flight. The clip then never
    // finishes seeking and never plays. Local fixture files settle within a
    // frame, which is why this only ever showed up on real streamed clips.
    if (video.seeking) return;
    // Prefer the measured duration, fall back to the one the build declared,
    // and only leave the seek unclamped when neither is known. A cell that
    // attaches mid-playback seeks before its metadata arrives, so without the
    // declared value the first seek on a short clip overshoots its end.
    const measured = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const dur = measured || this.declaredDuration || 0;
    const target = Math.max(0, dur > 0 ? Math.min(t, Math.max(0, dur - 0.02)) : t);
    // Already where we were asked to go; assigning currentTime again would
    // restart the seek machinery for nothing.
    if (Math.abs(video.currentTime - target) < 0.02) return;
    try {
      this._seekTarget = target;
      video.currentTime = target;
    } catch {
      // Seeking before metadata lands is allowed to fail.
      this._seekTarget = null;
    }
  }

  currentTime() {
    return this.video ? this.video.currentTime : 0;
  }

  destroy() {
    this.detach();
    this.el.remove();
  }
}

/**
 * A cell for a combination that has no clip.
 *
 * Rendered explicitly rather than left blank: not every system covers every
 * segment, and "this system produced nothing here" is a finding, not a gap in
 * the page. A blank square would read as a layout bug.
 */
export function makeMissingCell(note) {
  const cell = document.createElement("div");
  cell.className = "cell cell-missing";
  const frame = document.createElement("div");
  frame.className = "cell-frame";
  const text = document.createElement("span");
  text.className = "missing-text";
  text.textContent = "Not available";
  frame.appendChild(text);
  cell.appendChild(frame);
  if (note) {
    const bar = document.createElement("div");
    bar.className = "cell-bar";
    const caption = document.createElement("span");
    caption.className = "cell-caption";
    caption.textContent = note;
    bar.appendChild(caption);
    cell.appendChild(bar);
  }
  return cell;
}
