import * as THREE from 'three';
import { BIOMES } from './biome-data.js';
import { generateTerritories } from './territory-data.js';
import { createPlanetMesh } from './planet-geometry.js';
import { buildTerritoryMeshes } from './territory-mesh.js';
import { createScene, createCamera, createRenderer, createLightingRig } from './scene-setup.js';
import { createDayNightCycle } from './day-night-cycle.js';
import { createFlagshipParticleSystems } from './particles/flagship-biomes.js';
import { createAmbientParticleSystems } from './particles/ambient-biomes.js';
import { createDragControls } from './controls.js';
import { createInteraction } from './interaction.js';
import { quickPerfTier, createFpsMonitor, tierFromFps, applyPerfTier } from './perf-tier.js';
import { detectWebglSupport, watchReducedMotion, showPosterFallback } from './webgl-fallback.js';
import { WORLD_SEED } from './config.js';

const MAX_DELTA_SECONDS = 0.1; // clamp so a backgrounded-tab resume doesn't jump particles/rotation

function init() {
  const mount = document.getElementById('world-globe-mount');
  const canvas = document.getElementById('world-globe-canvas');
  const poster = document.getElementById('world-globe-poster');
  const tooltip = document.getElementById('world-globe-tooltip');
  if (!mount || !canvas) return;

  if (!detectWebglSupport()) {
    showPosterFallback(canvas, poster);
    return;
  }

  const territories = generateTerritories(BIOMES, WORLD_SEED);

  const scene = createScene();
  const camera = createCamera(mount.clientWidth / mount.clientHeight || 1);
  const renderer = createRenderer(canvas);
  renderer.setSize(mount.clientWidth, mount.clientHeight, false);

  const { sun } = createLightingRig(scene);

  const wrapperGroup = new THREE.Group();
  scene.add(wrapperGroup);

  const planetMesh = createPlanetMesh(BIOMES);
  wrapperGroup.add(planetMesh);

  const { group: territoryGroup, territoryIndex, meshByShapeId, instanceLookup } = buildTerritoryMeshes(territories, BIOMES);
  wrapperGroup.add(territoryGroup);

  const particleSystems = [...createFlagshipParticleSystems(), ...createAmbientParticleSystems()];
  particleSystems.forEach(({ system }) => wrapperGroup.add(system.points));

  let tier = quickPerfTier();
  applyPerfTier(tier, particleSystems);

  const fpsMonitor = createFpsMonitor((fps) => {
    const measuredTier = tierFromFps(fps);
    const rank = { low: 0, medium: 1, high: 2 };
    if (rank[measuredTier] < rank[tier]) {
      tier = measuredTier;
      applyPerfTier(tier, particleSystems);
    }
  });

  const dayNightCycle = createDayNightCycle(sun, wrapperGroup, territories, instanceLookup, meshByShapeId);
  const controls = createDragControls(canvas, wrapperGroup);
  createInteraction({ canvas, camera, meshByShapeId, territoryIndex, tooltipEl: tooltip });

  let reducedMotion = false;
  watchReducedMotion((matches) => {
    reducedMotion = matches;
    controls.setMotionEnabled(!matches);
  });

  let isVisible = true;
  let rafId = null;
  let lastTime = performance.now();

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const deltaSeconds = Math.min((now - lastTime) / 1000, MAX_DELTA_SECONDS);
    lastTime = now;

    controls.update(deltaSeconds);
    fpsMonitor.sample(deltaSeconds);

    if (!reducedMotion) {
      dayNightCycle.update(deltaSeconds);
      particleSystems.forEach(({ system }) => system.update(deltaSeconds));
    }

    renderer.render(scene, camera);
  }

  function start() {
    if (rafId != null) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId == null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      isVisible = entries.some((entry) => entry.isIntersecting);
      if (isVisible && document.visibilityState === 'visible') start();
      else stop();
    }, { threshold: 0.01 });
    observer.observe(mount);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isVisible) start();
    else stop();
  });

  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(() => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    });
    resizeObserver.observe(mount);
  }

  start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
