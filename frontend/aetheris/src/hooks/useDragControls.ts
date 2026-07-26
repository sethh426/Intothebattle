import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { ROTATION } from '../config'

interface DragControlsHandle {
  setMotionEnabled: (enabled: boolean) => void
}

// Custom drag-rotate controller (no OrbitControls / examples-jsm dependency — see the
// Aetheris plan doc for why: OrbitControls fights the specific idle-auto-rotate-pauses-
// on-drag behavior we want).
export function useDragControls(wrapperRef: RefObject<THREE.Object3D | null>): DragControlsHandle {
  const { gl } = useThree()
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), [])
  const state = useRef({
    yaw: 0,
    pitch: 0,
    yawVelocity: 0,
    pitchVelocity: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
    idleTimer: 0,
    motionEnabled: true,
  })

  function applyRotation(): void {
    if (!wrapperRef.current) return
    const s = state.current
    euler.set(s.pitch, s.yaw, 0, 'YXZ')
    wrapperRef.current.quaternion.setFromEuler(euler)
  }

  function clampPitch(value: number): number {
    return Math.max(-ROTATION.pitchClampRadians, Math.min(ROTATION.pitchClampRadians, value))
  }

  useEffect(() => {
    const canvas = gl.domElement
    const s = state.current

    // Only the primary pointer drives rotation — a second touch point (pinch-zoom,
    // owned by useCameraRig) must not corrupt this drag state.
    function onPointerDown(event: PointerEvent): void {
      if (!event.isPrimary) return
      s.dragging = true
      s.lastX = event.clientX
      s.lastY = event.clientY
      s.yawVelocity = 0
      s.pitchVelocity = 0
      s.idleTimer = 0
      canvas.setPointerCapture?.(event.pointerId)
    }

    function onPointerMove(event: PointerEvent): void {
      if (!event.isPrimary || !s.dragging) return
      const dx = event.clientX - s.lastX
      const dy = event.clientY - s.lastY
      s.lastX = event.clientX
      s.lastY = event.clientY

      const deltaYaw = dx * ROTATION.dragSensitivity
      const deltaPitch = dy * ROTATION.dragSensitivity
      s.yaw += deltaYaw
      s.pitch = clampPitch(s.pitch + deltaPitch)
      s.yawVelocity = deltaYaw
      s.pitchVelocity = deltaPitch
      applyRotation()
    }

    function onPointerUp(event: PointerEvent): void {
      if (!event.isPrimary) return
      s.dragging = false
      s.idleTimer = 0
      canvas.releasePointerCapture?.(event.pointerId)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.style.touchAction = 'none'

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
    }
  }, [gl])

  useFrame((_, deltaSeconds) => {
    const s = state.current
    if (!s.motionEnabled) return
    if (s.dragging) return

    if (Math.abs(s.yawVelocity) > ROTATION.inertiaStopThreshold || Math.abs(s.pitchVelocity) > ROTATION.inertiaStopThreshold) {
      s.yaw += s.yawVelocity
      s.pitch = clampPitch(s.pitch + s.pitchVelocity)
      s.yawVelocity *= ROTATION.inertiaDamping
      s.pitchVelocity *= ROTATION.inertiaDamping
      applyRotation()
      return
    }

    s.idleTimer += deltaSeconds
    if (s.idleTimer >= ROTATION.idleResumeDelaySeconds) {
      s.yaw += ROTATION.autoRotateRadiansPerSecond * deltaSeconds
      applyRotation()
    }
  })

  function setMotionEnabled(enabled: boolean): void {
    state.current.motionEnabled = enabled
  }

  return { setMotionEnabled }
}
