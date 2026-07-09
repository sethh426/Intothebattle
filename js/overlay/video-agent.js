(function attachOverlayVideoAgent(global) {
  'use strict';

  function noop() {}

  function setStatusText(element, value) {
    if (!element) return;
    element.textContent = String(value || '').slice(0, 140);
  }

  function numericDurationMs(video, payload = {}) {
    if (payload?.mediaDurationMs && Number.isFinite(Number(payload.mediaDurationMs))) {
      return Math.round(Number(payload.mediaDurationMs));
    }
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return 0;
    return Math.round(video.duration * 1000);
  }

  function normalizeMasterVolume(value, fallback = 0.5) {
    const numeric = Number(value);
    const fallbackNumeric = Number(fallback);
    const safeFallback = Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0.5;
    const next = Number.isFinite(numeric) ? numeric : safeFallback;
    return Math.max(0, Math.min(1, Math.round(next * 100) / 100));
  }

  class OverlayVideoAgent {
    constructor(options = {}) {
      this.scene = options.scene || null;
      this.video = options.video || null;
      this.poster = options.poster || null;
      this.statusElement = options.statusElement || options.status || null;
      this.report = typeof options.report === 'function' ? options.report : noop;
      this.isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
      this.onBuffering = typeof options.onBuffering === 'function' ? options.onBuffering : noop;
      this.onRecovered = typeof options.onRecovered === 'function' ? options.onRecovered : noop;
      this.stallTimeoutMs = Math.max(1000, Number(options.stallTimeoutMs) || 7000);
      this.loadToken = 0;
      this.loadedPayload = null;
      this.stallTimer = null;
      this.readyFallbackTimer = null;
      this.firstFrameFallbackTimer = null;
    }

    setStatus(message, stateClass) {
      if (this.scene) {
        this.scene.classList.remove('video-ready', 'video-loading', 'video-error');
        if (stateClass) this.scene.classList.add(stateClass);
      }
      setStatusText(this.statusElement, message || '');
    }

    clearStallTimer() {
      if (!this.stallTimer) return;
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }

    clearReadyFallback() {
      if (!this.readyFallbackTimer) return;
      clearTimeout(this.readyFallbackTimer);
      this.readyFallbackTimer = null;
    }

    clearFirstFrameFallback() {
      if (!this.firstFrameFallbackTimer) return;
      clearTimeout(this.firstFrameFallbackTimer);
      this.firstFrameFallbackTimer = null;
    }

    clearPlaybackTimers() {
      this.clearStallTimer();
      this.clearReadyFallback();
      this.clearFirstFrameFallback();
    }

    clearHandlers() {
      if (!this.video) return;
      this.video.onended = null;
      this.video.oncanplay = null;
      this.video.oncanplaythrough = null;
      this.video.onloadeddata = null;
      this.video.onloadedmetadata = null;
      this.video.onplaying = null;
      this.video.onerror = null;
      this.video.onstalled = null;
      this.video.onwaiting = null;
    }

    reset(options = {}) {
      const clearSource = options.clearSource !== false;
      const cancelLoad = options.cancelLoad !== false;
      if (cancelLoad) this.loadToken += 1;
      this.clearPlaybackTimers();

      if (this.video) {
        try { this.video.pause(); } catch (_err) {}
        this.clearHandlers();
        if (clearSource) {
          this.video.removeAttribute('src');
          try { this.video.load(); } catch (_err) {}
          this.loadedPayload = null;
        }
      }

      if (clearSource) this.clearPoster();
      if (this.scene) {
        this.scene.classList.remove('video-ready', 'video-loading', 'video-error');
        delete this.scene.dataset.videoFit;
      }
      setStatusText(this.statusElement, '');
    }

    posterSource(payload = {}) {
      const source = String(payload.posterUrl || payload.posterData || payload.thumbnailData || '').trim();
      if (/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(source)) return source;
      if (/^(?:https?:)?\/\//i.test(source) || source.startsWith('/')) return source;
      return '';
    }

    applyPoster(payload = {}) {
      const source = this.posterSource(payload);
      if (this.poster) {
        this.poster.style.backgroundImage = source ? `url("${source.replace(/"/g, '%22')}")` : '';
      }
      if (this.video) {
        if (source) this.video.poster = source;
        else this.video.removeAttribute('poster');
      }
      if (this.scene) this.scene.classList.toggle('has-poster', Boolean(source));
    }

    applyVolume(payload = {}) {
      if (!this.video) return;
      this.video.volume = normalizeMasterVolume(payload.volume);
    }

    clearPoster() {
      if (this.poster) this.poster.style.backgroundImage = '';
      if (this.video) this.video.removeAttribute('poster');
      if (this.scene) this.scene.classList.remove('has-poster');
    }

    errorMessage(prefix = 'Arena media could not play') {
      if (!this.video?.error?.code) return prefix;
      const labels = {
        1: 'aborted',
        2: 'network',
        3: 'decode',
        4: 'unsupported source',
      };
      const label = labels[this.video.error.code] || `code ${this.video.error.code}`;
      return `${prefix} (${label})`;
    }

    applyFit(payload = {}) {
      if (!this.scene || !this.video) return;
      const requestedFit = ['cover', 'contain', 'auto'].includes(payload.fit) ? payload.fit : 'auto';
      let resolvedFit = requestedFit;
      if (resolvedFit === 'auto') {
        const mediaWidth = Number(payload.mediaWidth) || Number(this.video.videoWidth) || 16;
        const mediaHeight = Number(payload.mediaHeight) || Number(this.video.videoHeight) || 9;
        const ratio = mediaWidth / Math.max(1, mediaHeight);
        resolvedFit = ratio < 1.45 || ratio > 2.05 ? 'contain' : 'cover';
      }
      this.scene.classList.toggle('contain', resolvedFit === 'contain');
      this.scene.dataset.videoFit = resolvedFit;
    }

    mediaDurationMs(payload = {}) {
      return numericDurationMs(this.video, payload);
    }

    mediaTelemetry(payload = {}) {
      const mediaDurationMs = numericDurationMs(this.video, payload) || Number(payload.mediaDurationMs) || null;
      return {
        readyState: this.video ? this.video.readyState : null,
        currentTime: this.video ? this.video.currentTime : null,
        duration: this.video ? this.video.duration : null,
        mediaDurationMs,
        mediaWidth: this.video ? this.video.videoWidth || payload.mediaWidth || null : payload.mediaWidth || null,
        mediaHeight: this.video ? this.video.videoHeight || payload.mediaHeight || null : payload.mediaHeight || null,
      };
    }

    status(payload = {}) {
      const classList = this.scene ? Array.from(this.scene.classList) : [];
      const stateClass = ['video-ready', 'video-loading', 'video-error'].find(name => classList.includes(name)) || '';
      const currentSrc = this.video ? this.video.currentSrc || this.video.src || '' : '';
      return {
        agent: 'video-agent',
        hasScene: Boolean(this.scene),
        hasVideoElement: Boolean(this.video),
        hasPosterElement: Boolean(this.poster),
        loaded: Boolean(this.loadedPayload),
        loadedBreakId: this.loadedPayload?.breakId || '',
        loadedVideoUrl: this.loadedPayload?.videoUrl || '',
        activeBreakId: payload?.breakId || '',
        activeVideoUrl: payload?.videoUrl || '',
        currentSrc,
        hasSource: Boolean(currentSrc || this.loadedPayload?.videoUrl || payload?.videoUrl),
        ready: this.hasReadyFrame(),
        readyState: this.readyState(),
        volume: this.video ? this.video.volume : normalizeMasterVolume(payload.volume),
        paused: this.video ? this.video.paused : null,
        ended: this.video ? this.video.ended : null,
        stateClass,
        fit: this.scene?.dataset?.videoFit || '',
        statusText: this.statusElement ? String(this.statusElement.textContent || '').slice(0, 140) : '',
        stallTimerActive: Boolean(this.stallTimer),
        readyFallbackActive: Boolean(this.readyFallbackTimer),
        firstFrameFallbackActive: Boolean(this.firstFrameFallbackTimer),
      };
    }

    readyState() {
      return this.video ? this.video.readyState : 0;
    }

    hasReadyFrame() {
      return this.readyState() >= 2;
    }

    pause() {
      if (!this.video) return;
      try {
        if (!this.video.paused && !this.video.ended) this.video.pause();
      } catch (_err) {}
    }

    isReadyFor(payload = {}) {
      if (!this.loadedPayload || !this.hasReadyFrame()) return false;
      if (payload.breakId && this.loadedPayload.breakId === payload.breakId) return true;
      return Boolean(payload.videoUrl && this.loadedPayload.videoUrl === payload.videoUrl);
    }

    preload(payload = {}) {
      this.loadToken += 1;
      const token = this.loadToken;

      if (!this.video || !payload.videoUrl) {
        this.setStatus('', null);
        return Promise.resolve(false);
      }

      this.setStatus('Preparing arena media', 'video-loading');
      this.reset({ clearSource: true, cancelLoad: false });
      this.applyPoster(payload);
      this.setStatus('Preparing arena media', 'video-loading');

      return new Promise(resolve => {
        let settled = false;
        let decodedReported = false;
        let readyTimer = null;
        const reportDecoded = () => {
          if (decodedReported || token !== this.loadToken) return;
          decodedReported = true;
          this.applyFit(payload);
          this.report(payload, 'decoded', 'Arena media metadata decoded');
        };
        const done = (ready, message, stateClass) => {
          if (settled || token !== this.loadToken) return;
          settled = true;
          if (ready) {
            this.loadedPayload = payload;
            reportDecoded();
          } else {
            this.loadedPayload = null;
          }
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
          this.setStatus(message, stateClass);
          resolve(ready);
        };
        const markReady = () => {
          if (settled || token !== this.loadToken) return;
          if (!this.video || this.video.readyState < 2) return;
          reportDecoded();
          if (readyTimer) clearTimeout(readyTimer);
          readyTimer = setTimeout(() => {
            readyTimer = null;
            if (this.video && this.video.readyState >= 2) done(true, '', 'video-ready');
          }, 120);
        };

        this.video.preload = 'auto';
        this.video.playsInline = true;
        this.video.disablePictureInPicture = true;
        this.video.muted = payload.muted;
        this.applyVolume(payload);
        this.video.loop = false;
        this.applyPoster(payload);
        this.video.src = payload.videoUrl;
        this.video.onloadedmetadata = reportDecoded;
        this.video.onloadeddata = markReady;
        this.video.oncanplay = markReady;
        this.video.oncanplaythrough = markReady;
        this.video.onerror = () => done(false, this.errorMessage('Arena media could not preload'), 'video-error');
        this.video.onstalled = () => this.setStatus('Buffering arena media', 'video-loading');
        this.video.onwaiting = () => this.setStatus('Buffering arena media', 'video-loading');

        try {
          this.video.load();
          if (this.video.readyState >= 1) reportDecoded();
          if (this.video.readyState >= 2) markReady();
        } catch (_err) {
          done(false, 'Arena media could not load', 'video-error');
        }
      });
    }

    play(payload = {}, hooks = {}) {
      if (!this.video || !payload.videoUrl) {
        this.setStatus('', null);
        hooks.onUnavailable?.();
        return;
      }

      let playingNotified = false;
      let playbackStartedNotified = false;
      const notifyPlaybackStarted = (message = 'Arena media playback started') => {
        if (playbackStartedNotified) return;
        playbackStartedNotified = true;
        this.report(payload, 'playing', message);
      };
      const notifyPlaying = (message = '') => {
        if (playingNotified) return;
        playingNotified = true;
        this.clearReadyFallback();
        this.clearFirstFrameFallback();
        this.applyFit(payload);
        this.setStatus('', 'video-ready');
        notifyPlaybackStarted();
        this.report(payload, 'first_frame', message);
        hooks.onPlaying?.();
      };
      const requestFirstFrame = (message = 'Arena media first frame displayed') => {
        if (playingNotified) return;
        this.clearFirstFrameFallback();
        if (this.video && typeof this.video.requestVideoFrameCallback === 'function') {
          this.video.requestVideoFrameCallback(() => {
            if (this.isCurrent(payload)) notifyPlaying(message);
          });
          this.firstFrameFallbackTimer = setTimeout(() => {
            this.firstFrameFallbackTimer = null;
            if (!playingNotified && this.isCurrent(payload) && this.video && this.video.readyState >= 2) {
              notifyPlaying('Arena media frame confirmed by ready-state fallback');
            }
          }, 1100);
          return;
        }
        this.firstFrameFallbackTimer = setTimeout(() => {
          this.firstFrameFallbackTimer = null;
          if (this.isCurrent(payload)) notifyPlaying(message);
        }, 180);
      };
      const failPlayback = (message) => {
        this.clearReadyFallback();
        this.clearFirstFrameFallback();
        this.setStatus(message, 'video-error');
        this.report(payload, 'failed', message);
        hooks.onError?.();
      };
      const scheduleReadyFallback = (delay = 1200) => {
        this.clearReadyFallback();
        if (playingNotified || this.video.readyState < 2) return;
        this.readyFallbackTimer = setTimeout(() => {
          this.readyFallbackTimer = null;
          if (!playingNotified && this.isCurrent(payload) && this.video && this.video.readyState >= 2) {
            requestFirstFrame('Arena media started after ready-state fallback');
          }
        }, delay);
      };
      const handleRecovered = () => {
        this.applyFit(payload);
        this.setStatus('', 'video-ready');
        this.clearStallTimer();
        this.onRecovered(payload);
      };
      const handleBuffering = () => {
        this.setStatus('Buffering arena media', 'video-loading');
        this.onBuffering(payload);
        this.clearStallTimer();
        this.stallTimer = setTimeout(() => {
          this.stallTimer = null;
          if (!this.isCurrent(payload)) return;
          failPlayback('Arena media stalled during playback');
        }, this.stallTimeoutMs);
      };

      this.video.muted = payload.muted !== false;
      this.applyVolume(payload);
      this.applyPoster(payload);
      this.applyFit(payload);
      if (this.video.readyState >= 2) {
        this.setStatus('', 'video-ready');
        scheduleReadyFallback(1400);
      } else {
        this.setStatus('Buffering arena media', 'video-loading');
      }

      this.video.onloadeddata = () => {
        handleRecovered();
        scheduleReadyFallback(1000);
      };
      this.video.oncanplay = () => {
        handleRecovered();
        scheduleReadyFallback(900);
      };
      this.video.oncanplaythrough = () => {
        handleRecovered();
        scheduleReadyFallback(700);
      };
      this.video.onloadedmetadata = () => this.applyFit(payload);
      this.video.onplaying = () => {
        handleRecovered();
        notifyPlaybackStarted();
        requestFirstFrame();
      };
      this.video.onwaiting = handleBuffering;
      this.video.onstalled = handleBuffering;
      this.video.onerror = () => {
        failPlayback(this.errorMessage('Arena media could not play'));
      };
      this.video.onended = () => {
        this.clearPlaybackTimers();
        if (!this.isCurrent(payload)) return;
        this.report(payload, 'video_completed', 'Arena media completed');
        hooks.onEnded?.();
      };

      try {
        this.video.currentTime = 0;
      } catch (_err) {}

      const playAttempt = this.video.play();
      if (playAttempt && typeof playAttempt.then === 'function') {
        playAttempt.then(() => requestFirstFrame()).catch(() => {
          this.clearReadyFallback();
          this.video.muted = true;
          const mutedAttempt = this.video.play();
          if (mutedAttempt && typeof mutedAttempt.then === 'function') {
            scheduleReadyFallback(1400);
            mutedAttempt.then(() => requestFirstFrame('Arena media first frame displayed after muted retry')).catch(() => {
              failPlayback('Browser blocked sponsor media playback');
            });
          } else {
            setTimeout(() => requestFirstFrame('Arena media first frame displayed after muted retry'), 120);
          }
        });
      } else {
        scheduleReadyFallback(900);
        setTimeout(() => requestFirstFrame(), 120);
      }
    }
  }

  global.IntoTheBattleOverlayVideoAgent = Object.freeze({
    OverlayVideoAgent,
    create(options) {
      return new OverlayVideoAgent(options);
    },
  });
})(window);
