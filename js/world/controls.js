import * as THREE from 'three';
import { ROTATION } from './config.js';

// Custom drag-rotate controller (no OrbitControls / examples-jsm dependency — see plan doc
// for why: OrbitControls fights the specific idle-auto-rotate-pauses-on-drag behavior we want).
export function createDragControls(canvas, wrapperGroup, config = ROTATION) {
  let yaw = 0;
  let pitch = 0;
  let yawVelocity = 0;
  let pitchVelocity = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let idleTimer = 0;
  let autoRotateEnabled = true;
  let motionEnabled = true;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function applyRotation() {
    euler.set(pitch, yaw, 0, 'YXZ');
    wrapperGroup.quaternion.setFromEuler(euler);
  }

  function clampPitch(value) {
    return Math.max(-config.pitchClampRadians, Math.min(config.pitchClampRadians, value));
  }

  function onPointerDown(event) {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    yawVelocity = 0;
    pitchVelocity = 0;
    idleTimer = 0;
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    const deltaYaw = dx * config.dragSensitivity;
    const deltaPitch = dy * config.dragSensitivity;
    yaw += deltaYaw;
    pitch = clampPitch(pitch + deltaPitch);
    yawVelocity = deltaYaw;
    pitchVelocity = deltaPitch;
    applyRotation();
  }

  function onPointerUp(event) {
    dragging = false;
    idleTimer = 0;
    canvas.releasePointerCapture?.(event.pointerId);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  function update(deltaSeconds) {
    if (!motionEnabled) return;

    if (dragging) return;

    if (Math.abs(yawVelocity) > config.inertiaStopThreshold || Math.abs(pitchVelocity) > config.inertiaStopThreshold) {
      yaw += yawVelocity;
      pitch = clampPitch(pitch + pitchVelocity);
      yawVelocity *= config.inertiaDamping;
      pitchVelocity *= config.inertiaDamping;
      applyRotation();
      return;
    }

    idleTimer += deltaSeconds;
    if (autoRotateEnabled && idleTimer >= config.idleResumeDelaySeconds) {
      yaw += config.autoRotateRadiansPerSecond * deltaSeconds;
      applyRotation();
    }
  }

  function setMotionEnabled(enabled) {
    motionEnabled = enabled;
    autoRotateEnabled = enabled;
  }

  function destroy() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
  }

  applyRotation();

  return { update, setMotionEnabled, destroy };
}
