import * as THREE from 'three';
import { DAY_NIGHT } from './config.js';
import { latLonToVector3 } from './territory-mesh.js';

const tmpWorldPos = new THREE.Vector3();
const tmpLocalSunDir = new THREE.Vector3();
const tmpColor = new THREE.Color();

// Slowly orbits the sun light and, each frame, brightens any live territory's instance
// color when its face has rotated onto the dark side — the "kingdom lights up at night" cue.
export function createDayNightCycle(sunLight, wrapperGroup, territories, instanceLookup, meshByShapeId) {
  let angle = 0;
  const liveTerritories = territories.filter((t) => t.isLive);
  const liveNormals = new Map(liveTerritories.map((t) => [t.id, latLonToVector3(t.lat, t.lon, 1)]));

  function update(deltaSeconds) {
    angle += (Math.PI * 2 * deltaSeconds) / DAY_NIGHT.cycleSeconds;

    sunLight.position.set(
      Math.cos(angle) * DAY_NIGHT.orbitRadius,
      Math.sin(DAY_NIGHT.orbitTiltRadians) * DAY_NIGHT.orbitRadius,
      Math.sin(angle) * DAY_NIGHT.orbitRadius,
    );

    if (liveTerritories.length === 0) return;

    tmpWorldPos.copy(sunLight.position);
    wrapperGroup.worldToLocal(tmpWorldPos);
    tmpLocalSunDir.copy(tmpWorldPos).normalize();

    liveTerritories.forEach((territory) => {
      const entry = instanceLookup.get(territory.id);
      const normal = liveNormals.get(territory.id);
      if (!entry || !normal) return;
      const mesh = meshByShapeId.get(entry.shapeId);
      if (!mesh) return;

      const isNightSide = normal.dot(tmpLocalSunDir) < 0.05;
      tmpColor.copy(entry.baseColor);
      if (isNightSide) tmpColor.multiplyScalar(DAY_NIGHT.nightLiveBoost);
      mesh.setColorAt(entry.instanceIndex, tmpColor);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  return { update };
}
