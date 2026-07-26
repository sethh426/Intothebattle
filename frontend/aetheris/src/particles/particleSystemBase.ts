import * as THREE from 'three'

export interface ParticleState {
  positions: Float32Array
  velocities: Float32Array
  colors: Float32Array
  sizes: Float32Array
  life: Float32Array
  maxLife: Float32Array
  count: number
}

export type RespawnFn = (index: number, state: ParticleState) => void

export interface ParticleSystemHandle {
  points: THREE.Points
  update: (deltaSeconds: number) => void
  setActiveCount: (activeCount: number) => void
  count: number
}

let sharedSpriteTexture: THREE.CanvasTexture | null = null
function getSpriteTexture(): THREE.CanvasTexture {
  if (sharedSpriteTexture) return sharedSpriteTexture
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.65)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  sharedSpriteTexture = new THREE.CanvasTexture(canvas)
  return sharedSpriteTexture
}

const VERTEX_SHADER = `
  attribute float pSize;
  attribute vec3 pColor;
  attribute float pLifeRatio;
  varying vec3 vColor;
  varying float vLifeRatio;
  void main() {
    vColor = pColor;
    vLifeRatio = pLifeRatio;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // 300.0 here was a generic example-code constant left uncalibrated for this scene's
    // scale (PLANET.radius = 2, camera ~3-5 units out) — it produced 200px+ blown-out
    // glow blobs instead of small sparkle dots. 8.0 keeps pSize's small values (~1.5-6)
    // reading as actual few-pixel-scale particles at this camera distance.
    gl_PointSize = pSize * (8.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const FRAGMENT_SHADER = `
  uniform sampler2D map;
  varying vec3 vColor;
  varying float vLifeRatio;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    float fade = smoothstep(0.0, 0.15, vLifeRatio) * smoothstep(0.0, 0.15, 1.0 - vLifeRatio);
    gl_FragColor = vec4(vColor, tex.a * fade);
  }
`

interface CreateParticleSystemOptions {
  count: number
  respawn: RespawnFn
  blending?: THREE.Blending
}

// A shared THREE.Points emitter: buffer-attribute updates in one pass per frame (no
// per-particle object churn). Callers provide `respawn(index, state)` to place a biome's
// particles into position/velocity/color/size/life — this module only owns the generic
// advance-and-recycle mechanics and the soft-sprite shader.
export function createParticleSystem({ count, respawn, blending = THREE.AdditiveBlending }: CreateParticleSystemOptions): ParticleSystemHandle {
  const positions = new Float32Array(count * 3)
  const velocities = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const life = new Float32Array(count)
  const maxLife = new Float32Array(count)
  const state: ParticleState = { positions, velocities, colors, sizes, life, maxLife, count }

  for (let i = 0; i < count; i += 1) respawn(i, state)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('pColor', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('pSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('pLifeRatio', new THREE.BufferAttribute(new Float32Array(count), 1))

  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: getSpriteTexture() } },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false

  function update(deltaSeconds: number): void {
    const lifeRatioArray = (geometry.attributes.pLifeRatio as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < count; i += 1) {
      life[i] -= deltaSeconds
      if (life[i] <= 0) {
        respawn(i, state)
        continue
      }
      positions[i * 3] += velocities[i * 3] * deltaSeconds
      positions[i * 3 + 1] += velocities[i * 3 + 1] * deltaSeconds
      positions[i * 3 + 2] += velocities[i * 3 + 2] * deltaSeconds
      lifeRatioArray[i] = 1 - life[i] / maxLife[i]
    }
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.pLifeRatio.needsUpdate = true
  }

  function setActiveCount(activeCount: number): void {
    geometry.setDrawRange(0, Math.max(0, Math.min(count, activeCount)))
  }

  return { points, update, setActiveCount, count }
}
