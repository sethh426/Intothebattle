import * as THREE from 'three'

const DEG2RAD = Math.PI / 180

export function latLonToVector3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * DEG2RAD
  const theta = (lon + 180) * DEG2RAD
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

export function offsetLatLon(lat: number, lon: number, northDegrees: number, eastDegrees: number): { lat: number; lon: number } {
  const nextLat = THREE.MathUtils.clamp(lat + northDegrees, -89.5, 89.5)
  const lonScale = Math.max(0.2, Math.cos(THREE.MathUtils.degToRad(nextLat)))
  let nextLon = lon + eastDegrees / lonScale
  while (nextLon > 180) nextLon -= 360
  while (nextLon < -180) nextLon += 360
  return { lat: nextLat, lon: nextLon }
}
