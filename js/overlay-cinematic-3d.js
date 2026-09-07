import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HEROES, stableHeroForPlayer, modelUrl } from './overlay-hero-catalog.js';

const container = document.getElementById('overlay-container');
const canvas = document.getElementById('cinematic-canvas');
const hud = document.getElementById('cinematic-hud');
const takeover = document.getElementById('cinematic-takeover');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const query = new URLSearchParams(location.search);
const perfTier = query.get('perf') || (innerWidth < 900 ? 'low' : 'high');
const lod = perfTier === 'high' ? 0 : perfTier === 'medium' ? 1 : 2;
const slots = [-5.25, -3.15, -1.05, 1.05, 3.15, 5.25];
const loader = new GLTFLoader();
const models = new Map();
const artPlanes = new Map();
const reactions = new Map();
const mixers = new Map();
const loadFailures = [];
let latest = { players: [], horde: null, boss: null, hostHeroId: HEROES[0].id };
let active = false;
let hudSignature = '';

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: perfTier !== 'low', powerPreference: 'high-performance', preserveDrawingBuffer: location.pathname.includes('preview') });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, perfTier === 'high' ? 1.5 : 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  active = true;
} catch (error) {
  loadFailures.push(`webgl:${error.message}`);
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 60);
camera.position.set(0, 2.5, 13.4);
camera.lookAt(0, 1.1, 0);
scene.add(new THREE.HemisphereLight(0xc9ddff, 0x080b15, 1.75));
const cool = new THREE.DirectionalLight(0x91cfff, 3.2); cool.position.set(-5, 7, 7); scene.add(cool);
const warm = new THREE.DirectionalLight(0xffb45f, 2.7); warm.position.set(5, 6, 5); scene.add(warm);

const floor = new THREE.Mesh(new THREE.CircleGeometry(8.2, 64), new THREE.MeshStandardMaterial({ color: 0x07101e, metalness: .72, roughness: .34, transparent: true, opacity: .88 }));
floor.rotation.x = -Math.PI / 2; floor.position.set(0, -.03, 0); scene.add(floor);
const grid = new THREE.GridHelper(16, 20, 0x738dca, 0x24304f); grid.material.transparent = true; grid.material.opacity = .24; scene.add(grid);

function loadScene(url, key, position, scale = 1) {
  return new Promise(resolve => loader.load(url, gltf => {
    const root = gltf.scene;
    root.position.copy(position); root.scale.setScalar(scale); root.visible = false;
    root.traverse(node => { if (node.isMesh) { node.frustumCulled = true; node.renderOrder = 2; } });
    scene.add(root); models.set(key, { root, clips: gltf.animations, current: '' });
    if (gltf.animations.length) mixers.set(key, new THREE.AnimationMixer(root));
    resolve(root);
  }, undefined, error => { loadFailures.push(`${key}:${error?.message || 'load'}`); resolve(null); }));
}

function loadArt(url, key, position, size, order = 3) {
  return new Promise(resolve => new THREE.TextureLoader().load(url, texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map:texture, transparent:true, alphaTest:.035, depthWrite:false, toneMapped:false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
    plane.position.copy(position); plane.renderOrder=order; plane.visible=false; scene.add(plane); artPlanes.set(key,plane); resolve(plane);
  }, undefined, error => { loadFailures.push(`${key}-art:${error?.message || 'load'}`); resolve(null); }));
}

const ready = Promise.all([
  ...HEROES.map((hero, index) => loadScene(modelUrl(hero.id, lod), hero.id, new THREE.Vector3(slots[index], 0, index % 2 ? -.15 : .05), 1.08)),
  loadScene(`/assets/overlay-cinematic/models/prismatic-portal-lod${lod}.glb`, 'portal', new THREE.Vector3(0, 1.5, -3.2), .82),
  ...[1,2,3].map((n, i) => loadScene(`/assets/overlay-cinematic/models/rift-creature-${n}-lod${lod}.glb`, `horde-${n}`, new THREE.Vector3((i-1)*1.2, .25, -2.2), .72)),
  loadScene(`/assets/overlay-cinematic/models/celestial-regent-lod${lod}.glb`, 'boss', new THREE.Vector3(0, .1, -1.6), .8),
  ...HEROES.map((hero,index) => loadArt(`/assets/overlay-cinematic/portraits/${hero.id}.webp`,hero.id,new THREE.Vector3(slots[index],2.35,.15),[3.05,4.88],4)),
  loadArt('/assets/overlay-cinematic/portraits/prismatic-horde-portal.webp','portal-art',new THREE.Vector3(0,3.8,-2.8),[5.7,3.2],1),
  loadArt('/assets/overlay-cinematic/portraits/celestial-rift-regent.webp','boss-art',new THREE.Vector3(0,2.55,-1.4),[3.55,5.35],2),
]).then(() => {
  if (active) container.classList.add('cinematic-ready');
  const pending=window.__pendingCinematicTakeover;
  if(active&&pending){
    delete window.__pendingCinematicTakeover;
    showTakeover(pending.content,pending.duration);
  }
});

