import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import gsap from 'gsap'
import { CAMERA } from '../config'

export interface CameraRigHandle {
  // 0-1, faded in by the intro timeline (or fixed at 1 under reduced motion).
  introOpacityRef: RefObject<number>
  // Current camera distance from the origin — also the "zoom level" other systems
  // (particle LOD) read for a distance-driven density multiplier.
  zoomDistanceRef: RefObject<number>
  // 0-1, one-shot flash intensity for the intro's flagship-territory beat, decaying to 0.
  flashRef: RefObject<number>
}

// Owns the camera's distance from the planet: a one-time cinematic dolly-in on mount,
// then ongoing user-controlled zoom (wheel + touch pinch) for the rest of the session.
// Camera orientation (drag-to-rotate) stays owned by useDragControls on the wrapper
// group — this hook only ever moves the camera along its existing view direction.
export function useCameraRig(reducedMotion: boolean): CameraRigHandle {
  const { camera, gl } = useThree()
  const distanceRef = useRef(reducedMotion ? CAMERA.restDistance : CAMERA.introDistance)
  const introOpacityRef = useRef(reducedMotion ? 1 : 0)
  const flashRef = useRef(0)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const lastPinchDistanceRef = useRef(0)

  useEffect(() => {
    camera.position.set(0, 0, distanceRef.current)
  }, [camera])

  useEffect(() => {
    if (reducedMotion) {
      distanceRef.current = CAMERA.restDistance
      introOpacityRef.current = 1
      flashRef.current = 0
      return
    }

    const timeline = gsap.timeline({
      onComplete: () => {
        flashRef.current = 1
        gsap.to(flashRef, { current: 0, duration: 1.0, ease: 'power2.out' })
      },
    })
    timeline.to(
      distanceRef,
      { current: CAMERA.restDistance, duration: CAMERA.introDurationSeconds, ease: 'power2.out' },
      0,
    )
    timeline.to(introOpacityRef, { current: 1, duration: CAMERA.introDurationSeconds, ease: 'power2.out' }, 0)

    return () => {
      timeline.kill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion])

  useEffect(() => {
    const canvas = gl.domElement
    const pointers = pointersRef.current

    function clampDistance(value: number): number {
      return Math.max(CAMERA.zoomMinDistance, Math.min(CAMERA.zoomMaxDistance, value))
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault()
      distanceRef.current = clampDistance(distanceRef.current + event.deltaY * 0.01)
    }

    function pinchDistance(): number {
      const points = Array.from(pointers.values())
      if (points.length < 2) return 0
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
    }

    // Only tracks touch pointers; single-finger drag-to-rotate stays owned by
    // useDragControls (which ignores non-primary pointers so a second touch here
    // doesn't corrupt its drag state — see useDragControls.ts).
    function onPointerDown(event: PointerEvent): void {
      if (event.pointerType !== 'touch') return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) lastPinchDistanceRef.current = pinchDistance()
    }

    function onPointerMove(event: PointerEvent): void {
      if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) {
        const distance = pinchDistance()
        const last = lastPinchDistanceRef.current
        if (last > 0) {
          distanceRef.current = clampDistance(distanceRef.current + (last - distance) * 0.02)
        }
        lastPinchDistanceRef.current = distance
      }
    }

    function onPointerUp(event: PointerEvent): void {
      pointers.delete(event.pointerId)
      lastPinchDistanceRef.current = 0
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
    }
  }, [gl])

  useFrame(() => {
    camera.position.setLength(distanceRef.current)
  })

  return { introOpacityRef, zoomDistanceRef: distanceRef, flashRef }
}
