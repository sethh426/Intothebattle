import * as THREE from 'three';
import { getBiomeById } from './biome-data.js';

// Raycasts against the territory InstancedMeshes and shows a small DOM tooltip with mock
// creator/biome/live data. No navigation, no network calls — purely local.
export function createInteraction({ canvas, camera, meshByShapeId, territoryIndex, tooltipEl }) {
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const meshes = Array.from(meshByShapeId.values());
  let lastTerritory = null;

  function territoryForIntersection(intersection) {
    if (intersection.instanceId == null) return null;
    const shapeId = intersection.object.userData.shapeId;
    return territoryIndex.get(`${shapeId}::${intersection.instanceId}`) || null;
  }

  function positionTooltip(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    tooltipEl.style.left = `${clientX - rect.left}px`;
    tooltipEl.style.top = `${clientY - rect.top}px`;
  }

  function showTooltip(territory) {
    const biome = getBiomeById(territory.biomeId);
    tooltipEl.innerHTML = `
      <strong>${territory.creatorName}</strong>
      <span>${biome ? biome.name : ''}</span>
      <span class="globe-tooltip-badge ${territory.isLive ? 'is-live' : 'is-offline'}">${territory.isLive ? 'Live' : 'Offline'}</span>
    `;
    tooltipEl.hidden = false;
  }

  function hideTooltip() {
    tooltipEl.hidden = true;
    lastTerritory = null;
  }

  function raycastAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const intersections = raycaster.intersectObjects(meshes, false);
    return intersections.length > 0 ? territoryForIntersection(intersections[0]) : null;
  }

  function onPointerMove(event) {
    const territory = raycastAt(event.clientX, event.clientY);
    if (!territory) {
      if (lastTerritory) hideTooltip();
      return;
    }
    if (territory !== lastTerritory) {
      lastTerritory = territory;
      showTooltip(territory);
    }
    positionTooltip(event.clientX, event.clientY);
  }

  function onPointerLeave() {
    hideTooltip();
  }

  function onClick(event) {
    const territory = raycastAt(event.clientX, event.clientY);
    if (!territory) return;
    lastTerritory = territory;
    showTooltip(territory);
    positionTooltip(event.clientX, event.clientY);
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);

  function destroy() {
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('click', onClick);
  }

  return { destroy };
}