function play(key, clipName) {
  const record = models.get(key); const mixer = mixers.get(key);
  if (!record || !mixer || record.current === clipName) return;
  const clip = THREE.AnimationClip.findByName(record.clips, clipName) || record.clips[0];
  if (!clip) return;
  mixer.stopAllAction(); mixer.clipAction(clip).reset().fadeIn(.2).play(); record.current = clipName;
}

function layoutRoster(players) {
  const used=new Set();
  const assigned=players.slice(0,6).map((player,index)=>{
    const selected=index===0 && HEROES.some(hero=>hero.id===latest.hostHeroId) ? latest.hostHeroId : null;
    const pool=HEROES.map(hero=>hero.id).filter(id=>!used.has(id));
    const preferred=selected || stableHeroForPlayer(player?.uniqueId,index,latest.hostHeroId);
    const preferredIndex=Math.max(0,pool.indexOf(preferred));
    const id=pool[preferredIndex] || pool[0] || HEROES[index%HEROES.length].id;
    used.add(id);
    return {player,hero:HEROES.find(hero=>hero.id===id)||HEROES[index],sourceIndex:index};
  });
  const factionSlot={prismatic:0,solar:3};
  return assigned.sort((a,b)=>(a.hero.faction===b.hero.faction ? a.sourceIndex-b.sourceIndex : a.hero.faction==='prismatic' ? -1 : 1)).map(entry=>({
    ...entry,
    slotIndex:factionSlot[entry.hero.faction]++,
  }));
}

function reactionFor(type, alive) {
  if (alive === false) return 'KO';
  const key=String(type||'').toLowerCase();
  if (key.includes('heal') || key==='boost' || key==='respawn') return 'heal';
  if (key.includes('shield') || key==='follow') return 'shield';
  if (key.includes('hit') || key.includes('critical') || key==='kill') return 'hit';
  if (key.includes('attack') || key.includes('strike') || key.includes('blast')) return 'attack';
  return 'idle';
}

function triggerReaction(id, type, slotX) {
  const plane=artPlanes.get(id); if(!plane)return;
  const previous=reactions.get(id);
  if(previous?.type===type){previous.slotX=slotX;return;}
  reactions.set(id,{type,started:performance.now(),slotX});
}

function syncHud(players) {
  const roster=layoutRoster(players);
  const signature = JSON.stringify(roster.map(({player,hero,slotIndex}) => [hero.id,slotIndex,player.uniqueId,player.nickname,player.hp,player.maxHp,player.kills,player.alive,player.cardAccentLabel]));
  if (signature === hudSignature) return;
  hudSignature = signature;
  hud.replaceChildren();
  roster.forEach(({player,hero,slotIndex}) => {
    const hp = Math.max(0, Number(player.hp) || 0); const max = Math.max(1, Number(player.maxHp) || 1);
    const item = document.createElement('div'); item.className = `cinematic-fighter-hud ${hero.faction}`;
    item.style.setProperty('--slot', `${(slotIndex + .5) / 6 * 100}%`); item.style.setProperty('--hp', `${hp / max * 100}%`); item.style.setProperty('--accent', hero.accent);
    item.innerHTML = `<div class="cinematic-name"><b>${escapeText(player.nickname || player.uniqueId || hero.name)}</b><span>#${slotIndex + 1}</span></div><div class="cinematic-health"><i></i><strong>${Math.round(hp)} HP</strong></div><div class="cinematic-meta"><span>${hero.role}</span><span>${Math.max(0, Number(player.kills)||0)} KILLS</span><span>${escapeText(player.cardAccentLabel || (player.alive === false ? 'KO' : 'READY'))}</span></div>`;
    hud.appendChild(item);
  });
}

function escapeText(value) { const el=document.createElement('span'); el.textContent=String(value); return el.innerHTML; }

