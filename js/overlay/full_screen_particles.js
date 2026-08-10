(function attachFullScreenParticles(global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_TRIGGER = Object.freeze({
    trigger: 'likes',
    threshold: 1000,
    effect: 'particleForm',
    shape: 'heart',
    text: '+1,000 LIKES',
    duration: 2800,
    cooldown: 5000,
  });

  const DEFAULT_SHAPES = Object.freeze({
    heart: {
      type: 'path',
      path: 'M50 86 C22 62 8 45 8 27 C8 15 17 7 29 7 C38 7 45 12 50 20 C55 12 62 7 71 7 C83 7 92 15 92 27 C92 45 78 62 50 86 Z',
      viewBox: [0, 0, 100, 100],
      palette: ['#ff4f8f', '#ff78b2', '#fff0f8', '#f6c95b'],
    },
    sword: {
      type: 'path',
      path: 'M50 5 L57 45 L52 70 L62 80 L56 86 L50 78 L44 86 L38 80 L48 70 L43 45 Z M35 64 L65 64 L65 70 L35 70 Z',
      viewBox: [0, 0, 100, 100],
      palette: ['#7afcff', '#ffffff', '#f6c95b'],
    },
    shield: {
      type: 'path',
      path: 'M50 7 L84 18 L80 49 C77 67 66 80 50 91 C34 80 23 67 20 49 L16 18 Z',
      viewBox: [0, 0, 100, 100],
      palette: ['#7afcff', '#99ffda', '#ffffff'],
    },
    crown: {
      type: 'path',
      path: 'M16 75 L20 31 L38 53 L50 21 L62 53 L80 31 L84 75 Z M20 82 L80 82',
      viewBox: [0, 0, 100, 100],
      palette: ['#f6c95b', '#fff1a8', '#ff78b2'],
    },
    skull: {
      type: 'path',
      path: 'M50 10 C69 10 82 24 82 43 C82 56 75 66 64 71 L64 84 L57 84 L57 75 L51 75 L51 84 L44 84 L44 75 L38 75 L38 84 L31 84 L31 71 C20 66 18 56 18 43 C18 24 31 10 50 10 Z M34 45 C39 45 43 49 43 54 C43 59 39 63 34 63 C29 63 25 59 25 54 C25 49 29 45 34 45 Z M66 45 C71 45 75 49 75 54 C75 59 71 63 66 63 C61 63 57 59 57 54 C57 49 61 45 66 45 Z',
      viewBox: [0, 0, 100, 100],
      palette: ['#ffffff', '#b7c8ff', '#ff5566'],
    },
    lightning: {
      type: 'path',
      path: 'M57 4 L22 53 L45 53 L38 96 L78 42 L54 42 Z',
      viewBox: [0, 0, 100, 100],
      palette: ['#f6c95b', '#fff6b8', '#7afcff'],
    },
    aetheris: {
      type: 'path',
      path: 'M50 8 C67 22 79 37 84 56 C68 54 56 62 50 91 C44 62 32 54 16 56 C21 37 33 22 50 8 Z M50 27 C42 38 39 49 40 61 C47 58 53 58 60 61 C61 49 58 38 50 27 Z',
      viewBox: [0, 0, 100, 100],
      palette: ['#7afcff', '#9d7cff', '#f6c95b', '#ffffff'],
    },
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function prefersReducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function injectStyles() {
    if (document.getElementById('full-screen-particles-style')) return;
    const style = document.createElement('style');
    style.id = 'full-screen-particles-style';
    style.textContent = [
      '.full-screen-particles-layer{position:absolute;inset:0;z-index:24;pointer-events:none;overflow:hidden;border-radius:inherit;mix-blend-mode:screen;}',
      '.full-screen-particles-layer canvas{display:block;width:100%;height:100%;}',
      '.full-screen-particles-flash{position:absolute;inset:0;opacity:0;background:radial-gradient(circle at 50% 46%,rgba(255,120,178,.18),transparent 34%),radial-gradient(circle at 50% 52%,rgba(122,252,255,.1),transparent 48%);}',
      '@media (prefers-reduced-motion: reduce){.full-screen-particles-layer{mix-blend-mode:normal;}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function makeSvgPath(pathData) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.style.left = '-9999px';
    svg.style.top = '-9999px';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    document.body.appendChild(svg);
    return { svg, path };
  }

  function sampleSvgPath(shape, count) {
    const total = Math.max(1, Math.round(Number(count) || 1));
    const { svg, path } = makeSvgPath(shape.path);
    const points = [];
    try {
      const length = Math.max(1, path.getTotalLength());
      const [vx, vy, vw, vh] = Array.isArray(shape.viewBox) ? shape.viewBox : [0, 0, 100, 100];
      for (let i = 0; i < total; i += 1) {
        const point = path.getPointAtLength((i / Math.max(1, total - 1)) * length);
        points.push({
          x: ((point.x - vx) / Math.max(1, vw)) - 0.5,
          y: 0.5 - ((point.y - vy) / Math.max(1, vh)),
        });
      }
    } finally {
      svg.remove();
    }
    return points;
  }

  function sampleText(text, count, options = {}) {
    const value = String(text || '').trim();
    if (!value) return [];
    const width = 720;
    const height = 180;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(Number(options.fontSize) || 72)}px Rajdhani, Exo 2, Impact, sans-serif`;
    ctx.fillText(value, width / 2, height / 2);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const candidates = [];
    const step = clamp(Math.round(Number(options.step) || 5), 3, 12);
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const alpha = pixels[(y * width + x) * 4 + 3];
        if (alpha > 32) candidates.push({ x: (x / width) - 0.5, y: 0.5 - (y / height) });
      }
    }
    if (candidates.length <= count) return candidates;
    const stride = candidates.length / Math.max(1, count);
    const points = [];
    for (let i = 0; i < count; i += 1) points.push(candidates[Math.floor(i * stride)]);
    return points;
  }

  function colorToRgb(hex) {
    const value = String(hex || '#ffffff').replace('#', '').trim();
    const full = value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value.padEnd(6, 'f').slice(0, 6);
    const num = Number.parseInt(full, 16);
    return {
      r: ((num >> 16) & 255) / 255,
      g: ((num >> 8) & 255) / 255,
      b: (num & 255) / 255,
    };
  }

  function easeOutCubic(value) {
    const t = clamp(value, 0, 1);
    return 1 - Math.pow(1 - t, 3);
  }

  function easeInQuad(value) {
    const t = clamp(value, 0, 1);
    return t * t;
  }

  class FullScreenParticleEngine {
    constructor(options = {}) {
      this.host = options.host || document.body;
      this.THREE = options.THREE || global.THREE;
      this.gsap = options.gsap || global.gsap;
      this.shapes = new Map(Object.entries(DEFAULT_SHAPES));
      this.effects = new Map();
      this.triggers = new Map();
      this.queue = [];
      this.seen = new Set();
      this.seenOrder = [];
      this.active = null;
      this.cooldownUntil = 0;
      this.maxQueued = Math.max(1, Math.round(Number(options.maxQueued) || 8));
      this.defaultParticleCount = Math.max(120, Math.round(Number(options.particleCount) || 960));
      this.reducedParticleCount = Math.max(60, Math.round(Number(options.reducedParticleCount) || 240));
      this.registerEffect('particleForm', payload => this.playParticleForm(payload));
      this.registerTrigger(DEFAULT_TRIGGER);
    }

    isReady() {
      return Boolean(this.THREE && this.gsap && this.host && this.host.appendChild);
    }

    registerShape(name, shape) {
      const key = String(name || '').trim();
      if (!key || !shape) return false;
      this.shapes.set(key, { ...shape });
      return true;
    }

    registerEffect(name, factory) {
      const key = String(name || '').trim();
      if (!key || typeof factory !== 'function') return false;
      this.effects.set(key, factory);
      return true;
    }

    registerTrigger(config = {}) {
      const trigger = { ...DEFAULT_TRIGGER, ...config };
      const key = `${trigger.trigger}:${trigger.threshold}`;
      this.triggers.set(key, trigger);
      return trigger;
    }

    handleEngagementEvent(trigger, payload = {}) {
      const effects = Array.isArray(payload.fullScreenEffects) ? payload.fullScreenEffects : [];
      if (effects.length) {
        effects.forEach(effect => this.enqueue({ ...effect, payload }));
        return effects.length;
      }
      const milestone = Math.max(0, Math.round(Number(payload.milestone) || 0));
      const triggerConfig = this.triggers.get(`${trigger}:${DEFAULT_TRIGGER.threshold}`) || DEFAULT_TRIGGER;
      if (milestone && milestone % triggerConfig.threshold === 0) {
        this.enqueue({
          ...triggerConfig,
          id: `${trigger}:${milestone}`,
          milestone,
          totalLikes: Math.max(milestone, Math.round(Number(payload.totalLikes) || milestone)),
          payload,
        });
        return 1;
      }
      return 0;
    }

    enqueue(config = {}) {
      if (!this.isReady()) return false;
      const event = { ...DEFAULT_TRIGGER, ...config };
      const id = String(event.id || `${event.trigger}:${event.effect}:${event.milestone || Date.now()}`);
      if (this.seen.has(id)) return false;
      this.remember(id);
      this.queue.push({ ...event, id });
      this.drain();
      return true;
    }

    remember(id) {
      this.seen.add(id);
      this.seenOrder.push(id);
      if (this.seenOrder.length > 120) {
        const old = this.seenOrder.splice(0, this.seenOrder.length - 120);
        old.forEach(value => this.seen.delete(value));
      }
    }

    drain() {
      if (this.active || !this.queue.length) return;
      const waitMs = Math.max(0, this.cooldownUntil - Date.now());
      if (waitMs > 0) {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => this.drain(), waitMs);
        return;
      }
      const next = this.queue.shift();
      const factory = this.effects.get(next.effect);
      if (!factory) {
        this.drain();
        return;
      }
      Promise.resolve(factory(next))
        .catch(() => {})
        .finally(() => {
          this.active = null;
          this.cooldownUntil = Date.now() + Math.max(0, Number(next.cooldown) || 0);
          this.drain();
        });
    }

    buildTargets(config, count, width, height) {
      const shape = this.shapes.get(config.shape) || this.shapes.get('heart');
      const shapeCount = config.text ? Math.round(count * 0.62) : count;
      const textCount = config.text ? Math.max(80, count - shapeCount) : 0;
      const shapePoints = shape?.type === 'path' ? sampleSvgPath(shape, shapeCount) : [];
      const textPoints = sampleText(config.text, textCount, { fontSize: width < 720 ? 54 : 72, step: width < 720 ? 6 : 5 });
      const scale = Math.min(width * 0.72, height * 0.62);
      const points = [];
      shapePoints.forEach(point => {
        points.push({
          x: point.x * scale,
          y: point.y * scale * 0.86 + height * 0.075,
          z: 0,
          group: 'shape',
        });
      });
      textPoints.forEach(point => {
        points.push({
          x: point.x * Math.min(width * 0.64, 720),
          y: point.y * Math.min(height * 0.16, 140) - height * 0.245,
          z: 0,
          group: 'text',
        });
      });
      return points;
    }

    playParticleForm(config = {}) {
      if (!this.isReady()) return Promise.resolve(false);
      this.active = config;
      injectStyles();
      const reduced = prefersReducedMotion();
      const duration = reduced ? Math.min(1400, Math.max(900, Number(config.duration) || 1200)) : Math.max(1800, Number(config.duration) || 2800);
      const hostRect = this.host.getBoundingClientRect();
      const width = Math.max(320, Math.round(hostRect.width || global.innerWidth || 1280));
      const height = Math.max(180, Math.round(hostRect.height || global.innerHeight || 720));
      const count = reduced ? this.reducedParticleCount : this.defaultParticleCount;
      const layer = document.createElement('div');
      layer.className = 'full-screen-particles-layer';
      layer.dataset.effect = config.effect || 'particleForm';
      layer.dataset.trigger = config.trigger || 'engagement';
      layer.dataset.milestone = String(config.milestone || '');
      const flash = document.createElement('div');
      flash.className = 'full-screen-particles-flash';
      layer.appendChild(flash);
      this.host.appendChild(layer);

      const THREE = this.THREE;
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
      renderer.setSize(width, height, false);
      layer.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(width / -2, width / 2, height / 2, height / -2, -1000, 1000);
      camera.position.z = 10;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      const starts = new Float32Array(count * 3);
      const exits = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const targetPoints = this.buildTargets(config, count, width, height);
      const shape = this.shapes.get(config.shape) || this.shapes.get('heart');
      const palette = Array.isArray(config.palette) ? config.palette : (shape?.palette || DEFAULT_SHAPES.heart.palette);

      for (let i = 0; i < count; i += 1) {
        const idx = i * 3;
        const target = targetPoints[i % Math.max(1, targetPoints.length)] || { x: 0, y: 0, z: 0, group: 'shape' };
        const side = Math.floor(Math.random() * 4);
        const sx = side === 0 ? -width * 0.62 : side === 1 ? width * 0.62 : (Math.random() - 0.5) * width * 1.2;
        const sy = side === 2 ? -height * 0.62 : side === 3 ? height * 0.62 : (Math.random() - 0.5) * height * 1.2;
        starts[idx] = sx;
        starts[idx + 1] = sy;
        starts[idx + 2] = (Math.random() - 0.5) * 680;
        positions[idx] = starts[idx];
        positions[idx + 1] = starts[idx + 1];
        positions[idx + 2] = starts[idx + 2];
        exits[idx] = target.x + (Math.random() - 0.5) * width * 1.1;
        exits[idx + 1] = target.y + (Math.random() - 0.5) * height * 1.1;
        exits[idx + 2] = (Math.random() - 0.5) * 900;
        const rgb = colorToRgb(palette[i % palette.length]);
        colors[idx] = rgb.r;
        colors[idx + 1] = rgb.g;
        colors[idx + 2] = rgb.b;
      }

      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({
        size: reduced ? 4.5 : 5.8,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
      });
      const points = new THREE.Points(geometry, material);
      scene.add(points);

      let disposed = false;
      let raf = 0;
      let activeTargets = targetPoints;
      const state = { form: 0, exit: 0, opacity: 0, flash: 0 };

      const resize = () => {
        if (disposed) return;
        const rect = this.host.getBoundingClientRect();
        const nextWidth = Math.max(320, Math.round(rect.width || global.innerWidth || width));
        const nextHeight = Math.max(180, Math.round(rect.height || global.innerHeight || height));
        renderer.setSize(nextWidth, nextHeight, false);
        camera.left = nextWidth / -2;
        camera.right = nextWidth / 2;
        camera.top = nextHeight / 2;
        camera.bottom = nextHeight / -2;
        camera.updateProjectionMatrix();
        activeTargets = this.buildTargets(config, count, nextWidth, nextHeight);
      };

      const render = () => {
        if (disposed) return;
        const form = easeOutCubic(state.form);
        const exit = easeInQuad(state.exit);
        for (let i = 0; i < count; i += 1) {
          const idx = i * 3;
          const target = activeTargets[i % Math.max(1, activeTargets.length)] || { x: 0, y: 0, z: 0 };
          let x = starts[idx] + (target.x - starts[idx]) * form;
          let y = starts[idx + 1] + (target.y - starts[idx + 1]) * form;
          let z = starts[idx + 2] + ((target.z || 0) - starts[idx + 2]) * form;
          if (exit > 0) {
            x += (exits[idx] - target.x) * exit;
            y += (exits[idx + 1] - target.y) * exit;
            z += (exits[idx + 2] - (target.z || 0)) * exit;
          }
          positions[idx] = x;
          positions[idx + 1] = y;
          positions[idx + 2] = z;
        }
        geometry.attributes.position.needsUpdate = true;
        material.opacity = clamp(state.opacity, 0, 1);
        flash.style.opacity = String(clamp(state.flash, 0, 0.8));
        renderer.render(scene, camera);
        raf = requestAnimationFrame(render);
      };

      global.addEventListener('resize', resize, { passive: true });
      global.addEventListener('orientationchange', resize, { passive: true });
      raf = requestAnimationFrame(render);

      return new Promise(resolve => {
        const timeline = this.gsap.timeline({
          onComplete: () => {
            disposed = true;
            cancelAnimationFrame(raf);
            global.removeEventListener('resize', resize);
            global.removeEventListener('orientationchange', resize);
            timeline.kill();
            scene.remove(points);
            geometry.dispose();
            material.dispose();
            renderer.dispose();
            renderer.forceContextLoss?.();
            renderer.domElement.remove();
            layer.remove();
            this.active = null;
            resolve(true);
          },
        });
        const inMs = reduced ? duration * 0.28 : duration * 0.34;
        const holdMs = reduced ? duration * 0.38 : duration * 0.32;
        const outMs = Math.max(250, duration - inMs - holdMs);
        timeline
          .to(state, { form: 1, opacity: 0.98, flash: 0.5, duration: inMs / 1000, ease: 'power3.out' }, 0)
          .to(state, { flash: 0.08, duration: holdMs / 1000, ease: 'sine.out' })
          .to(state, { exit: 1, opacity: 0, flash: 0, duration: outMs / 1000, ease: 'power2.in' });
      });
    }

    getStatus() {
      return {
        ready: this.isReady(),
        active: Boolean(this.active),
        queued: this.queue.length,
        cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
        shapes: Array.from(this.shapes.keys()),
        effects: Array.from(this.effects.keys()),
      };
    }

    dispose() {
      clearTimeout(this.cooldownTimer);
      this.queue.length = 0;
      this.cooldownUntil = 0;
    }
  }

  function createFullScreenParticles(options = {}) {
    return new FullScreenParticleEngine(options);
  }

  const api = Object.freeze({
    createFullScreenParticles,
    DEFAULT_TRIGGER,
    DEFAULT_SHAPES,
  });
  global.IntoTheBattleFullScreenParticles = api;
  global.full_screen_particles = api;
})(window);
