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