function sync(next = {}) {
  latest = { ...latest, ...next, players: Array.isArray(next.players) ? next.players : latest.players };
  if (!active) return false;
  const visible = new Set();
  layoutRoster(latest.players).forEach(({player,hero,slotIndex}) => {
    const id=hero.id; const record=models.get(id); const art=artPlanes.get(id);
    if (art) { art.position.x=slots[slotIndex]; art.visible=true; visible.add(id); }
    else if (record) { record.root.position.x=slots[slotIndex]; record.root.visible=true; visible.add(id); }
    const reaction=reactionFor(player.cardAccentType,player.alive);
    play(id,reaction);
    triggerReaction(id,reaction,slots[slotIndex]);
  });
  HEROES.forEach(hero => { const record=models.get(hero.id); const art=artPlanes.get(hero.id); if(record) record.root.visible=false; if(art && !visible.has(hero.id)) art.visible=false; });
  const hordeVisible=Boolean(latest.horde); ['portal','horde-1','horde-2','horde-3'].forEach(key => { const r=models.get(key); if(r) r.root.visible=false; });
  const portalArt=artPlanes.get('portal-art'); if(portalArt) portalArt.visible=hordeVisible;
  const bossArt=artPlanes.get('boss-art'); if(bossArt) bossArt.visible=Boolean(latest.boss?.active);
  const boss=models.get('boss'); if(boss) boss.root.visible=false;
  syncHud(latest.players);
  return true;
}

let takeoverTimer = 0;
function showTakeover(content = {}, duration = 1900) {
  if (!takeover) return;
  takeover.style.backgroundImage = "url('/assets/overlay-cinematic/portraits/prismatic-takeover-map.webp')";
  takeover.querySelector('small').textContent = content.kicker || 'Realm surge';
  takeover.querySelector('strong').textContent = content.title || 'AREA TAKEOVER';
  takeover.classList.add('active');
  clearTimeout(takeoverTimer);
  takeoverTimer = setTimeout(() => takeover.classList.remove('active'), Math.min(2400, Math.max(1400, Number(duration) || 1900)));
}

function pulseHorde() {
  const portal = artPlanes.get('portal-art');
  if (!portal) return;
  portal.scale.setScalar(1.08);
  setTimeout(() => portal.scale.setScalar(1), reducedMotion ? 0 : 420);
}

function resize() { if(!renderer) return; const rect=container.getBoundingClientRect(); renderer.setSize(rect.width,rect.height,false); camera.aspect=rect.width/Math.max(1,rect.height); camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(container); resize();
const clock=new THREE.Clock(); let frames=0; let fps=0; let sample=performance.now();
function render() {
  requestAnimationFrame(render);
  if (!active) return;
  const dt=Math.min(.05,clock.getDelta());
  mixers.forEach(m=>m.update(dt));
  const now=performance.now();
  const t=now*.001;
  artPlanes.forEach((plane,key)=>{
    if(key==='portal-art'||key==='boss-art') return;
    const reaction=reactions.get(key)||{type:'idle',started:now,slotX:plane.position.x};
    const age=Math.min(1,(now-reaction.started)/520);
    const wave=Math.sin(age*Math.PI);
    let sx=1,sy=1,dx=0,rotation=0,opacity=1;
    if(!reducedMotion){
      plane.position.y=2.35+Math.sin(t*1.25+(reaction.slotX||0))*.035;
      if(reaction.type==='attack'){sx=1+.09*wave;sy=1+.04*wave;dx=((reaction.slotX||0)<0?1:-1)*.18*wave;}
      if(reaction.type==='hit'){sx=1-.07*wave;sy=1-.03*wave;rotation=((reaction.slotX||0)<0?-1:1)*.035*wave;}
      if(reaction.type==='heal') sy=1+.07*wave;
      if(reaction.type==='shield') sx=sy=1+.045*wave;
    }
    if(reaction.type==='KO'){rotation=(reaction.slotX||0)<0?-.06:.06;opacity=.48;}
    plane.position.x=(reaction.slotX ?? plane.position.x)+dx;
    plane.scale.set(sx,sy,1);
    plane.rotation.z=rotation;
    plane.material.opacity=opacity;
  });
  if(!reducedMotion){
    const portal=artPlanes.get('portal-art');
    if(portal) portal.material.opacity=.92+Math.sin(t*1.8)*.06;
    const boss=artPlanes.get('boss-art');
    if(boss) boss.position.y=2.55+Math.sin(t*.9)*.025;
  }
  renderer.render(scene,camera);
  frames++;
  if(now-sample>1000){fps=frames*1000/(now-sample);frames=0;sample=now;}
}
render();

window.overlayCinematic3D = { active: () => active && container.classList.contains('cinematic-ready'), ready, sync, showTakeover, pulseHorde, diagnostics: () => ({ active, perfTier, lod, fps: Math.round(fps), drawCalls: renderer?.info.render.calls || 0, triangles: renderer?.info.render.triangles || 0, loadedAssets: models.size + artPlanes.size, loadFailures: [...loadFailures], bossVisible: Boolean(artPlanes.get('boss-art')?.visible), portalVisible: Boolean(artPlanes.get('portal-art')?.visible), visibleHeroes: HEROES.filter(hero=>artPlanes.get(hero.id)?.visible).map(hero=>hero.id) }) };
