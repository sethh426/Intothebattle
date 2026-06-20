(function () {
  const params = new URLSearchParams(window.location.search);
  const requestedLayout = (params.get('layout') || 'horizontal').toLowerCase();
  const requestedRender = (params.get('render') || '1080p').toLowerCase();
  const demoMode = params.get('demo') === '1' || params.get('preview') === '1' || window.location.pathname.includes('preview');
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

  function escapeName(value) {
    return String(value || 'Player').trim().slice(0, 18) || 'Player';
  }

  class BattleOverlayV2Scene extends Phaser.Scene {
    constructor() {
      super({ key: 'BattleOverlayV2Scene' });
      this.playerGroups = [];
      this.playerMap = new Map();
      this.laserColor = 0x7afcff;
      this.layoutConfig = { shotSpeed: 1 };
      this.withOverlayAuth = null;
      this.customBackground = null;
      this.customBackgroundKey = null;
      this.lastDemoEvent = 0;
      this.demoAttackStartAt = 0;
      this.sponsorVideo = null;
      this.sponsorTimer = null;
      this.bannerQueue = [];
      this.bannerActive = false;
    }

    create() {
      this.W = Number(this.sys.game.config.width);
      this.H = Number(this.sys.game.config.height);
      this.scaleUnit = this.W / 1920;
      this.safe = this.getSafeRect();

      this.backgroundLayer = this.add.container(0, 0).setDepth(0);
      this.frameLayer = this.add.container(0, 0).setDepth(10);
      this.worldLayer = this.add.container(0, 0).setDepth(20);
      this.playerLayer = this.add.container(0, 0).setDepth(30);
      this.effectLayer = this.add.container(0, 0).setDepth(45);
      this.bannerLayer = this.add.container(0, 0).setDepth(60);
      this.sponsorLayer = this.add.container(0, 0).setDepth(500).setVisible(false).setAlpha(0);

      this.drawBackground();
      this.drawFrame();
      this.linkGraphics = this.add.graphics();
      this.worldLayer.add(this.linkGraphics);
      this.createHorde();
      this.createAmbientMotion();

      if (demoMode) this.startDemo();
      window.overlayV2Scene = this;
      window.__overlayV2Ready = true;
      setStatus('Ready', 'connected');
    }

    getSafeRect() {
      const marginX = Math.max(70, this.W * 0.055);
      const marginTop = Math.max(56, this.H * 0.07);
      const marginBottom = Math.max(64, this.H * 0.075);
      return {
        x: marginX,
        y: marginTop,
        width: this.W - marginX * 2,
        height: this.H - marginTop - marginBottom,
      };
    }

    drawBackground() {
      this.backgroundLayer.removeAll(true);
      const g = this.add.graphics();
      g.fillStyle(0x02040a, 1);
      g.fillRect(0, 0, this.W, this.H);
      g.fillStyle(0x050914, 0.72);
      g.fillRoundedRect(this.safe.x - 18 * this.scaleUnit, this.safe.y - 18 * this.scaleUnit, this.safe.width + 36 * this.scaleUnit, this.safe.height + 36 * this.scaleUnit, 18 * this.scaleUnit);

      for (let i = 0; i < 7; i += 1) {
        const alpha = 0.045 - i * 0.004;
        g.lineStyle(Math.max(1, 2 * this.scaleUnit), i % 2 ? 0xf6c95b : 0x7afcff, alpha);
        const y = this.safe.y + i * (this.safe.height / 6);
        g.lineBetween(this.safe.x, y, this.safe.x + this.safe.width, y);
      }

      const grid = Math.max(60, 86 * this.scaleUnit);
      g.lineStyle(Math.max(1, 1.5 * this.scaleUnit), 0x7afcff, 0.055);
      for (let x = this.safe.x; x <= this.safe.x + this.safe.width; x += grid) {
        g.lineBetween(x, this.safe.y, x, this.safe.y + this.safe.height);
      }
      for (let y = this.safe.y; y <= this.safe.y + this.safe.height; y += grid) {
        g.lineBetween(this.safe.x, y, this.safe.x + this.safe.width, y);
      }

      g.fillStyle(0xf6c95b, 0.046);
      g.fillEllipse(this.safe.x + this.safe.width * 0.18, this.safe.y + this.safe.height * 0.28, this.W * 0.32, this.H * 0.42);
      g.fillStyle(0xe83b5f, 0.048);
      g.fillEllipse(this.safe.x + this.safe.width * 0.78, this.safe.y + this.safe.height * 0.68, this.W * 0.42, this.H * 0.48);
      g.fillStyle(0x7afcff, 0.035);
      g.fillEllipse(this.safe.x + this.safe.width * 0.52, this.safe.y + this.safe.height * 0.42, this.W * 0.3, this.H * 0.2);
      g.fillStyle(0xffffff, 0.045);
      g.fillRoundedRect(this.safe.x + this.safe.width * 0.08, this.safe.y + this.safe.height * 0.36, this.safe.width * 0.84, 3 * this.scaleUnit, 2 * this.scaleUnit);

      const coreX = this.W / 2;
      const coreY = this.safe.y + this.safe.height * 0.57;
      const radius = 118 * this.scaleUnit;
      g.lineStyle(Math.max(1, 2 * this.scaleUnit), 0xf6c95b, 0.13);
      g.strokeCircle(coreX, coreY, radius);
      g.lineStyle(Math.max(1, 1.5 * this.scaleUnit), 0x7afcff, 0.1);
      g.strokeCircle(coreX, coreY, radius * 0.62);
      g.lineStyle(Math.max(1, 2 * this.scaleUnit), 0xff6a3d, 0.1);
      g.lineBetween(coreX - radius * 1.18, coreY, coreX + radius * 1.18, coreY);
      g.lineBetween(coreX, coreY - radius * 0.62, coreX, coreY + radius * 0.62);

      this.backgroundLayer.add(g);
    }

    drawFrame() {
      this.frameLayer.removeAll(true);
      const outer = this.add.graphics();
      const line = Math.max(2, 3 * this.scaleUnit);
      outer.lineStyle(line, 0xf6c95b, 0.86);
      outer.strokeRoundedRect(18 * this.scaleUnit, 18 * this.scaleUnit, this.W - 36 * this.scaleUnit, this.H - 36 * this.scaleUnit, 26 * this.scaleUnit);
      outer.lineStyle(Math.max(1, line * 0.45), 0xffffff, 0.14);
      outer.strokeRoundedRect(this.safe.x - 22 * this.scaleUnit, this.safe.y - 22 * this.scaleUnit, this.safe.width + 44 * this.scaleUnit, this.safe.height + 44 * this.scaleUnit, 16 * this.scaleUnit);

      const headerW = Math.min(this.W * 0.42, 640 * this.scaleUnit);
      const headerH = Math.max(42, 48 * this.scaleUnit);
      const headerX = this.W / 2 - headerW / 2;
      const headerY = this.safe.y + 18 * this.scaleUnit;
      const header = this.add.graphics();
      header.fillStyle(0x030711, 0.82);
      header.fillRoundedRect(headerX, headerY, headerW, headerH, headerH / 2);
      header.lineStyle(Math.max(1, 2 * this.scaleUnit), 0xf6c95b, 0.5);
      header.strokeRoundedRect(headerX, headerY, headerW, headerH, headerH / 2);
      header.fillStyle(0x7afcff, 0.12);
      header.fillRoundedRect(headerX + 8 * this.scaleUnit, headerY + 8 * this.scaleUnit, headerW - 16 * this.scaleUnit, headerH - 16 * this.scaleUnit, (headerH - 16 * this.scaleUnit) / 2);
      const headerText = this.add.text(this.W / 2, headerY + headerH / 2, 'ARENA LIVE', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(24 * this.scaleUnit)}px`,
        color: '#fff8e6',
        align: 'center',
        letterSpacing: 1,
      }).setOrigin(0.5);
      const leftTick = this.add.rectangle(headerX - 22 * this.scaleUnit, headerY + headerH / 2, 44 * this.scaleUnit, 4 * this.scaleUnit, 0xff6a3d, 0.95);
      const rightTick = this.add.rectangle(headerX + headerW + 22 * this.scaleUnit, headerY + headerH / 2, 44 * this.scaleUnit, 4 * this.scaleUnit, 0xff6a3d, 0.95);

      const corners = this.add.graphics();
      corners.lineStyle(Math.max(4, 6 * this.scaleUnit), 0xff6a3d, 0.95);
      const c = 82 * this.scaleUnit;
      const ox = 34 * this.scaleUnit;
      const oy = 34 * this.scaleUnit;
      corners.lineBetween(ox, oy + c, ox, oy);
      corners.lineBetween(ox, oy, ox + c, oy);
      corners.lineBetween(this.W - ox - c, oy, this.W - ox, oy);
      corners.lineBetween(this.W - ox, oy, this.W - ox, oy + c);
      corners.lineBetween(ox, this.H - oy - c, ox, this.H - oy);
      corners.lineBetween(ox, this.H - oy, ox + c, this.H - oy);
      corners.lineBetween(this.W - ox - c, this.H - oy, this.W - ox, this.H - oy);
      corners.lineBetween(this.W - ox, this.H - oy, this.W - ox, this.H - oy - c);

      this.scanLine = this.add.rectangle(this.W / 2, this.safe.y, this.safe.width, Math.max(2, 4 * this.scaleUnit), 0x7afcff, 0.16);
      this.frameLayer.add([outer, header, headerText, leftTick, rightTick, corners, this.scanLine]);
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

    createHorde() {
      this.hordeLayer = this.add.container(0, 0);
      this.worldLayer.add(this.hordeLayer);
      this.hordeGraphics = this.add.graphics();
      this.hordeTitle = this.add.text(0, 0, 'HORDE', {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(30 * this.scaleUnit)}px`,
        color: '#fff0b9',
        align: 'center',
      }).setOrigin(0.5);
      this.hordeMeta = this.add.text(0, 0, 'Awaiting challengers', {
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(26 * this.scaleUnit)}px`,
        color: '#ffd37a',
        align: 'center',
      }).setOrigin(0.5);
      this.hordeLayer.add([this.hordeGraphics, this.hordeTitle, this.hordeMeta]);
      this.drawHorde();
    }

    drawHorde() {
      if (!this.hordeGraphics) return;
      const h = Math.max(74, this.H * 0.088);
      const w = Math.min(this.safe.width * 0.74, this.W * 0.76);
      const x = (this.W - w) / 2;
      const y = this.safe.y + this.safe.height * 0.68;
      const reserve = Math.max(0, this.playerGroups.length - 5);
      const alive = this.playerGroups.filter(player => Number(player.data.health || 0) > 0).length;
      const pulse = 0.66 + Math.sin(this.time.now * 0.004) * 0.1;

      this.hordeGraphics.clear();
      this.hordeGraphics.fillStyle(0x150406, 0.92);
      this.hordeGraphics.fillRoundedRect(x, y, w, h, h * 0.22);
      this.hordeGraphics.lineStyle(Math.max(2, 4 * this.scaleUnit), 0xe83b5f, 0.78);
      this.hordeGraphics.strokeRoundedRect(x, y, w, h, h * 0.22);
      this.hordeGraphics.fillStyle(0xe83b5f, 0.18 * pulse);
      this.hordeGraphics.fillRoundedRect(x + 12 * this.scaleUnit, y + 12 * this.scaleUnit, w - 24 * this.scaleUnit, h - 24 * this.scaleUnit, h * 0.16);

      for (let i = 0; i < 12; i += 1) {
        const stripeX = x + (i / 12) * w + ((this.time.now * 0.04) % (w / 12));
        this.hordeGraphics.fillStyle(i % 2 ? 0xff6a3d : 0xf6c95b, 0.07);
        this.hordeGraphics.fillRect(stripeX, y + 8 * this.scaleUnit, Math.max(6, 10 * this.scaleUnit), h - 16 * this.scaleUnit);
      }

      this.hordeTitle.setPosition(x + w * 0.18, y + h / 2);
      this.hordeMeta.setPosition(x + w * 0.58, y + h / 2);
      this.hordeMeta.setText(reserve > 0 ? `${reserve} RESERVE | ${alive} ACTIVE` : `${alive || 0} ACTIVE FIGHTERS`);
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
      if (demoMode && this.time.now - this.lastDemoEvent > 1650) {
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

    updateLayoutConfig(key, value) {
      this.layoutConfig[key] = value;
    }

    setBackgroundImageUrl(url) {
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
        const image = this.add.image(this.W / 2, this.H / 2, key).setDepth(1);
        const scale = Math.max(this.W / image.width, this.H / image.height);
        image.setScale(scale);
        image.setAlpha(0.72);
        this.customBackground = image;
        this.backgroundLayer.add(image);
      });
      this.load.start();
    }

    normalizePlayer(player) {
      const id = String(player.id || player.userId || player.uniqueId || `player-${Date.now()}-${Math.random()}`);
      return {
        id,
        name: escapeName(player.name || player.nickname || player.uniqueId || id),
        health: clamp(Number(player.health ?? player.hp ?? 100), 0, 100),
        kills: Number(player.kills || 0),
        deaths: Number(player.deaths || 0),
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

      const record = { playerId: data.id, data, container, gfx, avatar, nameText, killsText, hpText, rankText, targetY: 0 };
      this.playerGroups.push(record);
      this.playerMap.set(data.id, record);
      this.layoutPlayers(true);
      this.showBanner(`${data.name} entered the arena`, 'join');
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
      const maxCardW = Math.min(284 * this.scaleUnit, this.safe.width / 5.5);
      const minGap = Math.max(56 * this.scaleUnit, this.W * 0.028);
      const cardW = Math.min(maxCardW, (this.safe.width - minGap * (count - 1)) / count);
      const cardH = Math.max(132 * this.scaleUnit, cardW * 0.56);
      const totalW = cardW * count + minGap * (count - 1);
      const startX = (this.W - totalW) / 2 + cardW / 2;
      const y = this.safe.y + this.safe.height * 0.42;

      visible.forEach((record, index) => {
        this.tweens.killTweensOf(record.container);
        this.tweens.killTweensOf(record);
        record.cardW = cardW;
        record.cardH = cardH;
        record.rank = index + 1;
        record.targetX = startX + index * (cardW + minGap);
        record.targetY = y;
        record.floatOffset = record.floatOffset || 0;
        record.container.setDepth(40 + index);
        this.redrawPlayer(record);
        record.container.setPosition(record.targetX, record.targetY + (record.floatOffset || 0));
        if (animate && !record.hasEntered) {
          record.floatOffset = 30 * this.scaleUnit;
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
      window.__overlayV2Layout = visible.map(record => ({
        id: record.playerId,
        x: record.targetX,
        y: record.targetY,
        width: record.cardW,
        height: record.cardH,
        left: record.targetX - record.cardW / 2,
        right: record.targetX + record.cardW / 2,
      }));
    }

    redrawPlayer(record) {
      const w = record.cardW || 280 * this.scaleUnit;
      const h = record.cardH || 156 * this.scaleUnit;
      const health = clamp(Number(record.data.health || 0), 0, 100);
      const r = Math.max(12, 18 * this.scaleUnit);
      const hpW = w - 40 * this.scaleUnit;
      const hpH = Math.max(9, 13 * this.scaleUnit);
      const top = -h / 2;
      const left = -w / 2;
      const healthColor = health > 66 ? 0x99ffda : health > 34 ? 0xf6c95b : 0xff5566;

      record.gfx.clear();
      record.gfx.fillStyle(0x000000, 0.32);
      record.gfx.fillRoundedRect(left + 7 * this.scaleUnit, top + 9 * this.scaleUnit, w, h, r);
      record.gfx.fillStyle(0x050811, 0.92);
      record.gfx.fillRoundedRect(left, top, w, h, r);
      record.gfx.fillStyle(healthColor, 0.08);
      record.gfx.fillRoundedRect(left + 7 * this.scaleUnit, top + 7 * this.scaleUnit, w - 14 * this.scaleUnit, h - 14 * this.scaleUnit, r * 0.72);
      record.gfx.fillStyle(0xffffff, 0.06);
      record.gfx.fillRoundedRect(left + 12 * this.scaleUnit, top + 12 * this.scaleUnit, w - 24 * this.scaleUnit, h * 0.38, r * 0.52);
      record.gfx.lineStyle(Math.max(2, 3 * this.scaleUnit), healthColor, 0.86);
      record.gfx.strokeRoundedRect(left, top, w, h, r);
      record.gfx.lineStyle(Math.max(1, 1.5 * this.scaleUnit), 0xffffff, 0.18);
      record.gfx.strokeRoundedRect(left + 6 * this.scaleUnit, top + 6 * this.scaleUnit, w - 12 * this.scaleUnit, h - 12 * this.scaleUnit, r * 0.64);
      record.gfx.fillStyle(healthColor, 0.88);
      record.gfx.fillRoundedRect(left + 18 * this.scaleUnit, top + 12 * this.scaleUnit, w - 36 * this.scaleUnit, 4 * this.scaleUnit, 2 * this.scaleUnit);
      record.gfx.fillStyle(healthColor, 0.92);
      record.gfx.fillRoundedRect(left + 12 * this.scaleUnit, top + 22 * this.scaleUnit, 46 * this.scaleUnit, 26 * this.scaleUnit, 13 * this.scaleUnit);
      record.gfx.fillStyle(0x02040a, 0.2);
      record.gfx.fillRoundedRect(left + 16 * this.scaleUnit, top + 26 * this.scaleUnit, 38 * this.scaleUnit, 18 * this.scaleUnit, 9 * this.scaleUnit);
      record.gfx.fillStyle(0x111827, 0.96);
      record.gfx.fillRoundedRect(left + 20 * this.scaleUnit, top + h - 34 * this.scaleUnit, hpW, hpH, hpH / 2);
      record.gfx.fillStyle(healthColor, 0.95);
      record.gfx.fillRoundedRect(left + 20 * this.scaleUnit, top + h - 34 * this.scaleUnit, hpW * (health / 100), hpH, hpH / 2);

      record.avatar.clear();
      record.avatar.fillStyle(healthColor, 0.18);
      record.avatar.fillCircle(0, top + 40 * this.scaleUnit, 30 * this.scaleUnit);
      record.avatar.lineStyle(Math.max(2, 3 * this.scaleUnit), healthColor, 0.75);
      record.avatar.strokeCircle(0, top + 40 * this.scaleUnit, 30 * this.scaleUnit);
      record.avatar.fillStyle(0xffffff, 0.86);
      record.avatar.fillCircle(0, top + 34 * this.scaleUnit, 9 * this.scaleUnit);
      record.avatar.fillRoundedRect(-14 * this.scaleUnit, top + 47 * this.scaleUnit, 28 * this.scaleUnit, 14 * this.scaleUnit, 7 * this.scaleUnit);

      record.nameText.setText(record.data.name);
      record.nameText.setStyle({
        fontFamily: 'Arial Black, Inter, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.078, 17 * this.scaleUnit, 25 * this.scaleUnit))}px`,
        color: '#ffffff',
        fixedWidth: Math.round(w - 22 * this.scaleUnit),
        align: 'center',
      });
      record.nameText.setPosition(0, top + 82 * this.scaleUnit);

      record.killsText.setText(`${record.data.kills || 0} KOs`);
      record.killsText.setStyle({
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.064, 15 * this.scaleUnit, 21 * this.scaleUnit))}px`,
        color: '#fff0b9',
        fixedWidth: Math.round(w - 24 * this.scaleUnit),
        align: 'center',
      });
      record.killsText.setPosition(0, top + 112 * this.scaleUnit);

      record.hpText.setText(`${Math.round(health)}%`);
      record.hpText.setStyle({
        fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.054, 13 * this.scaleUnit, 18 * this.scaleUnit))}px`,
        color: health > 34 ? '#99ffda' : '#ff8a9b',
      });
      record.hpText.setPosition(left + w - 20 * this.scaleUnit, top + h - 46 * this.scaleUnit);

      record.rankText.setText(`#${record.rank || 1}`);
      record.rankText.setStyle({
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.054, 14 * this.scaleUnit, 18 * this.scaleUnit))}px`,
        color: '#031017',
        align: 'center',
      });
      record.rankText.setPosition(left + 35 * this.scaleUnit, top + 35 * this.scaleUnit);
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
      this.bannerQueue.push({ text: clean.slice(0, 70), type });
      if (!this.bannerActive) this.playNextBanner();
    }

    playNextBanner() {
      const next = this.bannerQueue.shift();
      if (!next) {
        this.bannerActive = false;
        return;
      }
      this.bannerActive = true;
      const w = Math.min(this.safe.width * 0.72, this.W * 0.76);
      const h = Math.max(72, this.H * 0.078);
      const x = (this.W - w) / 2;
      const y = this.safe.y + this.safe.height * 0.57;
      const accent = next.type === 'gift' ? 0xf6c95b : next.type === 'kill' ? 0xff315f : 0x7afcff;

      const group = this.add.container(this.W / 2, y - 36 * this.scaleUnit).setAlpha(0);
      const gfx = this.add.graphics();
      gfx.fillStyle(0x05070e, 0.95);
      gfx.fillRoundedRect(-w / 2, -h / 2, w, h, 18 * this.scaleUnit);
      gfx.lineStyle(Math.max(2, 4 * this.scaleUnit), accent, 0.82);
      gfx.strokeRoundedRect(-w / 2, -h / 2, w, h, 18 * this.scaleUnit);
      gfx.fillStyle(accent, 0.16);
      gfx.fillRect(-w / 2 + 12 * this.scaleUnit, -h / 2 + 10 * this.scaleUnit, w - 24 * this.scaleUnit, h - 20 * this.scaleUnit);

      const label = this.add.text(0, 0, next.text.toUpperCase(), {
        fontFamily: 'Arial Black, Impact, sans-serif',
        fontSize: `${Math.round(clamp(w * 0.038, 28 * this.scaleUnit, 48 * this.scaleUnit))}px`,
        color: '#fff8e6',
        align: 'center',
        fixedWidth: Math.round(w - 60 * this.scaleUnit),
        stroke: '#030406',
        strokeThickness: Math.max(4, 6 * this.scaleUnit),
      }).setOrigin(0.5);
      group.add([gfx, label]);
      this.bannerLayer.add(group);

      this.tweens.add({
        targets: group,
        alpha: 1,
        y,
        duration: 290,
        ease: 'Back.easeOut',
      });
      this.tweens.add({
        targets: group,
        x: this.W / 2 + 8 * this.scaleUnit,
        duration: 90,
        repeat: 4,
        yoyo: true,
        ease: 'Stepped',
        delay: 120,
      });
      this.time.delayedCall(1850, () => {
        this.tweens.add({
          targets: group,
          alpha: 0,
          y: y - 26 * this.scaleUnit,
          duration: 240,
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

    playSponsorBreak(payload = {}) {
      document.body.classList.add('sponsor-active');
      this.sponsorLayer.removeAll(true);
      this.sponsorLayer.setVisible(true).setAlpha(0);

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
          this.sponsorVideo.loadURL(payload.videoUrl, true);
          this.sponsorVideo.once('play', () => this.showSponsorEndCap(payload, Number(payload.durationMs || 15000) - 3200));
          this.sponsorVideo.once('complete', () => this.stopSponsorBreak());
          this.sponsorVideo.play(false);
        } catch (_err) {
          this.showSponsorFallback(videoBox, payload);
        }
      } else {
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
      this.sponsorTimer = this.time.delayedCall(Number(payload.durationMs || 15000), () => this.stopSponsorBreak());
      if (!payload.videoUrl) this.showSponsorEndCap(payload, Number(payload.durationMs || 9000) - 2800);
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
      const safeDelay = clamp(Number(delay) || 0, 900, 12000);
      this.time.delayedCall(safeDelay, () => {
        if (!this.sponsorLayer.visible) return;
        const alive = this.playerGroups.filter(player => Number(player.data.health || 0) > 0).length;
        const kills = this.playerGroups.reduce((sum, player) => sum + Number(player.data.kills || 0), 0);
        const cap = this.add.container(this.W + 380 * this.scaleUnit, this.H * 0.54);
        const w = this.W * 0.34;
        const h = this.H * 0.38;
        const gfx = this.add.graphics();
        gfx.fillStyle(0x02040a, 0.91);
        gfx.fillRoundedRect(-w / 2, -h / 2, w, h, 22 * this.scaleUnit);
        gfx.lineStyle(Math.max(2, 4 * this.scaleUnit), 0xf6c95b, 0.82);
        gfx.strokeRoundedRect(-w / 2, -h / 2, w, h, 22 * this.scaleUnit);
        const label = this.add.text(0, -h * 0.28, 'BATTLE SNAPSHOT', {
          fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
          fontSize: `${Math.round(26 * this.scaleUnit)}px`,
          color: '#ffd37a',
          align: 'center',
        }).setOrigin(0.5);
        const stats = this.add.text(0, h * 0.02, `${alive} ACTIVE\n${kills} KOs`, {
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: `${Math.round(54 * this.scaleUnit)}px`,
          color: '#fff8e6',
          align: 'center',
          lineSpacing: Math.round(12 * this.scaleUnit),
          stroke: '#02040a',
          strokeThickness: Math.max(5, 8 * this.scaleUnit),
        }).setOrigin(0.5);
        const returnText = this.add.text(0, h * 0.36, payload.returnText || 'Back to battle', {
          fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
          fontSize: `${Math.round(27 * this.scaleUnit)}px`,
          color: '#99ffda',
          align: 'center',
        }).setOrigin(0.5);
        cap.add([gfx, label, stats, returnText]);
        this.sponsorLayer.add(cap);
        this.tweens.add({
          targets: cap,
          x: this.W * 0.78,
          duration: 520,
          ease: 'Back.easeOut',
        });
      });
    }

    stopSponsorBreak() {
      if (this.sponsorTimer) {
        this.sponsorTimer.remove(false);
        this.sponsorTimer = null;
      }
      try {
        if (this.sponsorVideo?.isPlaying) this.sponsorVideo.stop();
      } catch (_err) {}
      this.tweens.add({
        targets: this.sponsorLayer,
        alpha: 0,
        duration: 360,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          this.sponsorLayer.removeAll(true);
          this.sponsorLayer.setVisible(false);
          document.body.classList.remove('sponsor-active');
          this.showBanner('Battle resumed', 'return');
        },
      });
    }

    startDemo() {
      const players = [
        { id: 'demo-1', name: 'NovaStrike', health: 100, kills: 3 },
        { id: 'demo-2', name: 'MiraVex', health: 86, kills: 2 },
        { id: 'demo-3', name: 'RookFire', health: 73, kills: 1 },
        { id: 'demo-4', name: 'JettByte', health: 94, kills: 4 },
        { id: 'demo-5', name: 'CrownArc', health: 65, kills: 2 },
      ];
      this.time.delayedCall(350, () => {
        players.forEach((player, index) => this.time.delayedCall(index * 90, () => this.addPlayerCard(player)));
      });
      this.time.delayedCall(1200, () => this.showBanner('Chat attacks power the battle', 'event'));
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
      this.showDamage(this.W / 2 + (Math.random() - 0.5) * this.safe.width * 0.34, this.safe.y + this.safe.height * 0.63, Math.random() > 0.78 ? 'CRIT' : Math.round(14 + Math.random() * 48), Math.random() > 0.78 ? 'critical' : 'normal');
      if (Math.random() > 0.82) this.showBanner(`${player.data.name} is heating up`, 'kill');
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
