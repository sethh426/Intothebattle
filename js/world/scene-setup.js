import * as THREE from 'three';
import { CAMERA } from './config.js';

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = null; // transparent, lets the .globe-frame CSS background show through
  return scene;
}

export function createCamera(aspect) {
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
  camera.position.set(0, 0, CAMERA.distance);
  return camera;
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

export function createLightingRig(scene) {
  const ambient = new THREE.AmbientLight(0x8899bb, 0.55);
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.4);
  sun.position.set(4, 2, 3);
  scene.add(ambient, sun);
  return { ambient, sun };
}
