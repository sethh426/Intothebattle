(function () {
  const params = new URLSearchParams(window.location.search);
  const requestedLayout = (params.get('layout') || 'horizontal').toLowerCase();
  const requestedRender = (params.get('render') || '1080p').toLowerCase();
  const demoMode = params.get('demo') === '1' || params.get('preview') === '1' || params.get('setup') === '1' || window.location.pathname.includes('preview');
  if (params.get('debug') === '1' || params.get('show_status') === '1') {
    document.body.classList.add('show-overlay-status');
  }
  if (params.get('source') === '1' || params.get('browser_source') === '1') {
    document.body.classList.add('source-mode');
  }

  const layouts = {
    horizontal: { width: 1920, height: 1080, cssClass: '' },
    '1080p': { width: 1920, height: 1080, cssClass: '' },
    '1440p': { width: 2560, height: 1440, cssClass: '' },
    '2160p': { width: 3840, height: 2160, cssClass: '' },
    vertical: { width: 1080, height: 1920, cssClass: 'layout-vertical' },
    compact: { width: 2100, height: 900, cssClass: 'layout-compact' },
  };

  function pickStage() {
    if (requestedLayout === 'vertical') return layouts.vertical;
    if (requestedLayout === 'compact') return layouts.compact;
    return layouts[requestedRender] || layouts.horizontal;
  }

  const stage = pickStage();
  if (stage.cssClass) document.body.classList.add(stage.cssClass);

  const statusBadge = document.getElementById('status-badge');
  function setStatus(text, className) {
    if (!statusBadge) return;
    statusBadge.textContent = text;
    statusBadge.className = className || '';
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function hexToNumber(value, fallback = 0x7afcff) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim().replace('#', '');
    const parsed = Number.parseInt(trimmed, 16);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatClockMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function escapeName(value) {
    return String(value || 'Player').trim().slice(0, 18) || 'Player';
  }

  const DEFAULT_AETHERIS_TERRITORY_ID = 'emberfall-forge';
  const AETHERIS_TERRITORY_THEMES = Object.freeze({
    'emberfall-forge': Object.freeze({
      id: 'emberfall-forge',
      name: 'Emberfall Forge',
      faction: 'Forgeguard',
      subtitle: 'FORGEGUARD HOLD THE LINE',
      pressureLabel: 'FORGE PRESSURE',
      primary: 0xff6a3d,
      secondary: 0xf6c95b,
      deep: 0x140807,
      ambient: 0x541824,
      ambientAlt: 0x321425,
      panel: 0x541824,
      panelTop: 0x9d3140,
      label: 0xa7182c,
      badge: 0x202432,
      text: '#fff0b9',
      muted: '#ffd37a',
      code: '#9d7f70',
      structures: ['Iron gate', 'Smelter tower', 'Siege gantry'],
    }),
    'stormglass-coast': Object.freeze({
      id: 'stormglass-coast',
      name: 'Stormglass Coast',
      faction: 'Tidecallers',
      subtitle: 'TIDECALLERS BEND THE STORM',
      pressureLabel: 'STORM PRESSURE',
      primary: 0x55e7ff,
      secondary: 0x9ff5ff,
      deep: 0x06121b,
      ambient: 0x12425a,
      ambientAlt: 0x103460,
      panel: 0x12425a,
      panelTop: 0x1d7892,
      label: 0x0f8fb1,
      badge: 0x172a36,
      text: '#e4fbff',
      muted: '#9ff5ff',
      code: '#78cfe0',
      structures: ['Breaker wall', 'Glass beacon', 'Tempest spire'],
    }),
    'verdant-crown': Object.freeze({
      id: 'verdant-crown',
      name: 'Verdant Crown',
      faction: 'Crownwardens',
      subtitle: 'CROWNWARDENS RECLAIM THE GROVE',
      pressureLabel: 'CROWN PRESSURE',
      primary: 0x77f0a1,
      secondary: 0xd6f66b,
      deep: 0x07150c,
      ambient: 0x214b2e,
      ambientAlt: 0x243f1c,
      panel: 0x214b2e,
      panelTop: 0x3b8f54,
      label: 0x31964a,
      badge: 0x172a1c,
      text: '#ecffe5',
      muted: '#d6f66b',
      code: '#95d8a8',
      structures: ['Briar palisade', 'Living watchtree', 'Crownheart shrine'],
    }),
    'umbral-bastion': Object.freeze({
      id: 'umbral-bastion',
      name: 'Umbral Bastion',
      faction: 'Night Vow',
      subtitle: 'NIGHT VOW HOLD THE DARK',
      pressureLabel: 'UMBRA PRESSURE',
      primary: 0xb89cff,
      secondary: 0xff8bc2,
      deep: 0x0d0a17,
      ambient: 0x332255,
      ambientAlt: 0x3a1c3c,
      panel: 0x332255,
      panelTop: 0x5b3a8f,
      label: 0x6a4fc4,
      badge: 0x211a32,
      text: '#f4edff',
      muted: '#ffd9ed',
      code: '#bca9f3',
      structures: ['Shadow bulwark', 'Moonwell keep', 'Eclipse obelisk'],
    }),
  });

  function normalizeAetherisTerritoryId(value) {
    const id = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(AETHERIS_TERRITORY_THEMES, id)
      ? id
      : DEFAULT_AETHERIS_TERRITORY_ID;
  }

  function resolveAetherisTerritory(value) {
    return AETHERIS_TERRITORY_THEMES[normalizeAetherisTerritoryId(value)];
  }

  const AETHERIS_STRUCTURE_TYPES = Object.freeze(['frontline', 'anchor', 'ultimate']);
  const AETHERIS_STRUCTURE_HP = Object.freeze({
    frontline: 420,
    anchor: 620,
    ultimate: 840,
  });

  class BattleOverlayV2Scene extends Phaser.Scene {
    constructor() {
      super({ key: 'BattleOverlayV2Scene' });
      this.playerGroups = [];
      this.playerMap = new Map();
      this.structureState = null;
      this.structureRecords = new Map();
      this.laserColor = 0x7afcff;
      this.layoutConfig = { shotSpeed: 1 };
      this.backgroundFit = 'contain';
      this.territory = resolveAetherisTerritory(DEFAULT_AETHERIS_TERRITORY_ID);
      this.withOverlayAuth = null;
      this.customBackground = null;
      this.customBackgroundUrl = null;
      this.customBackgroundKey = null;
      this.lastDemoEvent = 0;
      this.demoAttackStartAt = 0;
      this.demoModeActive = false;
      this.sponsorVideo = null;
      this.sponsorTimer = null;
      this.sponsorWallClockTimer = null;
      this.sponsorEndcapTimer = null;
      this.sponsorEndcapWallClockTimer = null;
      this.sponsorEndcapShown = false;
      this.sponsorStartedAt = 0;
      this.sponsorReporter = null;
      this.preparedSponsor = null;
      this.masterVolume = 0.5;
      this.bossState = null;
      this.bossCoreBounds = null;
      this.bossCoreAnchorCache = null;
      this.bossAttackSweepAnchor = null;
      this.powerState = null;
      this.powerGlow = null;
      this.powerChip = null;
      this.powerCountdownTimer = null;
      this.bannerQueue = [];
      this.bannerActive = false;
      this.recentAttackKeys = new Map();
    }

    create() {
      this.W = Number(this.sys.game.config.width);
      this.H = Number(this.sys.game.config.height);
      this.scaleUnit = this.W / 1920;
      this.safe = this.getSafeRect();

      this.backgroundLayer = this.add.container(0, 0).setDepth(0);
      this.frameLayer = this.add.container(0, 0).setDepth(10);
      this.structureLayer = this.add.container(0, 0).setDepth(18);
      this.worldLayer = this.add.container(0, 0).setDepth(20);
      this.powerLayer = this.add.container(0, 0).setDepth(24);
      this.playerLayer = this.add.container(0, 0).setDepth(30);
      this.effectLayer = this.add.container(0, 0).setDepth(45);
      this.bannerLayer = this.add.container(0, 0).setDepth(60);
      this.sponsorLayer = this.add.container(0, 0).setDepth(500).setVisible(false).setAlpha(0);

      this.drawBackground();
      this.drawFrame();
      this.linkGraphics = this.add.graphics();
      this.worldLayer.add(this.linkGraphics);
      this.createHorde();
      this.structureState = this.defaultAetherisStructureState(this.territory.id);
      this.drawAetherisStructures();
      this.createChatDisplay();
      this.createAmbientMotion();

      if (demoMode) this.startDemo();
      window.overlayV2Scene = this;
      window.__overlayV2Ready = true;
      window.__overlayV2Territory = this.territory.id;
      window.__overlayV2Structures = this.structureState;
      setStatus('Ready', 'connected');
    }

    getSafeRect() {
      const marginX = Math.max(74, this.W * 0.046);
      const marginTop = Math.max(154, this.H * 0.155);
      const marginBottom = Math.max(94, this.H * 0.11);
      return {
        x: marginX,
        y: marginTop,
        width: this.W - marginX * 2,
        height: this.H - marginTop - marginBottom,
      };
    }

    drawTerritoryStructures(g, territory) {
      const u = this.scaleUnit || 1;
      const baseY = this.safe.y + this.safe.height * 0.72;
      const specs = [
        { x: this.safe.x + this.safe.width * 0.14, y: baseY + 22 * u, w: 168 * u, h: 96 * u, type: 'gate' },
        { x: this.safe.x + this.safe.width * 0.5, y: baseY - 10 * u, w: 128 * u, h: 138 * u, type: 'tower' },
        { x: this.safe.x + this.safe.width * 0.86, y: baseY + 18 * u, w: 154 * u, h: 112 * u, type: 'spire' },
      ];
      specs.forEach((spec, index) => {
        const left = spec.x - spec.w / 2;
        const top = spec.y - spec.h / 2;
        g.fillStyle(0x000000, 0.28);
        g.fillRoundedRect(left + 10 * u, top + 14 * u, spec.w, spec.h, 8 * u);
        g.fillStyle(territory.deep, 0.68);
        g.fillRoundedRect(left, top, spec.w, spec.h, 8 * u);
        g.fillStyle(territory.primary, 0.12);
        g.fillRoundedRect(left + 8 * u, top + 8 * u, spec.w - 16 * u, spec.h - 16 * u, 6 * u);
        g.lineStyle(Math.max(1, 2 * u), territory.secondary, 0.28);
        g.strokeRoundedRect(left, top, spec.w, spec.h, 8 * u);

        if (spec.type === 'gate') {
          g.fillStyle(territory.ambient, 0.62);
          g.fillRoundedRect(left + 22 * u, top + 36 * u, spec.w - 44 * u, spec.h - 44 * u, 8 * u);
          g.fillStyle(0x02040a, 0.54);
          g.fillRect(left + spec.w * 0.47, top + 42 * u, spec.w * 0.06, spec.h - 54 * u);
          g.lineStyle(Math.max(2, 3 * u), territory.primary, 0.32);
          g.lineBetween(left + 30 * u, top + 30 * u, left + spec.w - 30 * u, top + 30 * u);
        } else if (spec.type === 'tower') {
          g.fillStyle(territory.ambient, 0.7);
          g.fillRoundedRect(left + spec.w * 0.28, top + 22 * u, spec.w * 0.44, spec.h - 22 * u, 8 * u);
          g.fillStyle(territory.secondary, 0.18);
          g.fillTriangle(spec.x, top - 36 * u, left + spec.w * 0.2, top + 30 * u, left + spec.w * 0.8, top + 30 * u);
          g.fillStyle(territory.primary, 0.25);
          g.fillCircle(spec.x, top + 54 * u, 15 * u);
        } else {
          g.fillStyle(territory.ambient, 0.68);
          g.fillTriangle(spec.x, top - 18 * u, left + spec.w * 0.16, top + spec.h, left + spec.w * 0.84, top + spec.h);
          g.fillStyle(territory.secondary, 0.18);
          g.fillTriangle(spec.x, top + 16 * u, left + spec.w * 0.36, top + spec.h * 0.74, left + spec.w * 0.64, top + spec.h * 0.74);
          g.lineStyle(Math.max(1, 2 * u), territory.primary, 0.34);
          g.lineBetween(spec.x, top, spec.x, top + spec.h * 0.84);
        }

        g.fillStyle(territory.secondary, 0.24);
        g.fillCircle(left + 18 * u, top + spec.h - 18 * u, 5 * u);
        g.fillCircle(left + spec.w - 18 * u, top + spec.h - 18 * u, 5 * u);
        if (index === 1) {
          g.lineStyle(Math.max(1, 2 * u), territory.primary, 0.16);
          g.lineBetween(spec.x, top + spec.h, this.safe.x + this.safe.width * 0.14, baseY + 70 * u);
          g.lineBetween(spec.x, top + spec.h, this.safe.x + this.safe.width * 0.86, baseY + 70 * u);
        }
      });
    }

    structureSpecs() {
      const u = this.scaleUnit || 1;
      const baseY = this.H - Math.max(246, 270 * u);
      return [
        { type: 'frontline', x: this.safe.x + this.safe.width * 0.16, y: baseY + 8 * u, w: 238 * u, h: 132 * u, shape: 'gate' },
        { type: 'anchor', x: this.safe.x + this.safe.width * 0.5, y: baseY - 2 * u, w: 218 * u, h: 146 * u, shape: 'tower' },
        { type: 'ultimate', x: this.safe.x + this.safe.width * 0.84, y: baseY + 6 * u, w: 238 * u, h: 138 * u, shape: 'spire' },
      ];
    }

    defaultAetherisStructureState(territoryId = this.territory?.id) {
      const territory = resolveAetherisTerritory(territoryId);
      const structures = AETHERIS_STRUCTURE_TYPES.map((type, index) => {
        const maxHp = AETHERIS_STRUCTURE_HP[type] || 500;
        return {
          id: `aetheris:${territory.id}:${type}`,
          type,
          name: territory.structures[index] || type,
          label: type === 'frontline' ? 'Frontline' : type === 'anchor' ? 'Anchor' : 'Ultimate',
          role: '',
          order: index + 1,
          territoryId: territory.id,
          hp: maxHp,
          maxHp,
          hpPct: 1,
          status: 'standing',
          alive: true,
        };
      });
      const aggregate = this.aggregateStructureState(structures);
      return {
        territoryId: territory.id,
        version: 1,
        resetAt: Date.now(),
        updatedAt: Date.now(),
        structures,
        aggregate,
      };
    }

    aggregateStructureState(structures = []) {
      const hp = structures.reduce((sum, structure) => sum + Math.max(0, Number(structure.hp) || 0), 0);
      const maxHp = structures.reduce((sum, structure) => sum + Math.max(1, Number(structure.maxHp) || 1), 0);
      const standing = structures.filter(structure => Number(structure.hp) > 0).length;
      const destroyed = Math.max(0, structures.length - standing);
      const critical = structures.filter(structure => {
        const pct = Math.max(0, Number(structure.hp) || 0) / Math.max(1, Number(structure.maxHp) || 1);
        return pct > 0 && pct <= 0.33;
      }).length;
      const hpPct = maxHp > 0 ? clamp(hp / maxHp, 0, 1) : 0;
      return {
        hp: Math.round(hp),
        maxHp: Math.round(maxHp),
        hpPct,
        standing,
        destroyed,
        critical,
        total: structures.length,
        status: standing <= 0 ? 'destroyed' : critical > 0 ? 'critical' : hpPct <= 0.66 ? 'damaged' : 'standing',
      };
    }

    normalizeAetherisStructurePayload(payload = {}) {
      const territoryId = normalizeAetherisTerritoryId(payload.territoryId || this.territory?.id);
      const territory = resolveAetherisTerritory(territoryId);
      const incoming = Array.isArray(payload.structures) ? payload.structures : [];
      const byType = new Map(incoming.map(structure => [String(structure?.type || ''), structure]));
      const structures = AETHERIS_STRUCTURE_TYPES.map((type, index) => {
        const incomingStructure = byType.get(type) || {};
        const maxHp = Math.max(1, Number(incomingStructure.maxHp) || AETHERIS_STRUCTURE_HP[type] || 500);
        const hp = clamp(Number(incomingStructure.hp ?? maxHp), 0, maxHp);
        const hpPct = clamp(Number(incomingStructure.hpPct ?? (hp / maxHp)), 0, 1);
        const status = incomingStructure.status || (hp <= 0 ? 'destroyed' : hpPct <= 0.33 ? 'critical' : hpPct <= 0.66 ? 'damaged' : 'standing');
        return {
          id: incomingStructure.id || `aetheris:${territory.id}:${type}`,
          type,
          name: incomingStructure.name || territory.structures[index] || type,
          label: incomingStructure.label || (type === 'frontline' ? 'Frontline' : type === 'anchor' ? 'Anchor' : 'Ultimate'),
          role: incomingStructure.role || '',
          order: Number(incomingStructure.order) || index + 1,
          territoryId,
          hp: Math.round(hp),
          maxHp: Math.round(maxHp),
          hpPct,
          status,
          alive: hp > 0,
          lastDamagedAt: Number(incomingStructure.lastDamagedAt) || 0,
          lastHitBy: incomingStructure.lastHitBy || null,
        };
      }).sort((a, b) => a.order - b.order);
      return {
        territoryId,
        version: Number(payload.version) || 1,
        resetAt: Number(payload.resetAt) || Date.now(),
        updatedAt: Number(payload.updatedAt) || Date.now(),
        type: payload.type || 'status',
        structures,
        aggregate: payload.aggregate || this.aggregateStructureState(structures),
      };
    }

    drawStructureShape(g, spec, structure, territory) {
      const u = this.scaleUnit || 1;
      const w = spec.w;
      const h = spec.h;
      const left = -w / 2;
      const top = -h / 2;
      const destroyed = structure.status === 'destroyed' || Number(structure.hp) <= 0;
      const critical = structure.status === 'critical';
      const alpha = destroyed ? 0.42 : critical ? 0.88 : 1;

      g.fillStyle(0x000000, 0.38);
      g.fillRoundedRect(left + 10 * u, top + 14 * u, w, h, 8 * u);
      g.fillStyle(territory.panel, 0.94 * alpha);
      g.fillRoundedRect(left, top, w, h, 8 * u);
      g.fillStyle(territory.panelTop, 0.34 * alpha);
      g.fillRoundedRect(left + 8 * u, top + 8 * u, w - 16 * u, h * 0.34, 6 * u);
      g.lineStyle(Math.max(2, 3 * u), destroyed ? 0x5d6268 : critical ? 0xff5566 : territory.primary, destroyed ? 0.5 : 0.9);
      g.strokeRoundedRect(left, top, w, h, 8 * u);

      if (spec.shape === 'gate') {
        g.fillStyle(territory.ambient, 0.76 * alpha);
        g.fillRoundedRect(left + 32 * u, top + 48 * u, w - 64 * u, h - 68 * u, 8 * u);
        g.fillStyle(0x02040a, 0.5);
        g.fillRect(-7 * u, top + 54 * u, 14 * u, h - 80 * u);
        g.lineStyle(Math.max(2, 3 * u), territory.secondary, 0.4 * alpha);
        g.lineBetween(left + 42 * u, top + 42 * u, left + w - 42 * u, top + 42 * u);
      } else if (spec.shape === 'tower') {
        g.fillStyle(territory.ambient, 0.82 * alpha);
        g.fillRoundedRect(left + w * 0.28, top + 34 * u, w * 0.44, h - 48 * u, 8 * u);
        g.fillStyle(territory.secondary, 0.26 * alpha);
        g.fillTriangle(0, top - 42 * u, left + w * 0.22, top + 42 * u, left + w * 0.78, top + 42 * u);
        g.fillStyle(territory.primary, 0.36 * alpha);
        g.fillCircle(0, top + 70 * u, 17 * u);
      } else {
        g.fillStyle(territory.ambient, 0.8 * alpha);
        g.fillTriangle(0, top - 24 * u, left + w * 0.17, top + h - 10 * u, left + w * 0.83, top + h - 10 * u);
        g.fillStyle(territory.secondary, 0.28 * alpha);
        g.fillTriangle(0, top + 20 * u, left + w * 0.36, top + h * 0.74, left + w * 0.64, top + h * 0.74);
        g.lineStyle(Math.max(2, 3 * u), territory.primary, 0.42 * alpha);
        g.lineBetween(0, top + 2 * u, 0, top + h * 0.84);
      }

      if (destroyed) {
        g.lineStyle(Math.max(4, 6 * u), 0xff5566, 0.62);
        g.lineBetween(left + 38 * u, top + 34 * u, left + w - 38 * u, top + h - 34 * u);
        g.lineBetween(left + w - 38 * u, top + 34 * u, left + 38 * u, top + h - 34 * u);
      }
    }

    drawAetherisStructures() {
      if (!this.structureLayer) return;
      this.structureLayer.removeAll(true);
      this.structureRecords.clear();
      this.structureState = this.normalizeAetherisStructurePayload(this.structureState || this.defaultAetherisStructureState(this.territory.id));
      const territory = this.territory || resolveAetherisTerritory(this.structureState.territoryId);
      const specs = this.structureSpecs();
      const byType = new Map(this.structureState.structures.map(structure => [structure.type, structure]));

      specs.forEach(spec => {
        const structure = byType.get(spec.type);
        if (!structure) return;
        const u = this.scaleUnit || 1;
        const group = this.add.container(spec.x, spec.y);
        const g = this.add.graphics();
        const hpPct = clamp(Number(structure.hpPct ?? (structure.hp / Math.max(1, structure.maxHp))), 0, 1);
        const destroyed = structure.status === 'destroyed' || hpPct <= 0;
        const critical = structure.status === 'critical';

        this.drawStructureShape(g, spec, structure, territory);
        const barW = spec.w * 0.76;
        const barH = Math.max(13, 16 * u);
        const barY = spec.h / 2 - 32 * u;
        g.fillStyle(0x05070b, 0.9);
        g.fillRoundedRect(-barW / 2, barY, barW, barH, barH / 2);
        if (hpPct > 0) {
          const fillColor = critical ? 0xff5566 : territory.primary;
          g.fillStyle(fillColor, 0.92);
          g.fillRoundedRect(-barW / 2 + 3 * u, barY + 3 * u, Math.max(barH, (barW - 6 * u) * hpPct), barH - 6 * u, (barH - 6 * u) / 2);
          g.fillStyle(territory.secondary, 0.54);
          g.fillRoundedRect(-barW / 2 + 5 * u, barY + 5 * u, Math.max(0, (barW - 10 * u) * hpPct), (barH - 9 * u) * 0.45, (barH - 9 * u) / 2);
        }

        const name = this.add.text(0, -spec.h / 2 + 14 * u, String(structure.name || '').toUpperCase(), {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(15 * u)}px`,
          color: destroyed ? '#9ba3ab' : territory.text,
          stroke: '#02040a',
          strokeThickness: Math.max(3, 4 * u),
          align: 'center',
          fixedWidth: spec.w - 22 * u,
        }).setOrigin(0.5, 0);
        const hpLabel = this.add.text(0, barY + barH + 8 * u, destroyed ? 'DOWN' : `${Math.round(hpPct * 100)}%`, {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(14 * u)}px`,
          color: destroyed ? '#ff8898' : critical ? '#ffbd70' : territory.muted,
          stroke: '#02040a',
          strokeThickness: Math.max(2, 3 * u),
          align: 'center',
        }).setOrigin(0.5, 0);
        group.add([g, name, hpLabel]);
        group.setAlpha(destroyed ? 0.72 : 1);
        this.structureLayer.add(group);
        this.structureRecords.set(structure.id, {
          structure,
          container: group,
          bounds: { x: spec.x - spec.w / 2, y: spec.y - spec.h / 2, width: spec.w, height: spec.h },
        });
        this.structureRecords.set(structure.type, this.structureRecords.get(structure.id));
      });

      window.__overlayV2Structures = this.structureState;
      if (this.hordeGraphics) this.drawHorde();
    }

    drawBackground() {
      this.backgroundLayer.removeAll(true);
      this.customBackground = null;
      const g = this.add.graphics();
      const u = this.scaleUnit;
      const territory = this.territory || resolveAetherisTerritory();

      g.fillStyle(territory.deep, 1);
      g.fillRect(0, 0, this.W, this.H);

      const cx = this.W / 2;
      const cy = this.safe.y + this.safe.height * 0.48;
      g.fillStyle(territory.ambient, 0.86);
      g.fillEllipse(cx, cy, this.W * 0.9, this.H * 0.78);
      g.fillStyle(territory.primary, 0.22);
      g.fillEllipse(cx, cy, this.W * 0.55, this.H * 0.46);
      g.fillStyle(territory.ambientAlt, 0.34);
      g.fillEllipse(cx, cy + this.H * 0.02, this.W * 0.34, this.H * 0.27);
      g.fillStyle(territory.secondary, 0.1);
      g.fillEllipse(this.W * 0.22, this.H * 0.33, this.W * 0.28, this.H * 0.54);
      g.fillEllipse(this.W * 0.82, this.H * 0.36, this.W * 0.24, this.H * 0.5);
      this.drawTerritoryStructures(g, territory);

      const grid = Math.max(62, 82 * u);
      g.lineStyle(Math.max(1, 1 * u), territory.primary, 0.18);
      for (let x = 0; x <= this.W; x += grid) g.lineBetween(x, 0, x, this.H);
      for (let y = 0; y <= this.H; y += grid) g.lineBetween(0, y, this.W, y);

      const stars = [
        [0.12, 0.18, 0.3], [0.34, 0.08, 0.2], [0.56, 0.14, 0.28],
        [0.78, 0.22, 0.34], [0.91, 0.11, 0.23], [0.08, 0.42, 0.26],
        [0.88, 0.38, 0.31], [0.22, 0.72, 0.22], [0.66, 0.82, 0.26],
        [0.84, 0.76, 0.34], [0.45, 0.91, 0.18], [0.18, 0.88, 0.3],
        [0.72, 0.06, 0.24], [0.38, 0.54, 0.32], [0.96, 0.62, 0.22],
      ];
      stars.forEach(([rx, ry, alpha]) => {
        g.fillStyle(0xffffff, alpha);
        g.fillCircle(rx * this.W, ry * this.H, Math.max(1, 2.1 * u));
      });

      const codeStyle = {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: `${Math.round(12 * u)}px`,
        color: territory.code,
        alpha: 0.13,
        lineSpacing: Math.round(4 * u),
      };
      const codeLines = [
        `territory.bind ${territory.id}`,
        `faction.route ${territory.faction.toLowerCase().replace(/\s+/g, '-')}`,
        'chat.parse command.queue',
        'creator.allegiance locked',
        'damage.resolve horde.hp',
        'structure.plan shield.tower',
        'viewer.combo surge.tick',
        'socket.live state.patch',
        'round.frame update.render',
      ].join('\n');
      const leftCode = this.add.text(this.safe.x + 24 * u, this.safe.y + 76 * u, codeLines, codeStyle);
      const rightCode = this.add.text(this.W - this.safe.x - 360 * u, this.safe.y + this.safe.height * 0.55, codeLines, codeStyle);
      this.backgroundLayer.add([g, leftCode, rightCode]);
    }

    drawFrame() {
      if (this.scanLine) this.tweens.killTweensOf(this.scanLine);
      this.frameLayer.removeAll(true);
      const u = this.scaleUnit;
      const territory = this.territory || resolveAetherisTerritory();
      const outer = this.add.graphics();
      const energy = this.add.graphics();
      const metal = this.add.graphics();
      const edge = Math.max(22, 30 * u);
      const headerH = Math.max(108, 126 * u);
      const contentX = Math.max(42, 52 * u);
      const contentY = Math.max(142, 166 * u);
      const contentW = this.W - contentX * 2;
      const contentH = this.H - contentY - Math.max(100, 122 * u);

      outer.fillStyle(0x03060c, 0.24);
      outer.fillRect(0, 0, this.W, this.H);
      outer.lineStyle(Math.max(3, 5 * u), territory.ambient, 1);
      outer.strokeRoundedRect(edge * 0.55, edge * 0.55, this.W - edge * 1.1, this.H - edge * 1.1, Math.max(8, 12 * u));

      energy.lineStyle(Math.max(2, 3 * u), territory.secondary, 0.74);
      energy.strokeRoundedRect(edge, edge, this.W - edge * 2, this.H - edge * 2, Math.max(8, 10 * u));
      energy.lineStyle(Math.max(1, 1.5 * u), territory.primary, 0.34);
      energy.lineBetween(edge, headerH + 8 * u, edge, this.H - edge);
      energy.lineBetween(this.W - edge, headerH + 8 * u, this.W - edge, this.H - edge);
      [
        [edge, 66 * u, 1],
        [this.W - edge, 66 * u, -1],
        [edge, this.H - 178 * u, 1],
        [this.W - edge, this.H - 178 * u, -1],
      ].forEach(([x, y, dir]) => {
        energy.lineStyle(Math.max(1, 2 * u), territory.secondary, 0.55);
        energy.lineBetween(x, y, x + dir * 12 * u, y + 32 * u);
        energy.lineBetween(x + dir * 12 * u, y + 32 * u, x - dir * 4 * u, y + 64 * u);
        energy.lineBetween(x - dir * 4 * u, y + 64 * u, x + dir * 10 * u, y + 96 * u);
      });

      metal.fillStyle(0x0b0f16, 0.62);
      metal.fillRoundedRect(contentX, contentY, contentW, contentH, Math.max(20, 28 * u));
      metal.fillStyle(0xffffff, 0.035);
      metal.fillRoundedRect(contentX + 8 * u, contentY + 8 * u, contentW - 16 * u, contentH * 0.22, Math.max(18, 24 * u));
      metal.lineStyle(Math.max(2, 3 * u), 0x5c6d7d, 0.68);
      metal.strokeRoundedRect(contentX, contentY, contentW, contentH, Math.max(20, 28 * u));
      metal.lineStyle(Math.max(1, 1.5 * u), territory.primary, 0.22);
      metal.strokeRoundedRect(contentX + 14 * u, contentY + 14 * u, contentW - 28 * u, contentH - 28 * u, Math.max(16, 22 * u));

      const cornerSize = Math.max(82, 98 * u);
      [
        [edge, edge, 1, 1],
        [this.W - edge - cornerSize, edge, -1, 1],
        [edge, this.H - edge - cornerSize, 1, -1],
        [this.W - edge - cornerSize, this.H - edge - cornerSize, -1, -1],
      ].forEach(([x, y, sx, sy]) => {
        metal.fillStyle(0x11161f, 0.98);
        metal.fillTriangle(x, y, x + cornerSize, y, x, y + cornerSize);
        metal.lineStyle(Math.max(2, 3 * u), 0x6a737d, 0.92);
        metal.lineBetween(x + (sx < 0 ? cornerSize : 0), y, x + (sx < 0 ? 0 : cornerSize), y);
        metal.lineBetween(x, y + (sy < 0 ? cornerSize : 0), x, y + (sy < 0 ? 0 : cornerSize));
      });

      const drawBolt = (cx, cy, r = 16 * u) => {
        metal.fillStyle(0x1c2027, 1);
        metal.fillCircle(cx, cy, r);
        metal.lineStyle(Math.max(2, 2.5 * u), 0x8d7b61, 0.9);
        metal.strokeCircle(cx, cy, r);
        metal.lineStyle(Math.max(1, 2 * u), 0x66533a, 0.9);
        for (let i = 0; i < 8; i += 1) {
          const a = i * Math.PI / 4;
          metal.lineBetween(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, cx + Math.cos(a) * r * 1.22, cy + Math.sin(a) * r * 1.22);
        }
        metal.fillStyle(0xc0aa7b, 0.8);
        metal.fillCircle(cx, cy, r * 0.24);
      };
      drawBolt(edge, edge);
      drawBolt(this.W - edge, edge);
      drawBolt(edge, this.H - edge);
      drawBolt(this.W - edge, this.H - edge);

      const header = this.add.graphics();
      header.fillStyle(0x1a2029, 1);
      header.fillRect(edge * 1.55, 28 * u, this.W - edge * 3.1, headerH - 26 * u);
      header.fillStyle(0xb7c0c8, 0.42);
      header.fillRect(edge * 1.55, 28 * u, this.W - edge * 3.1, (headerH - 26 * u) * 0.45);
      header.fillStyle(0x03060c, 0.38);
      header.fillRect(edge * 1.55, headerH - 26 * u, this.W - edge * 3.1, 28 * u);
      header.lineStyle(Math.max(2, 3 * u), 0x677684, 0.9);
      header.strokeRect(edge * 1.55, 28 * u, this.W - edge * 3.1, headerH - 26 * u);
      header.lineStyle(Math.max(2, 3 * u), territory.secondary, 0.55);
      header.lineBetween(edge * 2, headerH + 2 * u, this.W - edge * 2, headerH + 2 * u);

      const avatarX = Math.max(108, 132 * u);
      const avatarY = Math.max(60, 75 * u);
      const avatarR = Math.max(28, 36 * u);
      const brandGfx = this.add.graphics();
      brandGfx.fillStyle(territory.deep, 0.98);
      brandGfx.fillCircle(avatarX, avatarY, avatarR * 1.16);
      brandGfx.fillStyle(territory.primary, 0.88);
      brandGfx.fillCircle(avatarX, avatarY, avatarR);
      brandGfx.lineStyle(Math.max(2, 3 * u), 0xc7d1da, 0.75);
      brandGfx.strokeCircle(avatarX, avatarY, avatarR * 1.16);
      brandGfx.lineStyle(Math.max(2, 3 * u), territory.secondary, 0.65);
      brandGfx.strokeCircle(avatarX, avatarY, avatarR * 0.82);
      brandGfx.lineStyle(Math.max(3, 4 * u), 0xe7eef5, 0.88);
      brandGfx.lineBetween(avatarX - avatarR * 0.42, avatarY + avatarR * 0.42, avatarX + avatarR * 0.34, avatarY - avatarR * 0.5);
      brandGfx.lineBetween(avatarX - avatarR * 0.34, avatarY - avatarR * 0.48, avatarX + avatarR * 0.42, avatarY + avatarR * 0.42);

      const brandText = this.add.text(avatarX + avatarR + Math.max(18, 22 * u), avatarY, 'INTOTHEBATTLE', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(30 * u)}px`,
        color: '#e8e8e8',
        letterSpacing: Math.round(2 * u),
        stroke: '#05070d',
        strokeThickness: Math.max(2, 4 * u),
      }).setOrigin(0, 0.5);

      const plaque = this.add.graphics();
      const plaqueW = Math.max(450, 560 * u);
      const plaqueH = Math.max(74, 92 * u);
      const plaqueX = this.W / 2 - plaqueW / 2;
      const plaqueY = Math.max(8, 14 * u);
      plaque.fillStyle(0x1d1f24, 1);
      plaque.fillRoundedRect(plaqueX, plaqueY, plaqueW, plaqueH, Math.max(8, 10 * u));
      plaque.fillStyle(0xffffff, 0.12);
      plaque.fillRoundedRect(plaqueX + 8 * u, plaqueY + 8 * u, plaqueW - 16 * u, plaqueH * 0.36, Math.max(5, 7 * u));
      plaque.lineStyle(Math.max(3, 5 * u), 0x5d6570, 0.98);
      plaque.strokeRoundedRect(plaqueX, plaqueY, plaqueW, plaqueH, Math.max(8, 10 * u));
      plaque.lineStyle(Math.max(2, 3 * u), territory.primary, 0.72);
      plaque.lineBetween(plaqueX + 32 * u, plaqueY + plaqueH - 7 * u, plaqueX + plaqueW - 32 * u, plaqueY + plaqueH - 7 * u);

      const titleLabel = territory.name.toUpperCase();
      const titleFontSize = Math.round(clamp((plaqueW / Math.max(10, titleLabel.length)) * 1.35, 35 * u, 54 * u));
      const titleText = this.add.text(this.W / 2, plaqueY + plaqueH * 0.52, titleLabel, {
        fontFamily: 'Georgia, Times New Roman, serif',
        fontSize: `${titleFontSize}px`,
        color: territory.text,
        letterSpacing: Math.round(2 * u),
        stroke: '#170d08',
        strokeThickness: Math.max(3, 5 * u),
      }).setOrigin(0.5);

      const pillW = Math.max(126, 154 * u);
      const pillH = Math.max(44, 54 * u);
      const pillX = this.W - Math.max(244, 284 * u);
      const livePill = this.add.graphics();
      livePill.fillStyle(0x2b0b13, 0.98);
      livePill.fillRoundedRect(pillX - 8 * u, avatarY - pillH / 2 - 7 * u, pillW + 16 * u, pillH + 14 * u, pillH / 2);
      livePill.fillStyle(0xa41427, 0.96);
      livePill.fillRoundedRect(pillX, avatarY - pillH / 2, pillW, pillH, pillH / 2);
      livePill.fillStyle(0xffffff, 0.11);
      livePill.fillRoundedRect(pillX + 8 * u, avatarY - pillH / 2 + 6 * u, pillW - 16 * u, pillH * 0.35, pillH / 2);
      livePill.fillStyle(0xff324f, 0.98);
      livePill.fillCircle(pillX + 35 * u, avatarY, Math.max(8, 10 * u));
      livePill.lineStyle(Math.max(1, 2 * u), 0xf7b1bd, 0.68);
      livePill.strokeRoundedRect(pillX, avatarY - pillH / 2, pillW, pillH, pillH / 2);

      const liveText = this.add.text(pillX + pillW * 0.62, avatarY, 'LIVE', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(28 * u)}px`,
        color: '#ffffff',
        letterSpacing: Math.round(1.5 * u),
        stroke: '#4f0710',
        strokeThickness: Math.max(2, 3 * u),
      }).setOrigin(0.5);

      const subtitleLabel = territory.subtitle || `FIGHTING FOR ${territory.faction.toUpperCase()}`;
      const subtitleText = this.add.text(this.W / 2, Math.max(132, 154 * u), subtitleLabel, {
        fontFamily: 'Georgia, Times New Roman, serif',
        fontSize: `${Math.round(clamp((this.W * 0.64) / Math.max(18, subtitleLabel.length), 28 * u, 42 * u))}px`,
        color: territory.muted,
        letterSpacing: Math.round(1 * u),
        stroke: '#160b08',
        strokeThickness: Math.max(3, 5 * u),
      }).setOrigin(0.5);

      this.scanLine = this.add.rectangle(this.W / 2, this.safe.y + this.safe.height * 0.5, this.safe.width * 0.94, Math.max(2, 3 * u), territory.primary, 0.08);
      this.frameLayer.add([outer, energy, metal, header, brandGfx, brandText, plaque, titleText, livePill, liveText, subtitleText, this.scanLine]);
    }

    createAmbientMotion() {
      this.tweens.add({
        targets: this.scanLine,
        y: this.safe.y + this.safe.height,
        alpha: 0.02,
        duration: 4200,
        repeat: -1,
        ease: 'Sine.easeInOut',
        yoyo: true,
      });
    }

    commandIconKind(command = '') {
      const value = String(command || '').toLowerCase();
      if (value.includes('fire') || value.includes('flame')) return 'fire';
      if (value.includes('like') || value.includes('surge') || value.includes('boost')) return 'surge';
      if (value.includes('gift')) return 'gift';
      if (value.includes('rail')) return 'rail';
      return 'laser';
    }

    resolvePlayerIcon(record) {
      const explicit = String(record?.data?.iconType || record?.data?.iconEmoji || '').toLowerCase();
      const name = String(record?.data?.name || '').toLowerCase();
      const value = `${explicit} ${name}`;
      if (value.includes('blaze') || value.includes('fire')) return 'fire';
      if (value.includes('west') || value.includes('sword')) return 'swords';
      if (value.includes('mira') || value.includes('star')) return 'star';
      if (value.includes('ashlee') || value.includes('heart')) return 'core';
      return 'bolt';
    }

    drawCommandIcon(g, kind, cx, cy, scale, accentColor) {
      const u = this.scaleUnit * scale;
      g.fillStyle(0x000000, 0.36);
      g.fillCircle(cx + 4 * u, cy + 6 * u, 44 * u);
      g.fillStyle(0x222832, 0.98);
      g.fillCircle(cx, cy, 43 * u);
      g.fillStyle(0xb8c4ce, 0.24);
      g.fillCircle(cx, cy - 7 * u, 34 * u);
      g.fillStyle(0x0a0d12, 0.4);
      g.fillCircle(cx, cy + 8 * u, 31 * u);
      g.lineStyle(Math.max(3, 4 * u), 0x0a0d12, 0.72);
      g.strokeCircle(cx, cy, 44 * u);
      g.lineStyle(Math.max(2, 3 * u), 0xb9c5cf, 0.84);
      g.strokeCircle(cx, cy, 39 * u);
      g.lineStyle(Math.max(2, 3 * u), accentColor, 0.58);
      g.strokeCircle(cx, cy, 32 * u);

      if (kind === 'fire') {
        g.fillStyle(0x7d2417, 0.72);
        g.fillCircle(cx, cy, 27 * u);
        g.fillStyle(0xff5c30, 0.92);
        g.fillTriangle(cx, cy - 31 * u, cx - 18 * u, cy + 15 * u, cx + 18 * u, cy + 15 * u);
        g.fillStyle(0xffd36e, 0.95);
        g.fillTriangle(cx + 2 * u, cy - 18 * u, cx - 9 * u, cy + 18 * u, cx + 14 * u, cy + 16 * u);
      } else if (kind === 'surge') {
        g.lineStyle(Math.max(5, 7 * u), 0xd5f6ff, 0.86);
        for (let i = 0; i < 3; i += 1) {
          g.strokeCircle(cx, cy, (12 + i * 8) * u);
        }
        g.lineStyle(Math.max(2, 3 * u), 0x78dcff, 0.9);
        g.lineBetween(cx - 20 * u, cy + 16 * u, cx + 18 * u, cy - 17 * u);
      } else if (kind === 'gift') {
        g.fillStyle(0xff78b2, 0.88);
        g.fillRoundedRect(cx - 20 * u, cy - 8 * u, 40 * u, 28 * u, 5 * u);
        g.fillStyle(0xf6c95b, 0.92);
        g.fillRect(cx - 4 * u, cy - 8 * u, 8 * u, 28 * u);
        g.fillRect(cx - 22 * u, cy - 16 * u, 44 * u, 10 * u);
      } else if (kind === 'rail') {
        g.lineStyle(Math.max(5, 7 * u), 0x55e7ff, 0.82);
        g.lineBetween(cx - 26 * u, cy + 16 * u, cx + 26 * u, cy - 16 * u);
        g.lineStyle(Math.max(2, 3 * u), 0xffffff, 0.95);
        g.lineBetween(cx - 20 * u, cy + 12 * u, cx + 20 * u, cy - 12 * u);
      } else {
        g.fillStyle(0x32343a, 0.94);
        g.fillRoundedRect(cx - 27 * u, cy - 9 * u, 50 * u, 18 * u, 4 * u);
        g.fillRoundedRect(cx + 5 * u, cy - 4 * u, 25 * u, 11 * u, 3 * u);
        g.lineStyle(Math.max(2, 3 * u), 0xd1d8dc, 0.92);
        g.lineBetween(cx - 19 * u, cy - 8 * u, cx + 20 * u, cy - 8 * u);
        g.lineBetween(cx - 26 * u, cy + 8 * u, cx + 14 * u, cy + 8 * u);
        g.lineStyle(Math.max(3, 4 * u), accentColor, 0.78);
        g.lineBetween(cx - 4 * u, cy + 8 * u, cx + 28 * u, cy + 23 * u);
      }
    }

    drawPlayerIcon(g, kind, cx, cy, scale, accentColor) {
      const u = this.scaleUnit * scale;
      g.lineStyle(Math.max(2, 3 * u), 0x0a0d12, 0.62);
      g.strokeCircle(cx, cy + 4 * u, 43 * u);
      if (kind === 'fire') {
        g.fillStyle(0x3a1412, 0.92);
        g.fillEllipse(cx, cy + 12 * u, 54 * u, 44 * u);
        g.fillStyle(0xff602f, 0.9);
        g.fillTriangle(cx, cy - 44 * u, cx - 31 * u, cy + 26 * u, cx + 27 * u, cy + 26 * u);
        g.fillStyle(0xffb64e, 0.96);
        g.fillTriangle(cx + 6 * u, cy - 24 * u, cx - 12 * u, cy + 31 * u, cx + 20 * u, cy + 25 * u);
      } else if (kind === 'swords') {
        g.lineStyle(Math.max(5, 7 * u), 0x8d96a0, 0.86);
        g.lineBetween(cx - 34 * u, cy + 34 * u, cx + 34 * u, cy - 34 * u);
        g.lineBetween(cx + 34 * u, cy + 34 * u, cx - 34 * u, cy - 34 * u);
        g.lineStyle(Math.max(2, 3 * u), 0xe7eef5, 0.92);
        g.lineBetween(cx - 27 * u, cy + 27 * u, cx + 29 * u, cy - 29 * u);
        g.lineBetween(cx + 27 * u, cy + 27 * u, cx - 29 * u, cy - 29 * u);
      } else if (kind === 'star') {
        g.lineStyle(Math.max(2, 3 * u), 0xbaf7ff, 0.88);
        g.fillStyle(0x57d8ff, 0.28);
        g.fillTriangle(cx, cy - 44 * u, cx - 14 * u, cy, cx + 14 * u, cy);
        g.fillTriangle(cx, cy + 44 * u, cx - 14 * u, cy, cx + 14 * u, cy);
        g.fillTriangle(cx - 44 * u, cy, cx, cy - 14 * u, cx, cy + 14 * u);
        g.fillTriangle(cx + 44 * u, cy, cx, cy - 14 * u, cx, cy + 14 * u);
        g.fillStyle(0xe8fbff, 0.9);
        g.fillCircle(cx, cy, 10 * u);
      } else if (kind === 'core') {
        g.fillStyle(0x26313d, 0.96);
        g.fillCircle(cx, cy, 34 * u);
        g.lineStyle(Math.max(3, 4 * u), 0x9bb7d2, 0.88);
        g.strokeCircle(cx, cy, 35 * u);
        g.fillStyle(0x55e7ff, 0.9);
        g.fillCircle(cx - 14 * u, cy - 8 * u, 9 * u);
        g.fillCircle(cx + 14 * u, cy - 8 * u, 9 * u);
        g.fillCircle(cx, cy + 10 * u, 13 * u);
      } else {
        g.lineStyle(Math.max(6, 8 * u), accentColor, 0.8);
        g.lineBetween(cx + 4 * u, cy - 46 * u, cx - 22 * u, cy + 2 * u);
        g.lineBetween(cx - 22 * u, cy + 2 * u, cx + 6 * u, cy - 1 * u);
        g.lineBetween(cx + 6 * u, cy - 1 * u, cx - 6 * u, cy + 46 * u);
        g.lineStyle(Math.max(2, 3 * u), 0xeaffff, 0.9);
        g.lineBetween(cx + 14 * u, cy - 38 * u, cx - 12 * u, cy + 2 * u);
        g.lineBetween(cx - 12 * u, cy + 2 * u, cx + 14 * u, cy - 1 * u);
      }
    }

    createHorde() {
      this.hordeLayer = this.add.container(0, 0);
      this.worldLayer.add(this.hordeLayer);
      this.hordeGraphics = this.add.graphics();
      this.hordeTitle = this.add.text(0, 0, 'HORDE', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(34 * this.scaleUnit)}px`,
        color: '#ffffff',
        align: 'center',
        letterSpacing: 2,
      }).setOrigin(0.5);
      this.hordeMeta = this.add.text(0, 0, 'HORDE PRESSURE', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(18 * this.scaleUnit)}px`,
        color: '#ffd37a',
        align: 'center',
      }).setOrigin(0.5);
      this.hordeBadgeText = this.add.text(0, 0, 'HP', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(16 * this.scaleUnit)}px`,
        color: '#f6c95b',
        align: 'center',
      }).setOrigin(0.5);
      this.hordeLayer.add([this.hordeGraphics, this.hordeTitle, this.hordeMeta, this.hordeBadgeText]);
      this.drawHorde();
    }

    drawHorde() {
      if (!this.hordeGraphics) return;
      const u = this.scaleUnit;
      const territory = this.territory || resolveAetherisTerritory();
      const h = Math.max(116, this.H * 0.124);
      const w = Math.min(this.safe.width * 0.86, this.W * 0.82);
      const x = (this.W - w) / 2;
      const y = this.H - h - Math.max(24, 30 * u);
      const reserve = Math.max(0, this.playerGroups.length - 5);
      const healthTotal = this.playerGroups.reduce((sum, player) => sum + clamp(Number(player.data.health || 0), 0, 100), 0);
      const bossActive = Boolean(this.bossState?.active);
      const bossPct = bossActive
        ? clamp(Number(this.bossState.hp || 0) / Math.max(1, Number(this.bossState.maxHp || 1)), 0, 1)
        : 0;
      const structureAggregate = this.structureState?.aggregate || null;
      const hasStructureHp = Boolean(structureAggregate && Number(structureAggregate.maxHp) > 0);
      const structurePct = hasStructureHp
        ? clamp(Number(structureAggregate.hpPct ?? (Number(structureAggregate.hp || 0) / Math.max(1, Number(structureAggregate.maxHp || 1)))), 0, 1)
        : 0;
      const totalFighters = Math.max(1, this.playerGroups.length);
      const teamPct = clamp(healthTotal / (totalFighters * 100), 0, 1);
      const fillPct = bossActive ? bossPct : hasStructureHp ? structurePct : teamPct;

      this.hordeGraphics.clear();

      this.hordeGraphics.fillStyle(0x09080b, 0.6);
      this.hordeGraphics.fillRoundedRect(x + 10 * u, y + 16 * u, w, h, Math.max(12, 16 * u));
      this.hordeGraphics.fillStyle(territory.panel, 0.98);
      this.hordeGraphics.fillRoundedRect(x, y, w, h, Math.max(12, 18 * u));
      this.hordeGraphics.fillStyle(territory.panelTop, 0.62);
      this.hordeGraphics.fillRoundedRect(x + 10 * u, y + 8 * u, w - 20 * u, h * 0.32, Math.max(10, 14 * u));
      this.hordeGraphics.fillStyle(0xffffff, 0.08);
      this.hordeGraphics.fillRoundedRect(x + 26 * u, y + 10 * u, w * 0.24, h * 0.2, Math.max(8, 10 * u));
      this.hordeGraphics.fillStyle(0x160b12, 0.68);
      this.hordeGraphics.fillRect(x + 24 * u, y + h * 0.58, w - 48 * u, Math.max(18, 24 * u));
      this.hordeGraphics.lineStyle(Math.max(3, 5 * u), bossActive ? territory.secondary : territory.primary, 0.95);
      this.hordeGraphics.strokeRoundedRect(x, y, w, h, Math.max(12, 18 * u));
      this.hordeGraphics.lineStyle(Math.max(1, 2 * u), territory.secondary, 0.28);
      this.hordeGraphics.lineBetween(x + 34 * u, y + 12 * u, x + w - 34 * u, y + 12 * u);
      this.hordeGraphics.lineStyle(Math.max(2, 3 * u), 0x2a1118, 0.9);
      this.hordeGraphics.lineBetween(x + 36 * u, y + h - 10 * u, x + w - 36 * u, y + h - 10 * u);

      const labelW = Math.max(200, 244 * u);
      const pad = Math.max(10, 14 * u);
      const labelX = x + pad * 1.8;
      this.hordeGraphics.fillStyle(bossActive ? territory.secondary : territory.label, 0.98);
      this.hordeGraphics.fillRoundedRect(labelX, y + pad * 1.45, labelW, h - pad * 2.9, Math.max(8, 12 * u));
      this.hordeGraphics.fillStyle(0xffd7dc, 0.14);
      this.hordeGraphics.fillRoundedRect(labelX + 10 * u, y + pad * 1.9, labelW - 20 * u, (h - pad * 2.9) * 0.38, Math.max(6, 9 * u));
      this.hordeGraphics.lineStyle(Math.max(1, 2 * u), 0x2f0b13, 0.86);
      this.hordeGraphics.strokeRoundedRect(labelX + 8 * u, y + pad * 1.85, labelW - 16 * u, h - pad * 3.7, Math.max(6, 10 * u));
      this.hordeGraphics.fillStyle(0x2b1018, 0.5);
      this.hordeGraphics.fillRect(labelX + labelW - 16 * u, y + pad * 1.9, 5 * u, h - pad * 3.8);
      this.hordeGraphics.fillRect(labelX + 11 * u, y + pad * 1.9, 5 * u, h - pad * 3.8);

      const badgeW = Math.max(58, 70 * u);
      const badgeX = x + w - badgeW - pad * 1.3;
      const barX = labelX + labelW + Math.max(28, 34 * u);
      const barW = badgeX - barX - Math.max(28, 34 * u);
      const barH = Math.max(26, 32 * u);
      const barY = y + h * 0.53;
      this.hordeGraphics.fillStyle(0x0b0d13, 0.98);
      this.hordeGraphics.fillRoundedRect(barX - 12 * u, barY - 14 * u, barW + 24 * u, barH + 28 * u, Math.max(12, 16 * u));
      this.hordeGraphics.fillStyle(0x777f88, 0.2);
      this.hordeGraphics.fillRoundedRect(barX - 8 * u, barY - 10 * u, 28 * u, barH + 20 * u, Math.max(8, 12 * u));
      this.hordeGraphics.fillRoundedRect(barX + barW - 20 * u, barY - 10 * u, 28 * u, barH + 20 * u, Math.max(8, 12 * u));
      this.hordeGraphics.lineStyle(Math.max(1, 2 * u), 0x9ba3ab, 0.84);
      this.hordeGraphics.strokeRoundedRect(barX - 12 * u, barY - 14 * u, barW + 24 * u, barH + 28 * u, Math.max(12, 16 * u));
      this.hordeGraphics.fillStyle(0x121720, 1);
      this.hordeGraphics.fillRoundedRect(barX, barY, barW, barH, barH / 2);

      if (fillPct > 0) {
        const fillW = Math.max(barH, (barW - 5 * u) * fillPct);
        this.hordeGraphics.fillStyle(territory.primary, 0.86);
        this.hordeGraphics.fillRoundedRect(barX + 3 * u, barY + 3 * u, fillW, barH - 6 * u, (barH - 6 * u) / 2);
        this.hordeGraphics.fillStyle(territory.secondary, 0.68);
        this.hordeGraphics.fillRoundedRect(barX + 5 * u, barY + 5 * u, Math.max(0, fillW - 4 * u), (barH - 10 * u) * 0.45, (barH - 10 * u) / 2);
        this.hordeGraphics.fillStyle(0xffffff, 0.18);
        this.hordeGraphics.fillRoundedRect(barX + 8 * u, barY + barH * 0.22, Math.max(0, fillW - 16 * u), barH * 0.18, barH / 2);
        this.hordeGraphics.lineStyle(Math.max(1, 2 * u), territory.text === '#fff0b9' ? 0xfff0b9 : territory.secondary, 0.36);
        this.hordeGraphics.lineBetween(barX + 16 * u, barY + barH * 0.55, barX + fillW - 14 * u, barY + barH * 0.38);
      }

      this.hordeGraphics.fillStyle(territory.badge, 0.95);
      this.hordeGraphics.fillRoundedRect(badgeX, y + pad * 1.45, badgeW, h - pad * 2.9, Math.max(8, 12 * u));
      this.hordeGraphics.lineStyle(Math.max(1, 2 * u), territory.secondary, 0.58);
      this.hordeGraphics.strokeRoundedRect(badgeX, y + pad * 1.45, badgeW, h - pad * 2.9, Math.max(8, 12 * u));

      this.hordeTitle.setText(bossActive ? 'BOSS' : 'HORDE');
      this.hordeTitle.setStyle({ color: '#ffffff' });
      this.hordeTitle.setPosition(labelX + labelW / 2, y + h / 2 + 2 * u);
      this.bossCoreBounds = bossActive
        ? { x: labelX, y: y + pad * 1.45, width: labelW, height: h - pad * 2.9 }
        : null;

      const bossRemainingMs = bossActive
        ? (Number.isFinite(Number(this.bossState?.endsAt)) ? Math.max(0, Number(this.bossState.endsAt) - Date.now()) : Number(this.bossState?.remainingMs))
        : 0;
      const bossClock = bossActive && Number.isFinite(bossRemainingMs) ? ` ${formatClockMs(bossRemainingMs)}` : '';
      const hpMax = bossActive ? Number(this.bossState.maxHp || 1) : hasStructureHp ? Number(structureAggregate.maxHp || 1) : totalFighters * 50;
      const hpNow = bossActive ? Number(this.bossState.hp || 0) : hasStructureHp ? Number(structureAggregate.hp || 0) : Math.round(fillPct * hpMax);
      const pressureLabel = territory.pressureLabel || 'HORDE PRESSURE';
      const metaStr = bossActive
        ? `${pressureLabel}      ${Math.round(bossPct * 100)}% HP${bossClock}`
        : hasStructureHp
          ? `${pressureLabel}      ${hpNow} / ${hpMax} HP  ${structureAggregate.standing}/${structureAggregate.total} STRUCTURES`
        : `${pressureLabel}      ${hpNow} / ${hpMax} HP${reserve > 0 ? `  +${reserve} RESERVE` : ''}`;
      this.hordeMeta.setText(metaStr);
      this.hordeMeta.setStyle({ color: territory.muted });
      this.hordeMeta.setPosition(barX + barW / 2, y + h * 0.35);

      if (this.hordeBadgeText) {
        this.hordeBadgeText.setStyle({ color: territory.text });
        this.hordeBadgeText.setPosition(badgeX + badgeW / 2, y + h / 2);
      }

      this.hordeBounds = { x, y, width: w, height: h };
    }

    drawPlayerLinks(visible = null) {
      if (!this.linkGraphics) return;
      const records = visible || this.playerGroups.filter(record => record.container.visible);
      const horde = this.hordeBounds || {
        x: this.W * 0.2,
        y: this.safe.y + this.safe.height * 0.68,
        width: this.W * 0.6,
        height: Math.max(74, this.H * 0.088),
      };
      const targetY = horde.y + horde.height * 0.16;
      const pulse = 0.45 + Math.sin(this.time.now * 0.004) * 0.12;

      this.linkGraphics.clear();
      records.forEach((record, index) => {
        const startX = record.targetX || record.container.x;
        const startY = (record.targetY || record.container.y) + (record.cardH || 150 * this.scaleUnit) * 0.52;
        const spread = records.length > 1 ? index / (records.length - 1) : 0.5;
        const endX = horde.x + horde.width * (0.18 + spread * 0.64);
        const health = clamp(Number(record.data.health || 0), 0, 100);
        const color = health > 66 ? 0x7afcff : health > 34 ? 0xf6c95b : 0xff5566;

        this.linkGraphics.lineStyle(Math.max(1, 2 * this.scaleUnit), color, 0.08 + pulse * 0.08);
        this.linkGraphics.beginPath();
        this.linkGraphics.moveTo(startX, startY);
        this.linkGraphics.lineTo(startX, startY + 24 * this.scaleUnit);
        this.linkGraphics.lineTo(endX, targetY);
        this.linkGraphics.strokePath();

        this.linkGraphics.fillStyle(color, 0.22);
        this.linkGraphics.fillCircle(endX, targetY, Math.max(3, 5 * this.scaleUnit));
      });
    }

    update(_time, delta) {
      this.drawHorde();
      this.drawPlayerLinks();
      if ((demoMode || this.demoModeActive) && this.time.now - this.lastDemoEvent > 1650) {
        this.lastDemoEvent = this.time.now;
        this.demoTick();
      }
      this.playerGroups.forEach((player, index) => {
        const bob = Math.sin((this.time.now * 0.002) + index) * 2.5 * this.scaleUnit;
        player.container.setPosition(player.targetX || player.container.x, (player.targetY || player.container.y) + bob + (player.floatOffset || 0));
      });
    }

    setOverlayAuthHelper(helper) {
      this.withOverlayAuth = helper;
    }

    updateLaserColor(color) {
      this.laserColor = hexToNumber(color, this.laserColor);
    }

    setTerritory(id) {
      const territory = resolveAetherisTerritory(id);
      if (this.territory?.id === territory.id) return;
      this.territory = territory;
      window.__overlayV2Territory = territory.id;
      this.structureState = this.defaultAetherisStructureState(territory.id);
      const backgroundUrl = this.customBackgroundUrl || null;
      if (this.backgroundLayer) {
        this.drawBackground();
        if (backgroundUrl) {
          this.customBackground = null;
          this.setBackgroundImageUrl(backgroundUrl);
        }
      }
      if (this.frameLayer) {
        this.drawFrame();
        this.createAmbientMotion();
      }
      if (this.structureLayer) this.drawAetherisStructures();
      if (this.hordeGraphics) this.drawHorde();
      if (this.linkGraphics) this.drawPlayerLinks();
    }

    updateAetherisStructures(payload = {}) {
      const normalized = this.normalizeAetherisStructurePayload(payload);
      if (this.territory?.id !== normalized.territoryId) this.setTerritory(normalized.territoryId);
      this.structureState = normalized;
      this.drawAetherisStructures();
      if (payload.type === 'destroyed' && payload.targetNick) {
        this.showBanner(`${payload.targetNick} destroyed`, 'kill');
      } else if (payload.type === 'reset') {
        const territory = resolveAetherisTerritory(normalized.territoryId);
        this.updateChatDisplay(territory.name, 'STRUCTURES RESET', territory.primary);
      }
    }

    updateLayoutConfig(key, value) {
      this.layoutConfig[key] = value;
    }

    setSponsorPlaybackReporter(reporter) {
      this.sponsorReporter = typeof reporter === 'function' ? reporter : null;
    }

    normalizeMasterVolume(value, fallback = this.masterVolume) {
      const numeric = Number(value);
      const fallbackNumeric = Number(fallback);
      const safeFallback = Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0.5;
      const next = Number.isFinite(numeric) ? numeric : safeFallback;
      return Math.max(0, Math.min(1, Math.round(next * 100) / 100));
    }

    setMasterVolume(value) {
      this.masterVolume = this.normalizeMasterVolume(value, this.masterVolume);
      this.applySponsorVideoVolume(this.sponsorVideo, { volume: this.masterVolume });
      if (this.preparedSponsor?.video) this.preparedSponsor.video.volume = this.masterVolume;
    }

    applySponsorVideoVolume(video, payload = {}) {
      if (!video) return;
      const volume = this.normalizeMasterVolume(payload.volume, this.masterVolume);
      try {
        if (typeof video.setVolume === 'function') video.setVolume(volume);
      } catch (_err) {}
      try {
        if (video.video) video.video.volume = volume;
        else if ('volume' in video) video.volume = volume;
      } catch (_err) {}
    }

    reportSponsor(payload, status, message = '') {
      if (this.sponsorReporter) this.sponsorReporter(payload || this.activeSponsorPayload || {}, status, message);
    }

    sponsorEndcapDurationMs(payload = {}, durationMs = 15000) {
      if ((payload.statsMode || 'endcap') === 'hidden') return 0;
      const duration = clamp(Number(durationMs) || 15000, 1200, 60000);
      const profile = String(payload.timingProfile || 'spotlight');
      const preferred = profile === 'feature' ? 5600 : profile === 'full' ? 6400 : profile === 'bumper' ? 2800 : 4600;
      const responsive = Math.round(duration * (profile === 'full' ? 0.18 : 0.32));
      return clamp(Math.max(2400, preferred, responsive), 900, Math.max(900, duration - 500));
    }

    sponsorEndcapDelayMs(payload = {}, durationMs = 15000) {
      const mode = payload.statsMode || 'endcap';
      const duration = clamp(Number(durationMs) || 15000, 1200, 60000);
      if (mode === 'hidden') return duration + 1000;
      if (mode === 'always') return payload.videoUrl ? 900 : 350;
      if (mode === 'delayed') return payload.videoUrl ? Math.min(Math.max(3200, duration * 0.42), Math.max(900, duration - 3600)) : 700;
      return Math.max(700, duration - this.sponsorEndcapDurationMs(payload, duration));
    }

    getSponsorMediaTelemetry(payload = {}) {
      const video = this.sponsorVideo?.video || this.preparedSponsor?.video || null;
      return {
        readyState: video ? video.readyState : null,
        currentTime: video ? video.currentTime : null,
        duration: video ? video.duration : null,
        mediaDurationMs: video && Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : Number(payload.mediaDurationMs) || null,
        mediaWidth: video ? video.videoWidth || payload.mediaWidth || null : payload.mediaWidth || null,
        mediaHeight: video ? video.videoHeight || payload.mediaHeight || null : payload.mediaHeight || null,
      };
    }

    findPlayerRecord(id) {
      const key = String(id || '').trim();
      if (!key) return null;
      if (this.playerMap.has(key)) return this.playerMap.get(key);
      const lowered = key.toLowerCase();
      return this.playerGroups.find(record => {
        return String(record.playerId || '').toLowerCase() === lowered ||
          String(record.data?.name || '').toLowerCase() === lowered;
      }) || null;
    }

    getHordePosition() {
      const horde = this.hordeBounds || {
        x: this.W * 0.2,
        y: this.safe.y + this.safe.height * 0.68,
        width: this.W * 0.6,
        height: Math.max(74, this.H * 0.088),
      };
      return {
        x: horde.x + horde.width / 2,
        y: horde.y + horde.height / 2,
      };
    }

    getStructurePosition(idOrType) {
      const key = String(idOrType || '').trim();
      if (!key || !this.structureRecords) return null;
      const direct = this.structureRecords.get(key);
      if (direct?.bounds) {
        return {
          x: direct.bounds.x + direct.bounds.width / 2,
          y: direct.bounds.y + direct.bounds.height * 0.42,
        };
      }
      const lowered = key.toLowerCase();
      for (const [recordKey, record] of this.structureRecords.entries()) {
        if (
          String(recordKey).toLowerCase() === lowered ||
          String(record?.structure?.name || '').toLowerCase() === lowered ||
          String(record?.structure?.type || '').toLowerCase() === lowered
        ) {
          return {
            x: record.bounds.x + record.bounds.width / 2,
            y: record.bounds.y + record.bounds.height * 0.42,
          };
        }
      }
      return null;
    }

    bossAnchorTtlMs() {
      return 4200;
    }

    getBossCorePosition() {
      const now = Date.now();
      if (this.bossState?.active && this.bossCoreBounds) {
        const point = {
          x: this.bossCoreBounds.x + this.bossCoreBounds.width / 2,
          y: this.bossCoreBounds.y + this.bossCoreBounds.height / 2,
        };
        this.bossCoreAnchorCache = { point, ts: now };
        return { ...point };
      }
      if (this.bossCoreAnchorCache && now - this.bossCoreAnchorCache.ts <= this.bossAnchorTtlMs()) {
        return { ...this.bossCoreAnchorCache.point };
      }
      return null;
    }

    bossAttackSweepKey(data = {}) {
      if (data.bossSweepId != null) return String(data.bossSweepId);
      if (data.bossSweep) return `boss-sweep:${Math.floor(Date.now() / this.bossAnchorTtlMs())}`;
      return '';
    }

    getBossAttackOrigin(data = {}) {
      const now = Date.now();
      const key = this.bossAttackSweepKey(data);
      if (key && this.bossAttackSweepAnchor?.key === key && now - this.bossAttackSweepAnchor.ts <= this.bossAnchorTtlMs()) {
        return { ...this.bossAttackSweepAnchor.point };
      }
      const point = this.getBossCorePosition() || this.getHordePosition();
      if (key || data.bossSweep) {
        this.bossAttackSweepAnchor = {
          key: key || `boss-sweep:${now}`,
          point: { ...point },
          ts: now,
        };
      }
      return { ...point };
    }

    getEntityPosition(id, scope = '') {
      const normalized = String(id || '').toLowerCase();
      const normalizedScope = String(scope || '').toLowerCase();
      if (normalizedScope === 'boss' || normalized === 'boss' || normalized === '@boss' || normalized === '__boss__') {
        return this.getBossCorePosition() || this.getHordePosition();
      }
      if (normalizedScope === 'structure' || normalized.startsWith('aetheris:')) {
        return this.getStructurePosition(id) || this.getHordePosition();
      }
      if (normalizedScope === 'horde' || normalized === 'horde' || normalized === '@horde' || normalized === '__horde__') {
        return this.getHordePosition();
      }
      const record = this.findPlayerRecord(id);
      if (!record) return null;
      return {
        x: record.targetX || record.container.x,
        y: (record.targetY || record.container.y) - (record.cardH || 150 * this.scaleUnit) * 0.12,
      };
    }

    syncFacingTelemetry() {
      window.__overlayV2Facing = Object.fromEntries(this.playerGroups.map(record => [
        record.playerId,
        record.facingDir === -1 ? 'left' : 'right',
      ]));
    }

    facePlayerToward(playerIdOrRecord, targetPoint) {
      const record = playerIdOrRecord?.container ? playerIdOrRecord : this.findPlayerRecord(playerIdOrRecord);
      if (!record?.container || !targetPoint) return;
      const originX = Number(record.targetX || record.container.x);
      const targetX = Number(targetPoint.x);
      if (!Number.isFinite(originX) || !Number.isFinite(targetX)) return;
      const deadZone = Math.max(6, 10 * (this.scaleUnit || 1));
      const nextFacing = Math.abs(targetX - originX) <= deadZone
        ? (record.facingDir || 1)
        : targetX > originX ? 1 : -1;
      if (record.facingDir === nextFacing) return;
      record.facingDir = nextFacing;
      this.redrawPlayer(record);
      this.syncFacingTelemetry();
    }

    pulseCard(playerId, color = 0x7afcff) {
      const record = this.findPlayerRecord(playerId);
      if (!record) return;
      const ring = this.add.graphics();
      const w = (record.cardW || 280 * this.scaleUnit) + 22 * this.scaleUnit;
      const h = (record.cardH || 156 * this.scaleUnit) + 22 * this.scaleUnit;
      ring.lineStyle(Math.max(3, 5 * this.scaleUnit), color, 0.85);
      ring.strokeRoundedRect(-w / 2, -h / 2, w, h, 20 * this.scaleUnit);
      ring.setPosition(record.container.x, record.container.y);
      this.effectLayer.add(ring);
      this.tweens.add({
        targets: ring,
        scaleX: 1.16,
        scaleY: 1.16,
        alpha: 0,
        duration: 560,
        ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      });
    }

    pulseHorde(color = 0xe83b5f) {
      const horde = this.hordeBounds;
      if (!horde) return;
      const ring = this.add.graphics();
      ring.lineStyle(Math.max(3, 5 * this.scaleUnit), color, 0.72);
      ring.strokeRoundedRect(
        -horde.width / 2 - 10 * this.scaleUnit,
        -horde.height / 2 - 10 * this.scaleUnit,
        horde.width + 20 * this.scaleUnit,
        horde.height + 20 * this.scaleUnit,
        horde.height * 0.25
      );
      ring.setPosition(horde.x + horde.width / 2, horde.y + horde.height / 2);
      this.effectLayer.add(ring);
      this.tweens.add({
        targets: ring,
        alpha: 0,
        scaleX: 1.04,
        scaleY: 1.18,
        duration: 620,
        ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      });
    }

    pulseStructure(idOrType, color = 0xff6a3d) {
      const key = String(idOrType || '').trim();
      const record = this.structureRecords?.get(key)
        || this.structureRecords?.get(key.toLowerCase())
        || null;
      if (!record?.bounds) return;
      const ring = this.add.graphics();
      const u = this.scaleUnit || 1;
      ring.lineStyle(Math.max(3, 5 * u), color, 0.82);
      ring.strokeRoundedRect(
        -record.bounds.width / 2 - 8 * u,
        -record.bounds.height / 2 - 8 * u,
        record.bounds.width + 16 * u,
        record.bounds.height + 16 * u,
        12 * u
      );
      ring.setPosition(record.bounds.x + record.bounds.width / 2, record.bounds.y + record.bounds.height / 2);
      this.effectLayer.add(ring);
      this.tweens.add({
        targets: ring,
        alpha: 0,
        scaleX: 1.12,
        scaleY: 1.12,
        duration: 680,
        ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      });
    }

    attackEventKey(data = {}) {
      const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_@.-]+/g, '').slice(0, 80);
      const attacker = normalize(data.attacker || data.attackerId || data.uniqueId || data.userId || data.nickname);
      const target = normalize(data.target || data.targetId || data.victim || data.targetNick || data.targetScope);
      const effect = normalize(data.effect || data.commandDescription || data.shotType || (data.giftId ? 'gift' : 'attack'));
      return attacker || target ? `${attacker}:${target}:${effect}` : '';
    }

    shouldSuppressAttackEvent(data = {}) {
      const key = this.attackEventKey(data);
      if (!key) return false;
      const now = Date.now();
      for (const [storedKey, storedAt] of this.recentAttackKeys.entries()) {
        if (now - storedAt > 1250) this.recentAttackKeys.delete(storedKey);
      }
      const previousAt = this.recentAttackKeys.get(key);
      if (previousAt && now - previousAt <= 430) return true;
      this.recentAttackKeys.set(key, now);
      return false;
    }

    normalizeEffectName(input) {
      const value = String(input || '').trim().toLowerCase();
      const map = {
        bubble: 'arc',
        bubbles: 'arc',
        water: 'arc',
        ripple: 'arc',
        wave: 'arc',
        shock: 'arc',
        arc: 'arc',
        nova: 'pulse',
        pulse: 'pulse',
        sphere: 'sphere',
        orb: 'sphere',
        shot: 'bullet',
        shell: 'bullet',
        bullet: 'bullet',
        projectile: 'projectile',
        rail: 'railgun',
        railgun: 'railgun',
        comet: 'comet',
        meteor: 'comet',
        fire: 'fire',
        prism: 'sphere',
        plasma: 'comet',
        cryo: 'sphere',
        ice: 'sphere',
        freeze: 'sphere',
        ion: 'arc',
        sonic: 'pulse',
        gravity: 'pulse',
        singularity: 'pulse',
        glitch: 'neon',
        orbital: 'railgun',
        drone: 'projectile',
        shard: 'bullet',
        shards: 'bullet',
        laser: 'laser',
        beam: 'beam',
        neon: 'neon',
        gift: 'gift',
        hearts: 'gift',
        boom: 'explosion',
        explode: 'explosion',
        explosion: 'explosion',
        nuke: 'explosion',
        nukes: 'explosion',
        boss: 'railgun',
        bosswave: 'railgun',
      };
      return map[value] || 'laser';
    }

    fireBeam(from, to, damage, type = 'normal', options = {}) {
      const start = from || this.getHordePosition();
      const end = to || this.getHordePosition();
      const color = options.powerColor || options.color || (type === 'kill' ? 0xf6c95b : type === 'critical' ? 0xff315f : this.laserColor);
      const beam = this.add.graphics();
      const effect = this.normalizeEffectName(options.effect || options.shotType || type);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / dist;
      const uy = dy / dist;
      const nx = -uy;
      const ny = ux;
      const unit = this.scaleUnit || 1;
      const width = options.powered ? 15 * unit : options.special ? 11 * unit : 7 * unit;
      const line = (strokeWidth, strokeColor, alpha, sx = start.x, sy = start.y, ex = end.x, ey = end.y) => {
        beam.lineStyle(Math.max(1, strokeWidth), strokeColor, alpha);
        beam.lineBetween(sx, sy, ex, ey);
      };

      if (effect === 'bullet') {
        const body = Math.max(24, 34 * unit);
        const radius = Math.max(6, 8 * unit);
        const tailX = end.x - ux * body;
        const tailY = end.y - uy * body;
        line(Math.max(4, width * 0.8), color, 0.42, start.x, start.y, tailX, tailY);
        line(Math.max(1, 2 * unit), 0xffffff, 0.72, start.x + nx * 5 * unit, start.y + ny * 5 * unit, tailX + nx * 5 * unit, tailY + ny * 5 * unit);
        beam.fillStyle(color, 0.9);
        beam.fillTriangle(end.x, end.y, tailX + nx * radius, tailY + ny * radius, tailX - nx * radius, tailY - ny * radius);
        beam.fillStyle(0xfff0b9, 0.9);
        beam.fillTriangle(end.x - ux * body * 0.22, end.y - uy * body * 0.22, tailX + nx * radius * 0.5, tailY + ny * radius * 0.5, tailX + nx * radius * 0.05, tailY + ny * radius * 0.05);
        const shellCenterX = start.x + dx * 0.18 + nx * 24 * unit;
        const shellCenterY = start.y + dy * 0.18 + ny * 24 * unit;
        const shellL = 18 * unit;
        const shellW = 5 * unit;
        beam.fillStyle(color, 0.72);
        beam.fillTriangle(
          shellCenterX - ux * shellL - nx * shellW,
          shellCenterY - uy * shellL - ny * shellW,
          shellCenterX + ux * shellL - nx * shellW,
          shellCenterY + uy * shellL - ny * shellW,
          shellCenterX + ux * shellL + nx * shellW,
          shellCenterY + uy * shellL + ny * shellW
        );
        beam.fillTriangle(
          shellCenterX - ux * shellL - nx * shellW,
          shellCenterY - uy * shellL - ny * shellW,
          shellCenterX + ux * shellL + nx * shellW,
          shellCenterY + uy * shellL + ny * shellW,
          shellCenterX - ux * shellL + nx * shellW,
          shellCenterY - uy * shellL + ny * shellW
        );
      } else if (effect === 'railgun') {
        line(Math.max(10, width * 1.8), color, 0.38);
        line(Math.max(3, width * 0.48), 0xffffff, 0.95);
        [0.22, 0.42, 0.62, 0.82].forEach((ratio, index) => {
          const x = start.x + dx * ratio;
          const y = start.y + dy * ratio;
          beam.lineStyle(Math.max(1, 2 * unit), index % 2 ? 0xffffff : color, 0.55);
          beam.strokeCircle(x, y, (16 + index * 5) * unit);
        });
      } else if (effect === 'comet' || effect === 'fire') {
        line(Math.max(12, width * 2), color, 0.34, start.x, start.y, end.x - ux * 12 * unit, end.y - uy * 12 * unit);
        line(Math.max(5, width * 0.88), color, 0.72, start.x + nx * 2 * unit, start.y + ny * 2 * unit, end.x, end.y);
        beam.fillStyle(color, 0.45);
        beam.fillCircle(end.x, end.y, Math.max(18, 28 * unit));
        beam.fillStyle(0xfff0b9, 0.94);
        beam.fillCircle(end.x, end.y, Math.max(8, 12 * unit));
      } else if (effect === 'arc') {
        const segments = 7;
        let lastX = start.x;
        let lastY = start.y;
        for (let i = 1; i <= segments; i += 1) {
          const ratio = i / segments;
          const jitter = Math.sin((Date.now() * 0.018) + i * 2.17) * (16 + Number(options.special) * 5) * unit;
          const x = start.x + dx * ratio + nx * jitter;
          const y = start.y + dy * ratio + ny * jitter;
          line(Math.max(4, width * 0.82), color, 0.66, lastX, lastY, x, y);
          line(Math.max(1, 2 * unit), 0xffffff, 0.86, lastX, lastY, x, y);
          lastX = x;
          lastY = y;
        }
      } else if (effect === 'sphere') {
        line(Math.max(4, width * 0.48), color, 0.38, start.x, start.y, end.x, end.y);
        beam.lineStyle(Math.max(3, 4 * unit), color, 0.86);
        beam.strokeCircle(end.x, end.y, Math.max(28, 42 * unit));
        beam.lineStyle(Math.max(1, 2 * unit), 0xffffff, 0.7);
        beam.strokeCircle(end.x, end.y, Math.max(13, 20 * unit));
        beam.fillStyle(color, 0.2);
        beam.fillCircle(end.x, end.y, Math.max(34, 50 * unit));
      } else if (effect === 'pulse') {
        line(Math.max(5, width * 0.62), color, 0.42);
        [0.35, 0.62, 1].forEach((ratio, index) => {
          const x = start.x + dx * ratio;
          const y = start.y + dy * ratio;
          beam.lineStyle(Math.max(2, (5 - index) * unit), index === 2 ? 0xffffff : color, index === 2 ? 0.78 : 0.52);
          beam.strokeCircle(x, y, (20 + index * 15) * unit);
        });
      } else if (effect === 'explosion') {
        line(Math.max(7, width * 0.9), color, 0.5, start.x, start.y, end.x - ux * 12 * unit, end.y - uy * 12 * unit);
        beam.fillStyle(color, 0.62);
        beam.fillCircle(end.x, end.y, Math.max(26, 38 * unit));
        beam.fillStyle(0xfff0b9, 0.92);
        beam.fillCircle(end.x, end.y, Math.max(10, 16 * unit));
        for (let i = 0; i < 10; i += 1) {
          const angle = (Math.PI * 2 * i) / 10;
          const inner = Math.max(18, 24 * unit);
          const outer = Math.max(42, 62 * unit);
          line(
            Math.max(2, 3 * unit),
            i % 2 ? 0xffffff : color,
            i % 2 ? 0.58 : 0.72,
            end.x + Math.cos(angle) * inner,
            end.y + Math.sin(angle) * inner,
            end.x + Math.cos(angle) * outer,
            end.y + Math.sin(angle) * outer
          );
        }
      } else if (effect === 'projectile' || effect === 'gift') {
        line(Math.max(4, width * 0.5), color, 0.34, start.x, start.y, end.x - ux * 24 * unit, end.y - uy * 24 * unit);
        beam.fillStyle(color, effect === 'gift' ? 0.82 : 0.9);
        beam.fillCircle(end.x, end.y, Math.max(14, 22 * unit));
        beam.fillStyle(0xffffff, 0.78);
        beam.fillCircle(end.x - ux * 5 * unit - nx * 4 * unit, end.y - uy * 5 * unit - ny * 4 * unit, Math.max(4, 7 * unit));
        if (effect === 'gift') {
          beam.lineStyle(Math.max(2, 3 * unit), 0xffffff, 0.76);
          beam.strokeCircle(end.x, end.y, Math.max(24, 34 * unit));
        }
      } else if (effect === 'neon' || effect === 'beam') {
        line(Math.max(8, width * 1.2), color, effect === 'neon' ? 0.36 : 0.5);
        line(Math.max(3, width * 0.42), 0xffffff, 0.92);
        line(Math.max(2, width * 0.22), color, 0.82, start.x + nx * 9 * unit, start.y + ny * 9 * unit, end.x + nx * 9 * unit, end.y + ny * 9 * unit);
        line(Math.max(2, width * 0.22), color, 0.82, start.x - nx * 9 * unit, start.y - ny * 9 * unit, end.x - nx * 9 * unit, end.y - ny * 9 * unit);
      } else {
        beam.lineStyle(Math.max(4, width), color, 0.82);
        beam.lineBetween(start.x, start.y, end.x, end.y);
        beam.lineStyle(Math.max(1, 2 * unit), 0xffffff, 0.95);
        beam.lineBetween(start.x, start.y, end.x, end.y);
        beam.fillStyle(color, 0.36);
        beam.fillCircle(end.x, end.y, Math.max(12, 18 * unit));
      }
      const effectDuration = {
        arc: 620,
        bullet: 520,
        comet: 760,
        explosion: 720,
        fire: 760,
        gift: 680,
        neon: 600,
        projectile: 640,
        pulse: 700,
        sphere: 760,
      }[effect] || (type === 'kill' ? 420 : 300);
      if (options.powered) {
        beam.lineStyle(Math.max(2, 3 * unit), 0xf6c95b, 0.78);
        beam.strokeCircle(start.x, start.y, Math.max(20, 30 * unit));
        beam.strokeCircle(end.x, end.y, Math.max(26, 38 * unit));
        beam.lineStyle(Math.max(1, 2 * unit), 0xffffff, 0.52);
        beam.strokeCircle(end.x, end.y, Math.max(36, 52 * unit));
      }
      this.effectLayer.add(beam);
      this.tweens.add({
        targets: beam,
        alpha: 0,
        duration: effectDuration,
        ease: 'Cubic.easeOut',
        onComplete: () => beam.destroy(),
      });

      const damageLabel = options.powerLabel
        ? `${options.powerLabel} ${type === 'kill' ? 'KO' : String(damage || 'HIT')}`
        : (type === 'kill' ? 'KO' : String(damage || 'HIT'));
      const text = this.add.text(end.x, end.y - 26 * this.scaleUnit, damageLabel, {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round((options.powered ? 46 : type === 'kill' ? 62 : type === 'critical' ? 56 : 42) * this.scaleUnit)}px`,
        color: options.powered ? '#fff0b9' : type === 'kill' ? '#fff0b9' : type === 'critical' ? '#ff4268' : '#ffffff',
        stroke: '#02040a',
        strokeThickness: Math.max(5, 8 * this.scaleUnit),
      }).setOrigin(0.5);
      this.effectLayer.add(text);
      this.tweens.add({
        targets: text,
        y: text.y - 122 * this.scaleUnit,
        alpha: 0,
        scaleX: 1.16,
        scaleY: 1.16,
        duration: 920,
        ease: 'Quad.easeOut',
        onComplete: () => text.destroy(),
      });
    }

    handleAttackEvent(data = {}) {
      if (this.shouldSuppressAttackEvent(data)) return;
      const type = data.killed || data.killingBlow ? 'kill' : data.critical ? 'critical' : 'normal';
      const attackerToken = String(data.attacker || data.attackerId || '').toLowerCase();
      const attackerScope = String(data.attackerScope || '').toLowerCase();
      const targetScope = String(data.targetScope || '').toLowerCase();
      const attackerIsBoss = attackerScope === 'boss' || attackerToken === 'boss' || attackerToken === '@boss' || attackerToken === '__boss__';
      const from = attackerIsBoss
        ? this.getBossAttackOrigin(data)
        : (this.getEntityPosition(data.attacker || data.attackerId, data.attackerScope) || this.getHordePosition());
      const to = this.getEntityPosition(data.target || data.targetId, data.targetScope) || this.getHordePosition();
      if (!attackerIsBoss) this.facePlayerToward(data.attacker || data.attackerId, to);
      if (data.target || data.targetId) this.facePlayerToward(data.target || data.targetId, from);
      const beamColor = data.powerColor
        ? hexToNumber(data.powerColor, this.laserColor)
        : data.laserColor ? hexToNumber(data.laserColor, this.laserColor) : undefined;
      this.fireBeam(from, to, data.damage || 'HIT', type, {
        special: Boolean(data.special || data.giftBoosted),
        powered: Boolean(data.poweredAttack),
        effect: data.effect || data.commandDescription || data.shotType,
        color: beamColor,
        powerColor: data.powerColor ? hexToNumber(data.powerColor, this.laserColor) : undefined,
        powerLabel: data.powerLabel,
      });
      if (attackerIsBoss) this.pulseHorde(type === 'kill' ? 0xf6c95b : this.laserColor);
      if (data.poweredAttack && data.attacker) this.pulseCard(data.attacker, data.powerColor ? hexToNumber(data.powerColor, 0xf6c95b) : 0xf6c95b);
      else if (data.attacker || data.attackerId) this.pulseCard(data.attacker || data.attackerId, type === 'kill' ? 0xf6c95b : this.laserColor);
      if (targetScope === 'structure') this.pulseStructure(data.target || data.targetId || data.aetherisStructureId, type === 'kill' ? 0xf6c95b : 0xff6a3d);
      else if (data.target || data.targetId) this.pulseCard(data.target || data.targetId, type === 'kill' ? 0xff5566 : 0xff6a3d);
      if (String(data.target || '').toLowerCase().includes('boss') || targetScope === 'horde') this.pulseHorde(type === 'kill' ? 0xf6c95b : 0xff6a3d);
      if (data.shielded) this.showBanner(`Shield absorbed ${Math.round(Number(data.shieldAbsorbed) || 0)} damage`, 'heal');
      const attackerName = data.attacker || data.attackerId || '';
      const cmd = data.effect || data.commandDescription || data.shotType || (type === 'kill' ? 'KILLING BLOW' : type === 'critical' ? 'CRITICAL HIT' : 'ATTACK');
      if (attackerName) this.updateChatDisplay(attackerName, cmd, beamColor || this.laserColor);
    }

    handleGiftAttackEvent(data = {}) {
      this.handleAttackEvent({ ...data, special: true, giftBoosted: true, critical: data.critical || data.tier === 'legendary', laserColor: data.giftColor || '#f6c95b' });
      if (data.attacker) this.spawnHeartBurst(data.attacker, data.tier === 'legendary' ? 5 : 3, 'gift', data.giftColor || '#f6c95b');
    }

    spawnHeartBurst(playerId, count = 3, kind = 'like', color = '#ff78b2') {
      const record = this.findPlayerRecord(playerId);
      const base = record
        ? { x: record.container.x, y: record.container.y - (record.cardH || 150 * this.scaleUnit) * 0.42 }
        : { x: this.W / 2, y: this.safe.y + this.safe.height * 0.42 };
      const fill = hexToNumber(color, kind === 'heal' ? 0x99ffda : kind === 'repost' ? 0xf6c95b : (kind === 'follow' || kind === 'share') ? 0x7afcff : 0xff78b2);
      for (let index = 0; index < Math.min(12, Math.max(2, count)); index += 1) {
        const label = kind === 'heal' ? '+' : kind === 'follow' ? '*' : '♥';
        const particle = this.add.text(base.x, base.y, label, {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round((kind === 'like' ? 24 : 30) * this.scaleUnit)}px`,
          color: `#${fill.toString(16).padStart(6, '0')}`,
          stroke: '#02040a',
          strokeThickness: Math.max(2, 4 * this.scaleUnit),
        }).setOrigin(0.5);
        this.effectLayer.add(particle);
        this.tweens.add({
          targets: particle,
          x: base.x + (Math.random() - 0.5) * 170 * this.scaleUnit,
          y: base.y - (70 + Math.random() * 90) * this.scaleUnit,
          alpha: 0,
          scaleX: 1.25,
          scaleY: 1.25,
          duration: 880 + Math.random() * 320,
          ease: 'Cubic.easeOut',
          onComplete: () => particle.destroy(),
        });
      }
      if (record) this.pulseCard(playerId, fill);
    }

    handleLikeEvent(data = {}) {
      this.spawnHeartBurst(data.uniqueId || data.userId || data.nickname, Math.max(2, Number(data.hearts) || 2), 'like', data.color || '#ff78b2');
    }

    handleHealEvent(data = {}) {
      this.spawnHeartBurst(data.uniqueId || data.userId || data.nickname, Math.max(2, Math.round((Number(data.amount) || 10) / 8)), 'heal', data.color || '#99ffda');
      this.showBanner(`${data.sourceNick || data.nickname || 'Viewer'} restored health`, 'heal');
    }

    handleFollowEvent(data = {}) {
      const name = data.nickname || data.uniqueId || 'Viewer';
      const shield = Math.round((Number(data.shieldMs) || 0) / 1000);
      this.showBanner(`${name} earned a recruit shield${shield ? ` (${shield}s)` : ''}`, 'follow');
      this.spawnHeartBurst(data.uniqueId || data.userId || data.nickname, 6, 'follow', data.color || '#7afcff');
    }

    showSocialBoost(data = {}) {
      const name = data.nickname || data.uniqueId || 'Viewer';
      const type = String(data.type || 'share').toLowerCase();
      const isRepost = type === 'repost';
      const affected = Number(data.affectedCount) || 0;
      const combo = Number(data.combo) || 0;
      this.showBanner(`${name} ${isRepost ? 'triggered a broadcast surge' : 'rallied the squad'}${affected ? ` (${affected})` : ''}${combo ? ` x${combo}` : ''}`, isRepost ? 'legendary' : 'follow');
      this.spawnHeartBurst(data.uniqueId || data.userId || data.nickname, isRepost ? 9 : 6, isRepost ? 'repost' : 'share', data.color || (isRepost ? '#f6c95b' : '#7afcff'));
      this.pulseHorde(isRepost ? 0xf6c95b : 0x7afcff);
    }

    handleEngagementSurge(data = {}) {
      const tier = String(data.tier || 'surge').toLowerCase();
      const label = data.tierLabel || (tier === 'takeover' ? 'Arena Takeover' : tier === 'viral' ? 'Viral Rally' : 'Crowd Surge');
      const combo = Number(data.combo) || 1;
      this.showBanner(`${label} unlocked x${combo}`, tier === 'takeover' ? 'legendary' : 'gift');
      this.pulseHorde(tier === 'takeover' ? 0xf6c95b : 0x7afcff);
      this.spawnHeartBurst(data.uniqueId || data.nickname || 'crowd', tier === 'takeover' ? 10 : 7, tier === 'takeover' ? 'repost' : 'share', data.color || (tier === 'takeover' ? '#f6c95b' : '#7afcff'));
      this.showDamage(this.W / 2, this.safe.y + this.safe.height * 0.58, label.toUpperCase(), tier === 'takeover' ? 'critical' : 'normal');
    }

    powerRankForPlayer(playerId) {
      const id = String(playerId || '').toLowerCase();
      if (!id || !Array.isArray(this.powerState?.topContributors)) return null;
      return this.powerState.topContributors.find(item => String(item.uniqueId || '').toLowerCase() === id) || null;
    }

    syncPowerHighlights() {
      this.playerGroups.forEach(record => this.redrawPlayer(record));
      window.__arenaPowerUpActive = Boolean(this.powerState?.active);
      window.__arenaPowerUpTop = this.powerState?.topContributors || [];
      if (typeof this.arenaPowerAuditStatus === 'function') window.__overlayV2PowerAudit = this.arenaPowerAuditStatus();
    }

    clearArenaPowerVisuals() {
      if (this.powerCountdownTimer) {
        this.powerCountdownTimer.remove(false);
        this.powerCountdownTimer = null;
      }
      if (this.powerGlow) {
        this.powerGlow.destroy(true);
        this.powerGlow = null;
      }
      if (this.powerChip) {
        this.powerChip.destroy(true);
        this.powerChip = null;
      }
      this.powerState = null;
      this.syncPowerHighlights();
    }

    ensureArenaPowerGlow() {
      if (this.powerGlow) return;
      const u = this.scaleUnit;
      const group = this.add.container(0, 0);
      const glow = this.add.graphics();
      const cx = this.W / 2;
      const cy = this.safe.y + this.safe.height * 0.54;
      glow.fillStyle(0x7afcff, 0.08);
      glow.fillEllipse(cx, cy, this.safe.width * 0.96, this.safe.height * 0.62);
      glow.fillStyle(0xf6c95b, 0.06);
      glow.fillEllipse(cx, cy + 20 * u, this.safe.width * 0.58, this.safe.height * 0.34);
      glow.lineStyle(Math.max(3, 5 * u), 0x7afcff, 0.64);
      glow.strokeRoundedRect(this.safe.x - 18 * u, this.safe.y - 22 * u, this.safe.width + 36 * u, this.safe.height + 34 * u, 26 * u);
      glow.lineStyle(Math.max(2, 3 * u), 0xf6c95b, 0.5);
      glow.strokeRoundedRect(this.safe.x + 8 * u, this.safe.y + 6 * u, this.safe.width - 16 * u, this.safe.height - 12 * u, 22 * u);

      const scan = this.add.rectangle(cx, this.safe.y + 12 * u, this.safe.width * 0.88, Math.max(3, 5 * u), 0x99ffda, 0.32);
      const core = this.add.ellipse(cx, cy, this.safe.width * 0.22, this.safe.height * 0.13, 0xf6c95b, 0.1);
      group.add([glow, core, scan]);
      this.powerLayer.add(group);
      this.powerGlow = group;

      this.tweens.add({ targets: core, scaleX: 1.28, scaleY: 1.42, alpha: 0.22, yoyo: true, repeat: -1, duration: 920, ease: 'Sine.easeInOut' });
      this.tweens.add({ targets: scan, y: this.safe.y + this.safe.height - 12 * u, alpha: 0.08, yoyo: true, repeat: -1, duration: 1500, ease: 'Sine.easeInOut' });
      this.tweens.add({ targets: group, alpha: 0.72, yoyo: true, repeat: -1, duration: 1180, ease: 'Sine.easeInOut' });
    }

    updateArenaPowerChip() {
      if (!this.powerState?.active) return;
      if (!this.powerChip) {
        const u = this.scaleUnit;
        const w = Math.max(300, 364 * u);
        const h = Math.max(82, 96 * u);
        const x = this.safe.x + this.safe.width - w / 2;
        const y = Math.max(116 * u, this.safe.y - 44 * u);
        const group = this.add.container(x, y);
        const bg = this.add.graphics();
        bg.fillStyle(0x061019, 0.9);
        bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8 * u);
        bg.fillStyle(0x7afcff, 0.12);
        bg.fillRoundedRect(-w / 2 + 7 * u, -h / 2 + 7 * u, w - 14 * u, h - 14 * u, 6 * u);
        bg.lineStyle(Math.max(2, 3 * u), 0xf6c95b, 0.76);
        bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 8 * u);
        const title = this.add.text(-w / 2 + 18 * u, -h / 2 + 14 * u, 'ARENA POWER-UP', {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(18 * u)}px`,
          color: '#fff0b9',
          stroke: '#02040a',
          strokeThickness: Math.max(2, 3 * u),
        });
        const time = this.add.text(w / 2 - 18 * u, -h / 2 + 14 * u, '30s', {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(22 * u)}px`,
          color: '#7afcff',
          stroke: '#02040a',
          strokeThickness: Math.max(2, 3 * u),
        }).setOrigin(1, 0);
        const top = this.add.text(-w / 2 + 18 * u, 8 * u, '', {
          fontFamily: 'Arial, sans-serif',
          fontSize: `${Math.round(17 * u)}px`,
          color: '#e7eef5',
          fixedWidth: Math.round(w - 36 * u),
          align: 'left',
        });
        group.add([bg, title, time, top]);
        group.powerTimeText = time;
        group.powerTopText = top;
        this.bannerLayer.add(group);
        this.powerChip = group;
      }

      const remainingMs = this.powerState.endsAt ? Math.max(0, Number(this.powerState.endsAt) - Date.now()) : Number(this.powerState.remainingMs) || 0;
      const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
      const names = (this.powerState.topContributors || [])
        .map(item => `#${item.rank || '?'} ${item.nickname || item.uniqueId || 'Viewer'}`)
        .join('   ');
      this.powerChip.powerTimeText.setText(`${seconds}s`);
      this.powerChip.powerTopText.setText(names || 'Top contributors charging...');
    }

    handleArenaPowerUp(data = {}) {
      const type = String(data.type || '').toLowerCase();
      if (type === 'ended' || data.active === false) {
        this.showBanner('Arena Power-Up ended', 'event');
        this.clearArenaPowerVisuals();
        return;
      }

      if (data.active || ['started', 'leaderboard', 'barrage', 'poweredattack'].includes(type)) {
        this.powerState = {
          ...(this.powerState || {}),
          active: true,
          startedAt: Number(data.startedAt) || this.powerState?.startedAt || Date.now(),
          endsAt: Number(data.endsAt) || this.powerState?.endsAt || null,
          remainingMs: Number(data.remainingMs) || this.powerState?.remainingMs || null,
          topContributors: Array.isArray(data.topContributors) ? data.topContributors : (this.powerState?.topContributors || []),
        };
        this.ensureArenaPowerGlow();
        this.updateArenaPowerChip();
        if (!this.powerCountdownTimer) {
          this.powerCountdownTimer = this.time.addEvent({ delay: 500, loop: true, callback: () => this.updateArenaPowerChip() });
        }
        this.syncPowerHighlights();
      }

      if (type === 'started') {
        this.flashScreen(260, '#7afcff');
        this.showBanner('Arena Power-Up online', 'legendary');
      } else if (type === 'barrage') {
        this.showBanner('Power barrage charging', 'legendary');
        this.pulseHorde(0xf6c95b);
      } else if (type === 'poweredattack') {
        const label = data.label || 'POWER ATTACK';
        const name = data.attackerNick || data.attacker || 'Fighter';
        this.showBanner(`${name} fired ${label}`, 'legendary');
      }
    }

    arenaPowerAuditStatus() {
      const chipBounds = this.powerChip?.getBounds ? this.powerChip.getBounds() : null;
      const glowBounds = this.powerGlow?.getBounds ? this.powerGlow.getBounds() : null;
      const topContributors = Array.isArray(this.powerState?.topContributors) ? this.powerState.topContributors : [];
      return {
        active: Boolean(this.powerState?.active),
        hasGlow: Boolean(this.powerGlow?.active),
        hasChip: Boolean(this.powerChip?.active),
        topCount: topContributors.length,
        topNames: topContributors.map(item => item.nickname || item.uniqueId || ''),
        chipText: this.powerChip?.powerTopText?.text || '',
        countdownText: this.powerChip?.powerTimeText?.text || '',
        powerLayerChildren: this.powerLayer?.length || 0,
        highlighted: this.playerGroups
          .map(record => ({ id: record.playerId, rank: this.powerRankForPlayer(record.playerId)?.rank || 0 }))
          .filter(item => item.rank > 0),
        chipBounds: chipBounds ? {
          left: chipBounds.left,
          right: chipBounds.right,
          top: chipBounds.top,
          bottom: chipBounds.bottom,
          width: chipBounds.width,
          height: chipBounds.height,
        } : null,
        glowBounds: glowBounds ? {
          left: glowBounds.left,
          right: glowBounds.right,
          top: glowBounds.top,
          bottom: glowBounds.bottom,
          width: glowBounds.width,
          height: glowBounds.height,
        } : null,
        safe: { ...this.safe },
        layout: window.__overlayV2Layout || [],
      };
    }

    testArenaPowerUp() {
      this.demoModeActive = false;
      if (this.playerGroups.length < 5) {
        [
          { id: 'demo-1', name: 'NOVAX', health: 100, kills: 3, iconType: 'bolt' },
          { id: 'demo-2', name: 'WEST', health: 86, kills: 2, iconType: 'swords' },
          { id: 'demo-3', name: 'MIRA', health: 73, kills: 1, iconType: 'star' },
          { id: 'demo-4', name: 'BLAZE', health: 44, kills: 4, teamColor: '#ff45a0', iconType: 'fire' },
          { id: 'demo-5', name: 'ASHLEE', health: 94, kills: 2, iconType: 'core' },
        ].forEach(player => this.addPlayerCard(player));
      }
      this.handleArenaPowerUp({
        type: 'started',
        active: true,
        startedAt: Date.now(),
        endsAt: Date.now() + 30000,
        durationMs: 30000,
        trigger: 'visual_audit',
        topContributors: [
          { uniqueId: 'demo-1', nickname: 'NOVAX', rank: 1, score: 120, multiplier: 4.25, color: '#ffd666' },
          { uniqueId: 'demo-2', nickname: 'WEST', rank: 2, score: 88, multiplier: 3.55, color: '#7afcff' },
          { uniqueId: 'demo-3', nickname: 'MIRA', rank: 3, score: 64, multiplier: 3, color: '#99ffda' },
        ],
      });
      this.handleArenaPowerUp({
        type: 'poweredAttack',
        active: true,
        attacker: 'demo-1',
        attackerNick: 'NOVAX',
        target: 'demo-4',
        targetNick: 'BLAZE',
        label: 'OVERDRIVE',
        powerLabel: 'OVERDRIVE',
        color: '#f6c95b',
        powerColor: '#f6c95b',
        multiplier: 4.25,
        powerMultiplier: 4.25,
      });
      this.handleAttackEvent({
        attacker: 'demo-1',
        attackerNick: 'NOVAX',
        target: 'demo-4',
        targetNick: 'BLAZE',
        damage: 118,
        poweredAttack: true,
        powerLabel: 'OVERDRIVE',
        powerColor: '#f6c95b',
        powerMultiplier: 4.25,
        effect: 'railgun',
        critical: true,
      });
      this.layoutPlayers(false);
      window.__overlayV2PowerAudit = this.arenaPowerAuditStatus();
      return window.__overlayV2PowerAudit;
    }

    spawnRespawnEffect(playerId) {
      const record = this.findPlayerRecord(playerId);
      const pos = record ? { x: record.container.x, y: record.container.y } : { x: this.W / 2, y: this.safe.y + this.safe.height * 0.42 };
      const ring = this.add.graphics();
      ring.lineStyle(Math.max(4, 7 * this.scaleUnit), 0x99ffda, 0.88);
      ring.strokeCircle(pos.x, pos.y, 42 * this.scaleUnit);
      this.effectLayer.add(ring);
      this.tweens.add({
        targets: ring,
        scaleX: 2.2,
        scaleY: 2.2,
        alpha: 0,
        duration: 720,
        ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      });
      if (playerId) this.pulseCard(playerId, 0x99ffda);
    }

    handlePlayerCommand(data = {}) {
      const name = data.nickname || data.sourceNick || data.uniqueId || 'Viewer';
      if (data.type === 'emoji') {
        this.showBanner(`${name} changed their icon ${data.iconEmoji || ''}`, 'follow');
        this.pulseCard(data.uniqueId, 0x7afcff);
      } else if (data.type === 'heal') {
        this.handleHealEvent(data);
      } else if (data.type === 'shield') {
        this.showBanner(`${name} raised a shield`, 'heal');
        this.pulseCard(data.uniqueId, 0x7afcff);
      } else if (data.type === 'help') {
        this.showBanner('Comment or tap like to enter. Try @name, !emoji, !shield, !laser @name', 'event');
      } else if (data.type === 'join') {
        this.showBanner(`${name} entered the arena`, 'follow');
      }
    }

    handleKillEvent(data = {}) {
      this.handleAttackEvent({
        attacker: data.killer,
        target: data.victim,
        damage: data.damage || 'KO',
        killed: true,
        effect: data.effect || 'explosion',
        attackerScope: data.attackerScope,
        targetScope: data.targetScope,
      });
      const killerName = data.killerNick || data.killer || 'Fighter';
      const victimName = data.victimNick || data.victim || 'Opponent';
      this.showBanner(`${killerName} eliminated ${victimName}`, Number(data.killerStreak || 0) >= 5 ? 'legendary' : 'kill');
    }

    handleStreakEvent(data = {}) {
      const name = data.nickname || data.killerNick || 'Fighter';
      const streak = Number(data.streak || data.streakCount || 0);
      this.showBanner(`${name} is on a ${streak || 1} KO streak`, streak >= 10 ? 'legendary' : 'kill');
    }

    handleGiftCelebration(data = {}) {
      const name = data.nickname || 'Viewer';
      const gift = data.giftName || 'a gift';
      const streak = Number(data.streak || 0);
      const isStreak = streak >= 2;
      const bannerText = isStreak ? `🔥 ${name} is on a ${streak}x GIFT STREAK!` : `${name} sent ${gift}`;
      this.showBanner(bannerText, data.tier === 'legendary' ? 'legendary' : 'gift');
      const heartCount = (data.tier === 'legendary' ? 8 : 4) + (isStreak ? Math.min(streak, 6) : 0);
      this.spawnHeartBurst(data.uniqueId || data.userId || data.nickname, heartCount, 'gift', data.tier === 'legendary' ? '#f6c95b' : '#ff8bc2');
    }

    handleRoundEvent(data = {}) {
      const type = String(data.type || '').toLowerCase();
      if (type === 'round_started') {
        this.showBanner(data.title || `Round ${Number(data.number) || 1} is live`, 'kill');
      } else if (type === 'round_ended') {
        const leader = Array.isArray(data.topPlayers) ? data.topPlayers[0] : null;
        this.showBanner(leader ? `${leader.nickname || leader.uniqueId} leads the arena` : (data.title || 'Round complete'), 'gift');
      } else if (type === 'boss_started') {
        this.handleBossWave({ type: 'started', hp: data.hp || data.maxHp || 100, maxHp: data.maxHp || data.hp || 100 });
      } else if (type === 'boss_defeated') {
        this.handleBossWave({ type: 'defeated', finalHitBy: { nickname: data.message || '' } });
      } else if (type === 'session_started') {
        this.showBanner(data.title || 'Battle session started', 'follow');
      } else if (type === 'session_ended') {
        const winner = data.recap?.winner?.nickname || data.recap?.winner?.uniqueId;
        this.showBanner(winner ? `${winner} finished on top` : 'Session recap ready', 'gift');
      }
    }

    handleBossWave(data = {}) {
      const type = String(data.type || '').toLowerCase();
      if (type === 'started' || (data.active === true && !type)) {
        this.bossState = {
          active: true,
          hp: Number(data.hp || data.maxHp || 100),
          maxHp: Number(data.maxHp || data.hp || 100),
          endsAt: Number(data.endsAt) || null,
          remainingMs: Number(data.remainingMs) || null,
          nextAttackAt: Number(data.nextAttackAt) || null,
          attackIntervalMs: Number(data.attackIntervalMs) || null,
        };
        this.drawHorde();
        this.getBossCorePosition();
        this.showBanner(type === 'attack' ? 'Boss wave strike' : 'Boss wave incoming', 'legendary');
        this.pulseHorde(0xf6c95b);
        return;
      }
      if (type === 'damaged' || type === 'attack') {
        this.bossState = {
          active: true,
          hp: Number(data.hp || 0),
          maxHp: Number(data.maxHp || 1),
          endsAt: Number(data.endsAt) || this.bossState?.endsAt || null,
          remainingMs: Number(data.remainingMs) || this.bossState?.remainingMs || null,
          nextAttackAt: Number(data.nextAttackAt) || this.bossState?.nextAttackAt || null,
          attackIntervalMs: Number(data.attackIntervalMs) || this.bossState?.attackIntervalMs || null,
        };
        this.drawHorde();
        this.getBossCorePosition();
        const hitter = data.lastHitBy?.nickname || data.lastHitBy?.uniqueId || 'Viewer';
        this.showBanner(type === 'attack' ? 'Boss wave strikes the arena' : `${hitter} hit the boss wave`, Number(data.hp || 0) <= Number(data.maxHp || 1) * 0.25 ? 'legendary' : 'kill');
        this.pulseHorde(0xff6a3d);
        return;
      }
      if (type === 'defeated') {
        this.bossState = null;
        this.showBanner('Boss wave defeated', 'legendary');
        this.pulseHorde(0xf6c95b);
        return;
      }
      if (['stopped', 'ended', 'restarted'].includes(type) || data.active === false) {
        this.bossState = null;
        this.showBanner('Boss wave ended', 'event');
      }
    }

    showSoundPulse(eventName) {
      if (!eventName) return;
      const pos = { x: this.safe.x + this.safe.width - 78 * this.scaleUnit, y: this.safe.y + 58 * this.scaleUnit };
      const pulse = this.add.text(pos.x, pos.y, 'SND', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(18 * this.scaleUnit)}px`,
        color: '#99ffda',
        stroke: '#02040a',
        strokeThickness: Math.max(2, 4 * this.scaleUnit),
      }).setOrigin(0.5);
      this.effectLayer.add(pulse);
      this.tweens.add({
        targets: pulse,
        alpha: 0,
        y: pos.y - 34 * this.scaleUnit,
        duration: 520,
        ease: 'Cubic.easeOut',
        onComplete: () => pulse.destroy(),
      });
    }

    setBackgroundImageUrl(url) {
      this.customBackgroundUrl = url || null;
      if (this.customBackground) {
        this.customBackground.destroy();
        this.customBackground = null;
      }
      if (this.customBackgroundKey && this.textures.exists(this.customBackgroundKey)) {
        this.textures.remove(this.customBackgroundKey);
        this.customBackgroundKey = null;
      }
      if (!url) {
        this.drawBackground();
        return;
      }

      const key = `overlayV2Background-${Date.now()}`;
      this.customBackgroundKey = key;
      this.load.image(key, url);
      this.load.once('complete', () => {
        if (!this.textures.exists(key)) return;
        const image = this.add.image(this.safe.x + this.safe.width / 2, this.safe.y + this.safe.height / 2, key).setDepth(1);
        const scale = this.backgroundFit === 'cover'
          ? Math.max(this.safe.width / image.width, this.safe.height / image.height)
          : Math.min(this.safe.width / image.width, this.safe.height / image.height);
        image.setScale(scale);
        image.setAlpha(0.72);
        this.customBackground = image;
        this.backgroundLayer.add(image);
      });
      this.load.start();
    }

    updateBackgroundFit(value) {
      this.backgroundFit = value === 'cover' ? 'cover' : 'contain';
      if (this.customBackground) {
        const scale = this.backgroundFit === 'cover'
          ? Math.max(this.safe.width / this.customBackground.width, this.safe.height / this.customBackground.height)
          : Math.min(this.safe.width / this.customBackground.width, this.safe.height / this.customBackground.height);
        this.customBackground
          .setPosition(this.safe.x + this.safe.width / 2, this.safe.y + this.safe.height / 2)
          .setScale(scale);
      }
    }

    normalizePlayer(player) {
      const id = String(player.id || player.userId || player.uniqueId || `player-${Date.now()}-${Math.random()}`);
      return {
        id,
        name: escapeName(player.name || player.nickname || player.uniqueId || id),
        health: clamp(Number(player.health ?? player.hp ?? 100), 0, 100),
        kills: Number(player.kills || 0),
        deaths: Number(player.deaths || 0),
        color: player.color || '',
        teamId: player.teamId || '',
        teamName: player.teamName || '',
        teamColor: player.teamColor || '',
        iconType: player.iconType || player.icon || '',
        iconEmoji: player.iconEmoji || '',
      };
    }

    addPlayerCard(player) {
      const data = this.normalizePlayer(player);
      if (this.playerMap.has(data.id)) {
        this.updatePlayerStats(data.id, data);
        return;
      }

      const container = this.add.container(0, 0);
      const gfx = this.add.graphics();
      const avatar = this.add.graphics();
      const nameText = this.add.text(0, 0, data.name, {
        fontFamily: 'Arial Black, Inter, sans-serif',
        fontSize: `${Math.round(24 * this.scaleUnit)}px`,
        color: '#ffffff',
        align: 'center',
        fixedWidth: Math.round(238 * this.scaleUnit),
      }).setOrigin(0.5);
      const killsText = this.add.text(0, 0, '0 KOs', {
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(20 * this.scaleUnit)}px`,
        color: '#fff0b9',
        align: 'center',
        fixedWidth: Math.round(210 * this.scaleUnit),
      }).setOrigin(0.5);
      const hpText = this.add.text(0, 0, '100%', {
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(18 * this.scaleUnit)}px`,
        color: '#99ffda',
        align: 'right',
      }).setOrigin(1, 0.5);
      const rankText = this.add.text(0, 0, '#1', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(18 * this.scaleUnit)}px`,
        color: '#02040a',
        align: 'center',
      }).setOrigin(0.5);

      container.add([gfx, avatar, nameText, killsText, hpText, rankText]);
      this.playerLayer.add(container);

      const record = { playerId: data.id, data, container, gfx, avatar, nameText, killsText, hpText, rankText, targetY: 0, facingDir: 1 };
      this.playerGroups.push(record);
      this.playerMap.set(data.id, record);
      this.syncFacingTelemetry();
      this.layoutPlayers(true);
      if (!this.demoModeActive) this.showBanner(`${data.name} entered the arena`, 'join');
    }

    removePlayerCard(playerId) {
      const id = String(playerId || '');
      const record = this.playerMap.get(id);
      if (!record) return;
      this.playerMap.delete(id);
      this.playerGroups = this.playerGroups.filter(player => player.playerId !== id);
      this.tweens.add({
        targets: record.container,
        alpha: 0,
        scaleX: 0.84,
        scaleY: 0.84,
        y: record.container.y + 30 * this.scaleUnit,
        duration: 240,
        ease: 'Cubic.easeIn',
        onComplete: () => record.container.destroy(),
      });
      this.layoutPlayers(false);
    }

    updatePlayerStats(playerId, stats) {
      const id = String(playerId || stats?.id || '');
      const record = this.playerMap.get(id);
      if (!record) {
        this.addPlayerCard({ ...(stats || {}), id });
        return;
      }
      record.data = { ...record.data, ...this.normalizePlayer({ ...record.data, ...(stats || {}), id }) };
      this.redrawPlayer(record);
      this.layoutPlayers(false);
    }

    layoutPlayers(animate = true) {
      const visible = this.playerGroups
        .slice()
        .sort((a, b) => (Number(b.data.kills || 0) - Number(a.data.kills || 0)) || String(a.data.name).localeCompare(String(b.data.name)))
        .slice(0, 5);
      const count = Math.max(1, visible.length);
      const gap = Math.max(30 * this.scaleUnit, this.W * 0.016);
      const cardW = Math.min(310 * this.scaleUnit, (this.safe.width - gap * (count - 1)) / count);
      const cardH = Math.max(142 * this.scaleUnit, cardW * 0.52);
      const totalW = cardW * count + gap * (count - 1);
      const startX = (this.W - totalW) / 2 + cardW / 2;
      const y = this.safe.y + this.safe.height * 0.58;

      visible.forEach((record, index) => {
        this.tweens.killTweensOf(record.container);
        this.tweens.killTweensOf(record);
        record.cardW = cardW;
        record.cardH = cardH;
        record.rank = index + 1;
        record.targetX = startX + index * (cardW + gap);
        record.targetY = y;
        record.floatOffset = record.floatOffset || 0;
        record.container.setDepth(40 + index);
        this.redrawPlayer(record);
        record.container.setPosition(record.targetX, record.targetY + (record.floatOffset || 0));
        if (animate && !record.hasEntered) {
          record.floatOffset = 24 * this.scaleUnit;
          record.container.setAlpha(0);
          record.container.setScale(0.92);
          this.tweens.add({
            targets: record.container,
            alpha: 1,
            scaleX: 1,
            scaleY: 1,
            duration: 360,
            delay: index * 55,
            ease: 'Back.easeOut',
          });
          this.tweens.add({
            targets: record,
            floatOffset: 0,
            duration: 360,
            delay: index * 55,
            ease: 'Cubic.easeOut',
          });
          record.hasEntered = true;
        } else {
          record.container.setAlpha(1);
          record.container.setScale(1);
        }
      });

      this.playerGroups.forEach(record => {
        record.container.setVisible(visible.includes(record));
      });
      this.syncFacingTelemetry();
      window.__overlayV2Layout = visible.map(record => ({
        id: record.playerId,
        x: record.targetX,
        y: record.targetY,
        width: record.cardW,
        height: record.cardH,
        left: record.targetX - record.cardW / 2,
        right: record.targetX + record.cardW / 2,
        top: record.targetY - record.cardH / 2,
        bottom: record.targetY + record.cardH / 2,
        powerRank: this.powerRankForPlayer(record.playerId)?.rank || 0,
      }));
    }

    redrawPlayer(record) {
      const w = record.cardW || 306 * this.scaleUnit;
      const h = record.cardH || 158 * this.scaleUnit;
      const u = this.scaleUnit;
      const health = clamp(Number(record.data.health || 0), 0, 100);
      const top = -h / 2;
      const left = -w / 2;
      const healthColor = health > 66 ? 0x7afcff : health > 34 ? 0xf6c95b : 0xff5566;
      const teamColor = record.data.teamColor ? hexToNumber(record.data.teamColor, healthColor) : null;
      const accentColor = teamColor || healthColor;
      const powerRank = this.powerRankForPlayer(record.playerId);
      const powerColor = powerRank ? hexToNumber(powerRank.color || (powerRank.rank === 1 ? '#f6c95b' : powerRank.rank === 2 ? '#7afcff' : '#99ffda'), 0xf6c95b) : null;
      const accentHex = `#${accentColor.toString(16).padStart(6, '0')}`;
      const r = Math.max(8, 12 * u);
      const tabH = Math.max(30, 38 * u);
      const tabW = w * 0.5;

      record.gfx.clear();
      if (powerRank) {
        record.gfx.fillStyle(powerColor, 0.14);
        record.gfx.fillRoundedRect(left - 12 * u, top - 18 * u, w + 24 * u, h + 30 * u, r * 1.25);
        record.gfx.lineStyle(Math.max(4, 7 * u), powerColor, 0.68);
        record.gfx.strokeRoundedRect(left - 10 * u, top - 16 * u, w + 20 * u, h + 26 * u, r * 1.1);
      }
      record.gfx.fillStyle(0x000000, 0.42);
      record.gfx.fillRoundedRect(left + 10 * u, top + 12 * u, w, h, r);

      record.gfx.fillStyle(0x2b3540, 0.98);
      record.gfx.fillRoundedRect(left, top, w, h, r);
      record.gfx.fillStyle(0x99a7b3, 0.2);
      record.gfx.fillRoundedRect(left + 10 * u, top + 8 * u, w - 20 * u, h * 0.34, r * 0.7);
      record.gfx.fillStyle(0x0b1017, 0.34);
      record.gfx.fillRoundedRect(left + 14 * u, top + h * 0.46, w - 28 * u, h * 0.36, r * 0.4);
      record.gfx.fillStyle(accentColor, 0.11);
      record.gfx.fillRoundedRect(left + 8 * u, top + 8 * u, w - 16 * u, h - 16 * u, r * 0.76);
      record.gfx.lineStyle(Math.max(3, 5 * u), 0xb9c5cf, 0.88);
      record.gfx.strokeRoundedRect(left, top, w, h, r);
      record.gfx.lineStyle(Math.max(2, 3 * u), accentColor, 0.72);
      record.gfx.strokeRoundedRect(left + 6 * u, top + 6 * u, w - 12 * u, h - 12 * u, r * 0.62);
      record.gfx.lineStyle(Math.max(1, 2 * u), 0xffffff, 0.28);
      record.gfx.lineBetween(left + 20 * u, top + 12 * u, left + w - 20 * u, top + 12 * u);
      record.gfx.lineStyle(Math.max(3, 4 * u), 0x10151d, 0.82);
      record.gfx.lineBetween(left + 22 * u, top + h - 8 * u, left + w - 22 * u, top + h - 8 * u);

      record.gfx.fillStyle(0x202731, 0.98);
      record.gfx.fillRoundedRect(left + (w - tabW) / 2, top - tabH * 0.52, tabW, tabH, Math.max(6, 8 * u));
      record.gfx.fillStyle(0xb8c4ce, 0.22);
      record.gfx.fillRoundedRect(left + (w - tabW) / 2 + 6 * u, top - tabH * 0.44, tabW - 12 * u, tabH * 0.38, Math.max(4, 6 * u));
      record.gfx.lineStyle(Math.max(2, 3 * u), 0x9ca9b3, 0.95);
      record.gfx.strokeRoundedRect(left + (w - tabW) / 2, top - tabH * 0.52, tabW, tabH, Math.max(6, 8 * u));

      const sideW = Math.max(16, 22 * u);
      record.gfx.fillStyle(0x9caec0, 0.34);
      record.gfx.fillRoundedRect(left - sideW * 0.18, top + h * 0.2, sideW, h * 0.56, 6 * u);
      record.gfx.fillRoundedRect(left + w - sideW * 0.82, top + h * 0.2, sideW, h * 0.56, 6 * u);
      record.gfx.lineStyle(Math.max(2, 3 * u), 0xc9eaff, 0.46);
      record.gfx.lineBetween(left + 10 * u, top + h - 8 * u, left + w - 10 * u, top + h - 8 * u);
      record.gfx.fillStyle(0xd9e6f0, 0.18);
      record.gfx.fillTriangle(left + 10 * u, top + 18 * u, left + 38 * u, top + 8 * u, left + 18 * u, top + 48 * u);
      record.gfx.fillTriangle(left + w - 10 * u, top + 18 * u, left + w - 38 * u, top + 8 * u, left + w - 18 * u, top + 48 * u);

      const hpH = Math.max(12, 16 * u);
      const hpX = left + 34 * u;
      const hpW = w - 68 * u;
      const hpY = top + h - Math.max(30, 36 * u);
      record.gfx.fillStyle(0x10151b, 0.98);
      record.gfx.fillRoundedRect(hpX - 7 * u, hpY - 5 * u, hpW + 14 * u, hpH + 10 * u, hpH / 2);
      record.gfx.lineStyle(Math.max(1, 2 * u), 0x6e7478, 0.62);
      record.gfx.strokeRoundedRect(hpX - 7 * u, hpY - 5 * u, hpW + 14 * u, hpH + 10 * u, hpH / 2);
      if (health > 0) {
        record.gfx.fillStyle(healthColor, 0.86);
        record.gfx.fillRoundedRect(hpX, hpY, Math.max(hpH, hpW * (health / 100)), hpH, hpH / 2);
        record.gfx.fillStyle(0xffffff, 0.22);
        record.gfx.fillRoundedRect(hpX + 2 * u, hpY + 2 * u, Math.max(0, hpW * (health / 100) - 4 * u), hpH * 0.38, hpH / 2);
      }

      record.avatar.clear();
      const iconY = top + h * 0.47;
      record.avatar.fillStyle(0x0d1118, 0.58);
      record.avatar.fillCircle(0, iconY + 6 * u, 50 * u);
      this.drawPlayerIcon(record.avatar, this.resolvePlayerIcon(record), 0, iconY, 1, accentColor);
      const facingDir = record.facingDir === -1 ? -1 : 1;
      const faceTipX = facingDir * 42 * u;
      const faceBaseX = facingDir * 18 * u;
      record.avatar.fillStyle(accentColor, 0.84);
      record.avatar.fillTriangle(faceTipX, iconY + 4 * u, faceBaseX, iconY - 11 * u, faceBaseX, iconY + 19 * u);
      record.avatar.lineStyle(Math.max(1, 2 * u), 0xffffff, 0.66);
      record.avatar.lineBetween(faceBaseX, iconY - 8 * u, faceTipX - facingDir * 6 * u, iconY + 3 * u);

      record.nameText.setText(record.data.name);
      record.nameText.setStyle({
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.06, 15 * u, 20 * u))}px`,
        color: '#e7eef5',
        fixedWidth: Math.round(tabW - 12 * u),
        align: 'center',
        stroke: '#05070d',
        strokeThickness: Math.max(1, 2 * u),
      });
      record.nameText.setPosition(0, top - tabH * 0.02);

      record.killsText.setText('');
      record.hpText.setText('');
      record.rankText.setText(powerRank ? `PWR #${powerRank.rank}` : '');
      record.killsText.setStyle({ color: '#fff0b9' });
      record.hpText.setStyle({ color: accentHex });
      record.rankText.setStyle({
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(18 * u)}px`,
        color: powerRank ? `#${powerColor.toString(16).padStart(6, '0')}` : accentHex,
        stroke: '#02040a',
        strokeThickness: Math.max(2, 3 * u),
      });
      record.rankText.setPosition(0, top + h - 16 * u);
    }

    createChatDisplay() {
      this.chatSlots = [];
      this.chatLayer = this.add.container(0, 0);
      this.worldLayer.add(this.chatLayer);

      const slotCount = 3;
      const gap = Math.max(42, 58 * this.scaleUnit);
      const totalW = Math.min(this.safe.width * 0.8, this.W * 0.74);
      const slotW = (totalW - gap * (slotCount - 1)) / slotCount;
      const slotH = Math.max(70, 82 * this.scaleUnit);
      const slotY = this.safe.y + this.safe.height * 0.2;
      const startX = (this.W - totalW) / 2;
      const labels = ['NOVAX', 'WEST', 'MIRA'];

      for (let i = 0; i < slotCount; i += 1) {
        const slotX = startX + i * (slotW + gap);
        const gfx = this.add.graphics();
        const userText = this.add.text(0, 0, '', {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(16 * this.scaleUnit)}px`,
          color: '#cfd6dc',
        }).setOrigin(0, 0.5);
        const labelText = this.add.text(0, 0, '', {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(17 * this.scaleUnit)}px`,
          color: '#dce3e9',
          stroke: '#05070d',
          strokeThickness: Math.max(1, 2 * this.scaleUnit),
        }).setOrigin(0.5);
        const cmdText = this.add.text(0, 0, '', {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(20 * this.scaleUnit)}px`,
          color: '#ffe6b2',
          align: 'right',
        }).setOrigin(0, 0.5);
        const slot = { gfx, labelText, userText, cmdText, slotX, slotY, slotW, slotH, label: labels[i], username: '', command: '', accentColor: 0x7afcff };
        this.chatSlots.push(slot);
        this.chatLayer.add([gfx, labelText, userText, cmdText]);
        this.redrawChatSlot(slot);
      }
    }

    updateChatDisplay(username, command, accentColor = 0x7afcff) {
      if (!this.chatSlots || !this.chatSlots.length) return;
      for (let i = this.chatSlots.length - 1; i > 0; i -= 1) {
        const prev = this.chatSlots[i - 1];
        this.chatSlots[i].username = prev.username;
        this.chatSlots[i].command = prev.command;
        this.chatSlots[i].accentColor = prev.accentColor;
        this.redrawChatSlot(this.chatSlots[i]);
      }
      this.chatSlots[0].username = `@${String(username || 'viewer').toLowerCase().slice(0, 20)}`;
      this.chatSlots[0].command = String(command || 'ATTACK').toUpperCase().slice(0, 24);
      this.chatSlots[0].accentColor = typeof accentColor === 'number' ? accentColor : 0x7afcff;
      this.redrawChatSlot(this.chatSlots[0]);
    }

    redrawChatSlot(slot) {
      const u = this.scaleUnit;
      const accentColor = slot.accentColor || 0x7afcff;
      const isEmpty = !slot.username;
      const x = slot.slotX;
      const y = slot.slotY;
      const w = slot.slotW;
      const h = slot.slotH;
      const tabW = Math.min(w * 0.34, 156 * u);
      const tabH = Math.max(32, 40 * u);
      const tabX = x + (w - tabW) / 2;
      const iconKind = this.commandIconKind(slot.command);
      const commandText = slot.command || 'COMMAND READY';

      slot.gfx.clear();
      const radius = Math.max(22, h * 0.42);
      const rimColor = isEmpty ? 0x78838d : 0xc0a479;
      const lowerAccent = isEmpty ? 0x4e5964 : accentColor;
      slot.gfx.fillStyle(0x000000, 0.5);
      slot.gfx.fillRoundedRect(x + 10 * u, y + 12 * u, w, h, radius);

      slot.gfx.fillStyle(0x1b2028, 0.98);
      slot.gfx.fillRoundedRect(x, y, w, h, radius);
      slot.gfx.fillStyle(0x59616a, 0.48);
      slot.gfx.fillRoundedRect(x + 8 * u, y + 6 * u, w - 16 * u, h * 0.48, radius * 0.78);
      slot.gfx.fillStyle(0x0a0d12, 0.44);
      slot.gfx.fillRoundedRect(x + 10 * u, y + h * 0.5, w - 20 * u, h * 0.38, radius * 0.55);
      slot.gfx.fillStyle(lowerAccent, isEmpty ? 0.04 : 0.08);
      slot.gfx.fillRoundedRect(x + 7 * u, y + 7 * u, w - 14 * u, h - 14 * u, radius * 0.8);
      slot.gfx.lineStyle(Math.max(3, 5 * u), 0x10141a, 0.9);
      slot.gfx.strokeRoundedRect(x - 2 * u, y - 2 * u, w + 4 * u, h + 4 * u, radius);
      slot.gfx.lineStyle(Math.max(2, 4 * u), rimColor, 0.74);
      slot.gfx.strokeRoundedRect(x, y, w, h, radius);
      slot.gfx.lineStyle(Math.max(1, 2 * u), 0xe4eef7, 0.26);
      slot.gfx.strokeRoundedRect(x + 6 * u, y + 6 * u, w - 12 * u, h - 12 * u, radius * 0.72);
      slot.gfx.lineStyle(Math.max(2, 3 * u), lowerAccent, isEmpty ? 0.18 : 0.76);
      slot.gfx.lineBetween(x + 34 * u, y + h - 8 * u, x + w - 34 * u, y + h - 8 * u);

      slot.gfx.fillStyle(0x20262f, 1);
      slot.gfx.fillRoundedRect(tabX, y - tabH * 0.76, tabW, tabH, Math.max(8, 10 * u));
      slot.gfx.fillStyle(0xaab4be, 0.25);
      slot.gfx.fillRoundedRect(tabX + 8 * u, y - tabH * 0.66, tabW - 16 * u, tabH * 0.38, Math.max(5, 7 * u));
      slot.gfx.fillStyle(0x04070b, 0.22);
      slot.gfx.fillRect(tabX + 8 * u, y - tabH * 0.24, tabW - 16 * u, 5 * u);
      slot.gfx.lineStyle(Math.max(2, 3 * u), 0x9eabb5, 0.95);
      slot.gfx.strokeRoundedRect(tabX, y - tabH * 0.76, tabW, tabH, Math.max(8, 10 * u));
      slot.gfx.lineStyle(Math.max(1, 2 * u), 0x303741, 0.95);
      slot.gfx.strokeRoundedRect(tabX + 4 * u, y - tabH * 0.66, tabW - 8 * u, tabH - 8 * u, Math.max(5, 7 * u));

      const wing = Math.max(26, 34 * u);
      slot.gfx.fillStyle(0x1b2028, 0.94);
      slot.gfx.fillTriangle(x - wing * 0.18, y + h * 0.5, x + 24 * u, y + 9 * u, x + 24 * u, y + h - 9 * u);
      slot.gfx.fillTriangle(x + w + wing * 0.18, y + h * 0.5, x + w - 24 * u, y + 9 * u, x + w - 24 * u, y + h - 9 * u);
      slot.gfx.lineStyle(Math.max(1, 2 * u), 0xc8d3df, 0.25);
      slot.gfx.lineBetween(x + 18 * u, y + 11 * u, x + 58 * u, y + 11 * u);
      slot.gfx.lineBetween(x + w - 58 * u, y + 11 * u, x + w - 18 * u, y + 11 * u);

      slot.gfx.lineStyle(Math.max(2, 3 * u), lowerAccent, isEmpty ? 0.18 : 0.88);
      slot.gfx.lineBetween(x + w * 0.5 - 20 * u, y + h, x + w * 0.5, y + h + 20 * u);
      slot.gfx.lineBetween(x + w * 0.5 + 20 * u, y + h, x + w * 0.5, y + h + 20 * u);
      this.drawCommandIcon(slot.gfx, iconKind, x + w * 0.5, y + h + 56 * u, 0.95, accentColor);

      slot.labelText.setText(slot.label || '');
      slot.labelText.setStyle({
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(17 * u)}px`,
        color: '#dce3e9',
        stroke: '#05070d',
        strokeThickness: Math.max(1, 2 * u),
      });
      slot.labelText.setPosition(tabX + tabW / 2, y - tabH * 0.26);

      const userColor = isEmpty ? '#566170' : '#cfd6dc';
      const cmdColor = isEmpty ? '#566170' : '#ffe6b2';
      slot.userText.setText(slot.username || '@viewer');
      slot.userText.setStyle({
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(16 * u)}px`,
        color: userColor,
        fixedWidth: Math.round(w * 0.4),
        align: 'left',
      });
      slot.userText.setPosition(x + 28 * u, y + h * 0.54);
      slot.userText.setAlpha(isEmpty ? 0.24 : 1);

      slot.cmdText.setText(commandText);
      slot.cmdText.setStyle({
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.045, 18 * u, 24 * u))}px`,
        color: cmdColor,
        fixedWidth: Math.round(w * 0.55),
        align: 'right',
        stroke: '#06070b',
        strokeThickness: Math.max(2, 3 * u),
      });
      slot.cmdText.setPosition(x + w - 28 * u - w * 0.55, y + h * 0.54);
      slot.cmdText.setAlpha(isEmpty ? 0.28 : 1);
    }

    showDamage(x, y, damage, type = 'normal') {
      const targetX = clamp(Number(x) || this.W / 2, this.safe.x, this.safe.x + this.safe.width);
      const targetY = clamp(Number(y) || this.safe.y + this.safe.height * 0.45, this.safe.y, this.safe.y + this.safe.height);
      const attacker = this.playerGroups[Math.floor(Math.random() * Math.max(1, this.playerGroups.length))];
      const startX = attacker?.container?.x || this.W / 2;
      const startY = attacker?.container?.y || this.safe.y + this.safe.height * 0.4;
      const color = type === 'kill' ? 0xf6c95b : type === 'critical' ? 0xff315f : this.laserColor;
      const beam = this.add.graphics();
      beam.lineStyle(Math.max(4, 7 * this.scaleUnit), color, 0.88);
      beam.lineBetween(startX, startY, targetX, targetY);
      beam.lineStyle(Math.max(1, 2 * this.scaleUnit), 0xffffff, 0.9);
      beam.lineBetween(startX, startY, targetX, targetY);
      this.effectLayer.add(beam);
      this.tweens.add({
        targets: beam,
        alpha: 0,
        duration: 230,
        ease: 'Cubic.easeOut',
        onComplete: () => beam.destroy(),
      });

      const fontSize = type === 'kill' ? 54 : type === 'critical' ? 62 : 42;
      const text = this.add.text(targetX, targetY, String(damage || 'HIT'), {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(fontSize * this.scaleUnit)}px`,
        color: type === 'kill' ? '#fff0b9' : type === 'critical' ? '#ff4268' : '#ffffff',
        stroke: '#02040a',
        strokeThickness: Math.max(5, 8 * this.scaleUnit),
      }).setOrigin(0.5);
      this.effectLayer.add(text);
      this.tweens.add({
        targets: text,
        y: targetY - 130 * this.scaleUnit,
        scaleX: 1.18,
        scaleY: 1.18,
        alpha: 0,
        duration: 900,
        ease: 'Quad.easeOut',
        onComplete: () => text.destroy(),
      });
    }

    showBanner(text, type = 'event') {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (/entered the arena/i.test(clean)) return;
      this.bannerQueue.push({ text: clean.slice(0, 64), type });
      if (!this.bannerActive) this.playNextBanner();
    }

    eventBannerCenterY(bannerHeight) {
      const u = this.scaleUnit || 1;
      const safeTop = this.safe?.y || 0;
      const safeBottom = safeTop + (this.safe?.height || this.H || 0);
      const visiblePlayers = (this.playerGroups || []).filter(record => record?.container?.visible !== false);
      const playerBottoms = visiblePlayers
        .map(record => (record.targetY || record.container?.y || 0) + (record.cardH || 150 * u) / 2)
        .filter(value => Number.isFinite(value));
      const playerBottom = playerBottoms.length
        ? Math.max(...playerBottoms)
        : safeTop + (this.safe?.height || this.H || 0) * 0.58 + 78 * u;
      const hordeTop = Number.isFinite(this.hordeBounds?.y)
        ? this.hordeBounds.y
        : safeTop + (this.safe?.height || this.H || 0) * 0.88;
      const topLimit = playerBottom + Math.max(12, 20 * u);
      const bottomLimit = hordeTop - Math.max(16, 26 * u);
      const minCenter = Math.max(safeTop + bannerHeight / 2, topLimit + bannerHeight / 2);
      const maxCenter = Math.min(safeBottom - bannerHeight / 2, bottomLimit - bannerHeight / 2);

      if (maxCenter >= minCenter) {
        return clamp(topLimit + (bottomLimit - topLimit - bannerHeight) * 0.76 + bannerHeight / 2, minCenter, maxCenter);
      }

      return clamp(safeTop + (this.safe?.height || this.H || 0) * 0.74, safeTop + bannerHeight / 2, safeBottom - bannerHeight / 2);
    }

    playNextBanner() {
      const next = this.bannerQueue.shift();
      if (!next) {
        this.bannerActive = false;
        return;
      }
      this.bannerActive = true;
      const u = this.scaleUnit;
      const w = Math.min(this.safe.width * 0.5, this.W * 0.46);
      const h = Math.max(48, 58 * u);
      const y = this.eventBannerCenterY(h);
      const accent = next.type === 'gift' ? 0xf6c95b : next.type === 'kill' ? 0xff315f : 0x7afcff;

      const group = this.add.container(this.W / 2, y - 20 * u).setAlpha(0);
      const gfx = this.add.graphics();
      gfx.fillStyle(0x07090f, 0.94);
      gfx.fillRoundedRect(-w / 2, -h / 2, w, h, h * 0.24);
      gfx.fillStyle(accent, 0.08);
      gfx.fillRoundedRect(-w / 2 + 8 * u, -h / 2 + 7 * u, w - 16 * u, h - 14 * u, h * 0.18);
      gfx.lineStyle(Math.max(2, 3 * u), 0x6b737c, 0.78);
      gfx.strokeRoundedRect(-w / 2, -h / 2, w, h, h * 0.24);
      gfx.lineStyle(Math.max(1, 2 * u), accent, 0.62);
      gfx.lineBetween(-w / 2 + 16 * u, h / 2 - 6 * u, w / 2 - 16 * u, h / 2 - 6 * u);

      const label = this.add.text(0, 0, next.text.toUpperCase(), {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.04, 20 * u, 30 * u))}px`,
        color: '#fff8e6',
        align: 'center',
        fixedWidth: Math.round(w - 42 * u),
        stroke: '#030406',
        strokeThickness: Math.max(2, 3 * u),
      }).setOrigin(0.5);
      group.add([gfx, label]);
      this.bannerLayer.add(group);

      this.tweens.add({
        targets: group,
        alpha: 1,
        y,
        duration: 220,
        ease: 'Cubic.easeOut',
      });
      this.time.delayedCall(1500, () => {
        this.tweens.add({
          targets: group,
          alpha: 0,
          y: y - 20 * u,
          duration: 220,
          ease: 'Cubic.easeIn',
          onComplete: () => {
            group.destroy();
            this.playNextBanner();
          },
        });
      });
    }

    flashScreen(duration = 200, color = '#ff0000') {
      const overlay = this.add.rectangle(this.W / 2, this.H / 2, this.W, this.H, hexToNumber(color, 0xff0000), 0.36);
      overlay.setDepth(1000);
      this.tweens.add({
        targets: overlay,
        alpha: 0,
        duration,
        ease: 'Quad.easeOut',
        onComplete: () => overlay.destroy(),
      });
    }

    shakeCam(intensity = 5) {
      this.cameras.main.shake(180, clamp(Number(intensity) || 5, 1, 18) / 1000);
    }

    cleanupPreparedSponsor() {
      if (!this.preparedSponsor) return;
      try {
        this.preparedSponsor.video.pause();
        this.preparedSponsor.video.removeAttribute('src');
        this.preparedSponsor.video.load();
      } catch (_err) {}
      this.preparedSponsor = null;
    }

    prepareSponsorBreak(payload = {}) {
      this.cleanupPreparedSponsor();
      if (!payload.breakId) return;
      if (!payload.videoUrl) {
        this.reportSponsor(payload, 'decoded', 'No video media required');
        this.reportSponsor(payload, 'ready', 'Fallback sponsor scene ready');
        return;
      }

      const video = document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = payload.muted !== false;
      video.volume = this.normalizeMasterVolume(payload.volume, this.masterVolume);
      video.crossOrigin = 'anonymous';
      this.preparedSponsor = { breakId: payload.breakId, payload, video, decoded: false, ready: false };

      let settled = false;
      const markDecoded = () => {
        if (!this.preparedSponsor || this.preparedSponsor.breakId !== payload.breakId || this.preparedSponsor.decoded) return;
        this.preparedSponsor.decoded = true;
        this.reportSponsor(payload, 'decoded', 'Phaser media metadata decoded');
      };
      const markReady = () => {
        if (settled || !this.preparedSponsor || this.preparedSponsor.breakId !== payload.breakId || video.readyState < 2) return;
        settled = true;
        markDecoded();
        this.preparedSponsor.ready = true;
        this.reportSponsor(payload, 'ready', 'Phaser media ready for first frame');
      };
      const markFailed = () => {
        if (settled) return;
        settled = true;
        this.reportSponsor(payload, 'failed', 'Phaser media failed to preload');
      };

      video.onloadedmetadata = markDecoded;
      video.onloadeddata = markReady;
      video.oncanplay = markReady;
      video.oncanplaythrough = markReady;
      video.onerror = markFailed;
      video.onstalled = () => this.reportSponsor(payload, 'decoded', 'Phaser media buffering after metadata');
      video.src = payload.videoUrl;
      try {
        video.load();
        if (video.readyState >= 1) markDecoded();
        if (video.readyState >= 2) markReady();
      } catch (_err) {
        markFailed();
      }

      this.time.delayedCall(9000, () => {
        if (!settled && this.preparedSponsor?.breakId === payload.breakId) markFailed();
      });
    }

    playSponsorBreak(payload = {}) {
      payload = { ...payload, volume: this.normalizeMasterVolume(payload.volume, this.masterVolume) };
      this.activeSponsorPayload = payload;
      this.sponsorFinalized = false;
      this.sponsorEndcapShown = false;
      this.sponsorStartedAt = this.time.now;
      document.body.classList.add('sponsor-active');
      this.sponsorLayer.removeAll(true);
      this.sponsorLayer.setVisible(true).setAlpha(0);
      this.reportSponsor(payload, 'live', 'Phaser power moment is live');
      const plannedDurationMs = clamp(Number(payload.durationMs) || 15000, 1200, 60000);

      const intro = this.add.graphics();
      intro.fillStyle(0x02040a, 0.96);
      intro.fillRect(0, 0, this.W, this.H);
      intro.lineStyle(Math.max(3, 5 * this.scaleUnit), 0xf6c95b, 0.86);
      intro.strokeRoundedRect(42 * this.scaleUnit, 42 * this.scaleUnit, this.W - 84 * this.scaleUnit, this.H - 84 * this.scaleUnit, 28 * this.scaleUnit);
      this.sponsorLayer.add(intro);

      const kicker = this.add.text(this.W / 2, this.H * 0.14, String(payload.kicker || 'Arena Spotlight').toUpperCase(), {
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(28 * this.scaleUnit)}px`,
        color: '#ffd37a',
        align: 'center',
      }).setOrigin(0.5);
      const title = this.add.text(this.W / 2, this.H * 0.22, String(payload.title || 'Power Moment'), {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(72 * this.scaleUnit)}px`,
        color: '#fff8e6',
        align: 'center',
        fixedWidth: Math.round(this.W * 0.82),
        stroke: '#02040a',
        strokeThickness: Math.max(6, 9 * this.scaleUnit),
      }).setOrigin(0.5);
      this.sponsorLayer.add([kicker, title]);

      const videoBox = {
        x: this.W * 0.5,
        y: this.H * 0.54,
        w: this.W * 0.78,
        h: this.H * 0.48,
      };
      const plate = this.add.graphics();
      plate.fillStyle(0x070914, 0.9);
      plate.fillRoundedRect(videoBox.x - videoBox.w / 2, videoBox.y - videoBox.h / 2, videoBox.w, videoBox.h, 24 * this.scaleUnit);
      plate.lineStyle(Math.max(2, 4 * this.scaleUnit), 0x7afcff, 0.34);
      plate.strokeRoundedRect(videoBox.x - videoBox.w / 2, videoBox.y - videoBox.h / 2, videoBox.w, videoBox.h, 24 * this.scaleUnit);
      this.sponsorLayer.add(plate);

      if (payload.videoUrl && this.add.video) {
        try {
          this.sponsorVideo = this.add.video(videoBox.x, videoBox.y);
          this.sponsorLayer.add(this.sponsorVideo);
          this.sponsorVideo.setDisplaySize(videoBox.w, videoBox.h);
          this.sponsorVideo.setMute(payload.muted !== false);
          this.applySponsorVideoVolume(this.sponsorVideo, payload);
          this.sponsorVideo.loadURL(payload.videoUrl, payload.muted !== false);
          let firstFrameReported = false;
          const reportFirstFrame = (message = 'Phaser video first frame confirmed') => {
            if (firstFrameReported) return;
            firstFrameReported = true;
            this.reportSponsor(payload, 'playing', 'Phaser media playback started');
            this.reportSponsor(payload, 'first_frame', message);
          };
          this.sponsorVideo.once('play', () => {
            this.applySponsorVideoVolume(this.sponsorVideo, payload);
            this.showSponsorEndCap(payload, this.sponsorEndcapDelayMs(payload, plannedDurationMs));
            const videoEl = this.sponsorVideo?.video;
            if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
              videoEl.requestVideoFrameCallback(() => reportFirstFrame('Phaser video frame callback confirmed'));
            } else {
              this.time.delayedCall(220, () => reportFirstFrame('Phaser video ready-state fallback confirmed'));
            }
          });
          this.sponsorVideo.once('complete', () => {
            this.reportSponsor(payload, 'video_completed', 'Phaser sponsor video finished');
            const elapsed = Math.max(0, this.time.now - this.sponsorStartedAt);
            this.showSponsorEndCap(payload, Math.max(140, this.sponsorEndcapDelayMs(payload, plannedDurationMs) - elapsed));
          });
          this.sponsorVideo.once('error', () => {
            this.reportSponsor(payload, 'failed', 'Phaser video failed during playback');
            this.showSponsorFallback(videoBox, payload);
          });
          this.sponsorVideo.play(false);
          this.time.delayedCall(1400, () => {
            if (!firstFrameReported) reportFirstFrame('Phaser video start fallback confirmed');
          });
        } catch (_err) {
          this.reportSponsor(payload, 'failed', 'Phaser video could not start');
          this.showSponsorFallback(videoBox, payload);
        }
      } else {
        this.reportSponsor(payload, 'fallback_started', 'Phaser sponsor break started without video media');
        this.showSponsorFallback(videoBox, payload);
      }

      const subtitle = this.add.text(this.W / 2, this.H * 0.86, String(payload.subtitle || 'Stay locked in. The next fight is loading.'), {
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(34 * this.scaleUnit)}px`,
        color: '#d8e6ff',
        align: 'center',
        fixedWidth: Math.round(this.W * 0.78),
      }).setOrigin(0.5);
      this.sponsorLayer.add(subtitle);

      this.tweens.add({
        targets: this.sponsorLayer,
        alpha: 1,
        duration: 420,
        ease: 'Cubic.easeOut',
      });

      if (this.sponsorTimer) this.sponsorTimer.remove(false);
      if (this.sponsorWallClockTimer) window.clearTimeout(this.sponsorWallClockTimer);
      this.sponsorTimer = this.time.delayedCall(plannedDurationMs, () => this.stopSponsorBreak('completed'));
      this.sponsorWallClockTimer = window.setTimeout(() => this.stopSponsorBreak('completed'), plannedDurationMs + 500);
      if (!payload.videoUrl) this.showSponsorEndCap(payload, this.sponsorEndcapDelayMs(payload, plannedDurationMs));
    }

    showSponsorFallback(videoBox, payload) {
      const partner = this.add.text(videoBox.x, videoBox.y - 18 * this.scaleUnit, String(payload.partner || 'IntoTheBattle Partner'), {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(56 * this.scaleUnit)}px`,
        color: '#fff0b9',
        align: 'center',
        fixedWidth: Math.round(videoBox.w * 0.82),
        stroke: '#02040a',
        strokeThickness: Math.max(5, 8 * this.scaleUnit),
      }).setOrigin(0.5);
      const line = this.add.text(videoBox.x, videoBox.y + 62 * this.scaleUnit, 'Battle returns after this moment', {
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(30 * this.scaleUnit)}px`,
        color: '#99ffda',
        align: 'center',
      }).setOrigin(0.5);
      this.sponsorLayer.add([partner, line]);
    }

    showSponsorEndCap(payload, delay) {
      if ((payload.statsMode || 'endcap') === 'hidden') return;
      const safeDelay = clamp(Number(delay) || 0, 0, 12000);
      if (this.sponsorEndcapTimer) this.sponsorEndcapTimer.remove(false);
      if (this.sponsorEndcapWallClockTimer) window.clearTimeout(this.sponsorEndcapWallClockTimer);
      const renderEndcap = () => {
        this.sponsorEndcapTimer = null;
        if (this.sponsorEndcapWallClockTimer) {
          window.clearTimeout(this.sponsorEndcapWallClockTimer);
          this.sponsorEndcapWallClockTimer = null;
        }
        if (!this.sponsorLayer.visible || this.activeSponsorPayload !== payload || this.sponsorEndcapShown) return;
        this.sponsorEndcapShown = true;
        const previousBreakItems = this.sponsorLayer.list.slice();
        this.tweens.add({
          targets: previousBreakItems,
          alpha: 0.2,
          duration: 420,
          ease: 'Cubic.easeOut',
        });
        if ((payload.statsMode || 'endcap') === 'endcap') {
          try {
            if (this.sponsorVideo?.isPlaying) this.sponsorVideo.pause();
          } catch (_err) {}
          if (this.sponsorVideo) {
            this.tweens.add({
              targets: this.sponsorVideo,
              alpha: 0.28,
              duration: 420,
              ease: 'Cubic.easeOut',
            });
          }
        }
        const alive = this.playerGroups.filter(player => Number(player.data.health || 0) > 0).length;
        const kills = this.playerGroups.reduce((sum, player) => sum + Number(player.data.kills || 0), 0);
        const leader = this.playerGroups
          .slice()
          .sort((a, b) => (Number(b.data.kills || 0) - Number(a.data.kills || 0)) || (Number(b.data.health || 0) - Number(a.data.health || 0)))[0];
        const leaderName = leader ? String(leader.data.name || leader.playerId || 'Leader').slice(0, 12).toUpperCase() : 'WAITING';
        const reserve = Math.max(0, this.playerGroups.length - 5);
        const cap = this.add.container(this.W / 2, this.H + 260 * this.scaleUnit);
        const w = this.W * 0.78;
        const h = this.H * 0.28;
        const gfx = this.add.graphics();
        gfx.fillStyle(0x02040a, 0.91);
        gfx.fillRoundedRect(-w / 2, -h / 2, w, h, 22 * this.scaleUnit);
        gfx.lineStyle(Math.max(2, 4 * this.scaleUnit), 0xf6c95b, 0.82);
        gfx.strokeRoundedRect(-w / 2, -h / 2, w, h, 22 * this.scaleUnit);
        const glow = this.add.graphics();
        glow.lineStyle(Math.max(1, 2 * this.scaleUnit), 0x7afcff, 0.28);
        glow.strokeRoundedRect(-w / 2 + 14 * this.scaleUnit, -h / 2 + 14 * this.scaleUnit, w - 28 * this.scaleUnit, h - 28 * this.scaleUnit, 16 * this.scaleUnit);
        const label = this.add.text(0, -h * 0.33, 'BATTLE SNAPSHOT', {
          fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
          fontSize: `${Math.round(30 * this.scaleUnit)}px`,
          color: '#ffd37a',
          align: 'center',
        }).setOrigin(0.5);
        const statItems = [
          ['PLAYERS', String(this.playerGroups.length || alive || 0)],
          ['KOs', String(kills || 0)],
          ['PRESSURE', reserve > 0 ? `${reserve} RSV` : 'CLEAR'],
          ['LEADER', leaderName],
        ].map((item, index) => {
          const group = this.add.container((index - 1.5) * w * 0.215, h * 0.02);
          const plate = this.add.graphics();
          plate.fillStyle(index === 1 ? 0x111b2a : 0x10131d, 0.78);
          plate.fillRoundedRect(-w * 0.092, -h * 0.19, w * 0.184, h * 0.34, 14 * this.scaleUnit);
          plate.lineStyle(Math.max(1, 2 * this.scaleUnit), index === 1 ? 0xf6c95b : 0x7afcff, 0.36);
          plate.strokeRoundedRect(-w * 0.092, -h * 0.19, w * 0.184, h * 0.34, 14 * this.scaleUnit);
          const value = this.add.text(0, -h * 0.035, item[1], {
            fontFamily: 'Arial Black, Impact, sans-serif',
            fontSize: `${Math.round((index === 3 ? 34 : 54) * this.scaleUnit)}px`,
            color: '#fff8e6',
            align: 'center',
            fixedWidth: Math.round(w * 0.165),
            stroke: '#02040a',
            strokeThickness: Math.max(4, 6 * this.scaleUnit),
          }).setOrigin(0.5);
          const textLabel = this.add.text(0, h * 0.115, item[0], {
            fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
            fontSize: `${Math.round(22 * this.scaleUnit)}px`,
            color: '#99ffda',
            align: 'center',
          }).setOrigin(0.5);
          group.add([plate, value, textLabel]);
          return group;
        });
        const returnText = this.add.text(0, h * 0.39, payload.returnText || 'Back to battle', {
          fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
          fontSize: `${Math.round(28 * this.scaleUnit)}px`,
          color: '#99ffda',
          align: 'center',
        }).setOrigin(0.5);
        cap.add([gfx, glow, label, ...statItems, returnText]);
        this.sponsorLayer.add(cap);
        this.tweens.add({
          targets: cap,
          y: this.H * 0.5,
          duration: 620,
          ease: 'Back.easeOut',
        });
        this.tweens.add({
          targets: glow,
          alpha: { from: 0.42, to: 0.92 },
          duration: 1200,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      };
      this.sponsorEndcapTimer = this.time.delayedCall(safeDelay, renderEndcap);
      this.sponsorEndcapWallClockTimer = window.setTimeout(renderEndcap, safeDelay + 75);
    }

    stopSponsorBreak(status = 'completed') {
      if (this.sponsorTimer) {
        this.sponsorTimer.remove(false);
        this.sponsorTimer = null;
      }
      if (this.sponsorWallClockTimer) {
        window.clearTimeout(this.sponsorWallClockTimer);
        this.sponsorWallClockTimer = null;
      }
      if (this.sponsorEndcapTimer) {
        this.sponsorEndcapTimer.remove(false);
        this.sponsorEndcapTimer = null;
      }
      if (this.sponsorEndcapWallClockTimer) {
        window.clearTimeout(this.sponsorEndcapWallClockTimer);
        this.sponsorEndcapWallClockTimer = null;
      }
      this.sponsorEndcapShown = false;
      this.sponsorStartedAt = 0;
      try {
        if (this.sponsorVideo?.isPlaying) this.sponsorVideo.stop();
      } catch (_err) {}
      if (!this.sponsorFinalized && this.activeSponsorPayload?.breakId) {
        this.sponsorFinalized = true;
        this.reportSponsor(this.activeSponsorPayload, status === 'stopped' ? 'stopped' : 'completed', status === 'stopped' ? 'Phaser break stopped' : 'Phaser break completed');
      }
      this.tweens.add({
        targets: this.sponsorLayer,
        alpha: 0,
        duration: 360,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          this.sponsorLayer.removeAll(true);
          this.sponsorLayer.setVisible(false);
          document.body.classList.remove('sponsor-active');
          this.cleanupPreparedSponsor();
          this.activeSponsorPayload = null;
          this.showBanner('Battle resumed', 'return');
        },
      });
    }

    startDemo() {
      this.demoModeActive = true;
      const players = [
        { id: 'demo-1', name: 'NOVAX', health: 100, kills: 3, iconType: 'bolt' },
        { id: 'demo-2', name: 'WEST', health: 86, kills: 2, iconType: 'swords' },
        { id: 'demo-3', name: 'MIRA', health: 73, kills: 1, iconType: 'star' },
        { id: 'demo-4', name: 'BLAZE', health: 31, kills: 4, teamColor: '#ff45a0', iconType: 'fire' },
        { id: 'demo-5', name: 'ASHLEE', health: 94, kills: 2, iconType: 'core' },
      ];
      this.time.delayedCall(350, () => {
        players.forEach((player, index) => this.time.delayedCall(index * 90, () => this.addPlayerCard(player)));
      });
      this.time.delayedCall(500, () => {
        this.updateChatDisplay('walstorm', '100-LIKE SURGE', 0x7afcff);
        this.updateChatDisplay('nova_fan', 'FIRE ICON', 0xff6a3d);
        this.updateChatDisplay('mira_live', 'LASER ON BLAZE', 0xff45a0);
      });
      this.time.delayedCall(3600, () => this.updateChatDisplay('arena_watch', 'RAIL STRIKE', 0x55e7ff));
      this.time.delayedCall(4800, () => this.updateChatDisplay('gift_king', 'GIFT BOOST', 0xf6c95b));
      this.demoAttackStartAt = this.time.now + 5200;
      this.lastDemoEvent = this.time.now + 1800;
    }

    demoTick() {
      if (!this.playerGroups.length) return;
      if (this.time.now < this.demoAttackStartAt) return;
      const player = this.playerGroups[Math.floor(Math.random() * this.playerGroups.length)];
      const health = clamp(Number(player.data.health || 100) - Math.round(4 + Math.random() * 12), 18, 100);
      const kills = Number(player.data.kills || 0) + (Math.random() > 0.72 ? 1 : 0);
      this.updatePlayerStats(player.playerId, { health, kills });
      const demoViewers = ['chat_user', 'lightning_fan', 'arena_watcher', 'firestorm99', 'shadow_x'];
      const demoCmds = ['LASER STRIKE', 'FIRE BLAST', 'ICE SHARD', 'THUNDER BOLT', 'SHADOW SLASH', 'MEGA ATTACK'];
      const demoColors = [0x7afcff, 0xff45a0, 0xff6a3d, 0xf6c95b, 0x99ffda];
      const viewer = demoViewers[Math.floor(Math.random() * demoViewers.length)];
      const cmd = demoCmds[Math.floor(Math.random() * demoCmds.length)];
      const col = demoColors[Math.floor(Math.random() * demoColors.length)];
      this.updateChatDisplay(viewer, cmd, col);
      this.showDamage(this.W / 2 + (Math.random() - 0.5) * this.safe.width * 0.34, this.safe.y + this.safe.height * 0.63, Math.random() > 0.78 ? 'CRIT' : Math.round(14 + Math.random() * 48), Math.random() > 0.78 ? 'critical' : 'normal');
    }
  }

  function boot() {
    if (!window.Phaser) {
      setStatus('Phaser missing', 'disconnected');
      return;
    }

    const config = {
      type: Phaser.WEBGL,
      parent: 'phaser-overlay-root',
      width: stage.width,
      height: stage.height,
      backgroundColor: '#02040a',
      transparent: false,
      render: {
        antialias: true,
        pixelArt: false,
        roundPixels: false,
        powerPreference: 'high-performance',
      },
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: BattleOverlayV2Scene,
      callbacks: {
        postBoot(game) {
          game.canvas.setAttribute('data-renderer', 'phaser-v4');
          game.canvas.setAttribute('data-stage', `${stage.width}x${stage.height}`);
          game.canvas.style.imageRendering = 'auto';
          if (typeof window.initSocketOverlay === 'function') {
            window.initSocketOverlay(game);
          }
        },
      },
    };

    window.overlayV2Game = new Phaser.Game(config);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
