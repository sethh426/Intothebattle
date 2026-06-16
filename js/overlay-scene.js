/**
 * OverlayScene
 * Phaser 4 scene for rendering the TikTok LIVE battle royale overlay
 * Handles damage numbers, banners, animations, and real-time visual updates
 */

class OverlayScene extends Phaser.Scene {
  constructor() {
    super({ key: 'OverlayScene' });
    this.playerGroups = [];
    this.damageNumbers = [];
    this.banners = [];
    this.laserColor = 0x7afcff;
    this.layoutConfig = {
      gap: 0,
      offsetX: 0,
      offsetY: 0,
      height: 85,
      zoom: 100
    };
    this.isDarkTheme = true;
    this.customBackground = null;
    this.customBackgroundKey = null;
    this.sponsorQueue = [];
    this.sponsorState = 'battle';
    this.sponsorLayer = null;
    this.sponsorTimer = null;
    this.sponsorProgressTween = null;
    this.sponsorVideo = null;
    this.sponsorClockStarted = false;
    this.sponsorAudioContext = null;
  }

  create() {
    // Create background with grid pattern
    this.createBackground();

    // Create text style objects for reuse
    this.damageTextStyle = {
      font: 'bold 28px Rajdhani',
      fill: '#ff5050',
      align: 'center',
      shadow: {
        offsetX: 2,
        offsetY: 2,
        color: '#000000',
        blur: 8,
        fill: true
      }
    };

    this.bannerTextStyle = {
      font: 'bold 32px Rajdhani',
      fill: '#ffcc44',
      align: 'center',
      shadow: {
        offsetX: 2,
        offsetY: 2,
        color: '#000000',
        blur: 8,
        fill: true
      }
    };

    // Create container for player elements
    this.playerContainer = this.add.container(0, 0);

    // Create containers for floating text effects
    this.damageContainer = this.add.container(0, 0);
    this.bannerContainer = this.add.container(0, 0);
    this.sponsorLayer = this.add.container(0, 0).setDepth(10000).setVisible(false).setAlpha(0);
    this.isReady = true;
  }

  createBackground() {
    // Draw dark background
    const graphics = this.make.graphics({ x: 0, y: 0, add: false });
    graphics.fillStyle(0x02040a, 1);
    graphics.fillRect(0, 0, this.scale.width, this.scale.height);

    // Draw subtle grid pattern
    graphics.lineStyle(1, 0x1a4466, 0.1);
    const gridSize = 80;
    for (let x = 0; x < this.scale.width; x += gridSize) {
      graphics.lineBetween(x, 0, x, this.scale.height);
    }
    for (let y = 0; y < this.scale.height; y += gridSize) {
      graphics.lineBetween(0, y, this.scale.width, y);
    }

    graphics.generateTexture('backgroundTexture', this.scale.width, this.scale.height);
    graphics.destroy();

    this.add.image(this.scale.width / 2, this.scale.height / 2, 'backgroundTexture').setDepth(-20);
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
    if (!url) return;

    const textureKey = `roomBackground-${Date.now()}`;
    this.customBackgroundKey = textureKey;
    this.load.image(textureKey, url);
    this.load.once('complete', () => {
      if (!this.textures.exists(textureKey)) return;
      const image = this.add.image(this.scale.width / 2, this.scale.height / 2, textureKey);
      const scale = Math.max(this.scale.width / image.width, this.scale.height / image.height);
      image.setScale(scale);
      image.setDepth(-10);
      this.customBackground = image;
    });
    this.load.start();
  }

  update() {
    // Update layout based on config
    this.updatePlayerLayout();

    // Clean up expired damage numbers and banners
    this.damageNumbers = this.damageNumbers.filter(dmg => dmg.active);
    this.banners = this.banners.filter(banner => banner.active);
  }

  updatePlayerLayout() {
    const config = this.layoutConfig;
    const containerX = this.scale.width / 2 + config.offsetX;
    const containerY = this.scale.height / 2 + config.offsetY;
    this.playerContainer.setPosition(containerX, containerY);
    this.playerContainer.setScale(config.zoom / 100);
  }

  /**
   * Show damage number at position
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string|number} damage - Damage text/number
   * @param {string} type - 'normal', 'kill', 'critical'
   */
  showDamage(x, y, damage, type = 'normal') {
    let color = '#ff5050';
    let fontSize = 28;
    let duration = 850;

    if (type === 'kill') {
      color = '#ffd84f';
      fontSize = 34;
    } else if (type === 'critical') {
      color = '#ff2244';
      fontSize = 38;
    }

    const text = this.add.text(x, y, damage, {
      font: `bold ${fontSize}px Rajdhani`,
      fill: color,
      align: 'center',
      shadow: {
        offsetX: 2,
        offsetY: 2,
        color: '#000000',
        blur: 8,
        fill: true
      }
    });

    text.setOrigin(0.5, 0.5);
    this.damageContainer.add(text);

    // Float up and fade out animation
    this.tweens.add({
      targets: text,
      y: y - 150,
      alpha: 0,
      duration: duration,
      ease: 'Quad.easeOut',
      onComplete: () => {
        text.destroy();
      }
    });

    this.damageNumbers.push(text);
  }

  /**
   * Show banner announcement
   * @param {string} text - Banner text
   * @param {string} type - 'kill', 'streak', 'gift', 'legendary'
   */
  showBanner(text, type = 'kill') {
    let color = '#ffcc44';
    let fontSize = 32;
    let duration = 2600;
    let displayDuration = 3500;

    if (type === 'streak') {
      color = '#ff44aa';
      fontSize = 36;
    } else if (type === 'gift') {
      color = '#ffffff';
      fontSize = 26;
    } else if (type === 'legendary') {
      color = '#FFD700';
      fontSize = 40;
      displayDuration = 4000;
    }

    const banner = this.add.text(this.scale.width / 2, this.scale.height * 0.15, text, {
      font: `bold ${fontSize}px Rajdhani`,
      fill: color,
      align: 'center',
      shadow: {
        offsetX: 2,
        offsetY: 2,
        color: '#000000',
        blur: 12,
        fill: true
      }
    });

    banner.setOrigin(0.5, 0.5);
    this.bannerContainer.add(banner);

    // Slide in animation
    banner.setAlpha(0);
    banner.setY(banner.y - 24);

    this.tweens.add({
      targets: banner,
      y: this.scale.height * 0.15,
      alpha: 1,
      duration: 350,
      ease: 'Back.easeOut'
    });

    // Slide out and fade animation
    this.time.delayedCall(duration, () => {
      this.tweens.add({
        targets: banner,
        y: banner.y - 16,
        alpha: 0,
        duration: 500,
        ease: 'Quad.easeIn',
        onComplete: () => {
          banner.destroy();
          this.banners = this.banners.filter(b => b !== banner);
        }
      });
    });

    this.banners.push(banner);
  }

  /**
   * Update laser/accent color
   * @param {string} colorHex - Hex color code
   */
  updateLaserColor(colorHex) {
    this.laserColor = parseInt(colorHex.replace('#', '0x'), 16);
    // Could update grid color or other visual elements here
  }

  /**
   * Update layout configuration
   * @param {string} key - Config key (gap, offsetX, offsetY, height, zoom)
   * @param {number} value - Config value
   */
  updateLayoutConfig(key, value) {
    if (this.layoutConfig.hasOwnProperty(key)) {
      this.layoutConfig[key] = value;
    }
  }

  /**
   * Reset layout to defaults
   */
  resetLayout() {
    this.layoutConfig = {
      gap: 0,
      offsetX: 0,
      offsetY: 0,
      height: 85,
      zoom: 100
    };
  }

  /**
   * Add player card to overlay
   * @param {object} playerData - Player info (id, name, avatar, etc)
   */
  addPlayerCard(playerData) {
    const playerId = playerData.id || playerData.userId;
    
    // Check if player already exists
    if (this.playerGroups.find(p => p.playerId === playerId)) {
      console.warn('Player already exists:', playerId);
      return;
    }

    // Create player card container
    const cardWidth = 140;
    const cardHeight = 180;
    const padding = 8;

    const cardContainer = this.add.container(0, 0);
    cardContainer.playerId = playerId;

    // Card background
    const bgGraphics = this.make.graphics({ x: 0, y: 0, add: false });
    bgGraphics.fillStyle(0x02040a, 0.9);
    bgGraphics.fillRoundedRect(0, 0, cardWidth, cardHeight, 8);
    bgGraphics.lineStyle(2, 0x7afcff, 0.4);
    bgGraphics.strokeRoundedRect(0, 0, cardWidth, cardHeight, 8);
    bgGraphics.generateTexture('playerCardBg' + playerId, cardWidth, cardHeight);
    bgGraphics.destroy();

    const bgImage = this.add.image(0, 0, 'playerCardBg' + playerId);
    bgImage.setOrigin(0, 0);
    cardContainer.add(bgImage);

    // Avatar placeholder (circle)
    const avatarGraphics = this.make.graphics({ x: 0, y: 0, add: false });
    avatarGraphics.fillStyle(0x7afcff, 0.15);
    avatarGraphics.fillCircle(32, 32, 28);
    avatarGraphics.lineStyle(2, 0x7afcff, 0.6);
    avatarGraphics.strokeCircle(32, 32, 28);
    avatarGraphics.generateTexture('avatar' + playerId, 64, 64);
    avatarGraphics.destroy();

    const avatarImage = this.add.image(padding + 32, padding + 32, 'avatar' + playerId);
    avatarImage.setScale(0.7);
    cardContainer.add(avatarImage);

    // Player name
    const nameText = this.add.text(padding, padding + 65, playerData.name || 'Player', {
      font: 'bold 11px Rajdhani',
      fill: '#7afcff',
      align: 'left',
      wordWrap: { width: cardWidth - padding * 2 }
    });
    nameText.setOrigin(0, 0);
    cardContainer.add(nameText);

    // Health bar background
    const healthBarBg = this.add.rectangle(
      padding,
      padding + 85,
      cardWidth - padding * 2,
      8,
      0x1a1a2e,
      1
    );
    healthBarBg.setOrigin(0, 0);
    cardContainer.add(healthBarBg);

    // Health bar
    const healthBar = this.add.rectangle(
      padding,
      padding + 85,
      (cardWidth - padding * 2) * (playerData.health || 100) / 100,
      8,
      0x00ff88,
      1
    );
    healthBar.setOrigin(0, 0);
    healthBar.playerId = playerId;
    cardContainer.add(healthBar);

    // Health text
    const healthText = this.add.text(
      cardWidth / 2,
      padding + 85,
      Math.round(playerData.health || 100) + ' HP',
      {
        font: 'bold 9px Rajdhani',
        fill: '#7afcff',
        align: 'center'
      }
    );
    healthText.setOrigin(0.5, 0.5);
    cardContainer.add(healthText);

    // Stats display
    const kills = playerData.kills || 0;
    const deaths = playerData.deaths || 0;
    const statsText = this.add.text(
      padding,
      padding + 105,
      `K: ${kills} | D: ${deaths}`,
      {
        font: 'bold 10px Rajdhani',
        fill: '#8899bb',
        align: 'left'
      }
    );
    statsText.setOrigin(0, 0);
    cardContainer.add(statsText);

    // Killstreak indicator
    if (kills >= 3) {
      const streakGraphics = this.make.graphics({ x: 0, y: 0, add: false });
      streakGraphics.fillStyle(0xffcc44, 0.2);
      streakGraphics.fillRect(0, 0, cardWidth, 3);
      streakGraphics.generateTexture('streak' + playerId, cardWidth, 3);
      streakGraphics.destroy();

      const streakBar = this.add.image(0, 0, 'streak' + playerId);
      streakBar.setOrigin(0, 0);
      cardContainer.add(streakBar);
    }

    this.playerContainer.add(cardContainer);

    // Store player data for updates
    this.playerGroups.push({
      playerId: playerId,
      container: cardContainer,
      healthBar: healthBar,
      healthText: healthText,
      statsText: statsText,
      nameText: nameText,
      maxHealthBarWidth: cardWidth - padding * 2,
      data: playerData
    });

    console.log('addPlayerCard:', playerId, playerData.name);
  }

  /**
   * Remove player card from overlay
   * @param {string} playerId - Player ID
   */
  removePlayerCard(playerId) {
    const index = this.playerGroups.findIndex(p => p.playerId === playerId);
    if (index !== -1) {
      const player = this.playerGroups[index];
      player.container.destroy();
      this.playerGroups.splice(index, 1);
      console.log('removePlayerCard:', playerId);
    }
  }

  /**
   * Update player card stats
   * @param {string} playerId - Player ID
   * @param {object} stats - Player stats (health, kills, deaths, etc)
   */
  updatePlayerStats(playerId, stats) {
    const player = this.playerGroups.find(p => p.playerId === playerId);
    if (!player) return;

    // Update health bar
    if (stats.health !== undefined) {
      const newWidth = player.maxHealthBarWidth * (stats.health / 100);
      this.tweens.add({
        targets: player.healthBar,
        width: newWidth,
        duration: 150,
        ease: 'Power2.easeOut'
      });
      player.healthText.setText(Math.round(stats.health) + ' HP');

      // Change color based on health
      if (stats.health > 60) {
        player.healthBar.setFillStyle(0x00ff88, 1);
      } else if (stats.health > 30) {
        player.healthBar.setFillStyle(0xffcc44, 1);
      } else {
        player.healthBar.setFillStyle(0xff5566, 1);
      }
      player.data.health = stats.health;
    }

    // Update stats text
    if (stats.kills !== undefined || stats.deaths !== undefined) {
      const kills = stats.kills !== undefined ? stats.kills : player.data.kills || 0;
      const deaths = stats.deaths !== undefined ? stats.deaths : player.data.deaths || 0;
      player.statsText.setText(`K: ${kills} | D: ${deaths}`);
      player.data.kills = kills;
      player.data.deaths = deaths;
    }

    console.log('updatePlayerStats:', playerId, stats);
  }

  /**
   * Flash screen effect
   * @param {number} duration - Duration in ms
   * @param {string} color - Color (hex)
   */
  flashScreen(duration = 200, color = '#ff0000') {
    const overlay = this.add.rectangle(
      this.scale.width / 2,
      this.scale.height / 2,
      this.scale.width,
      this.scale.height,
      parseInt(color.replace('#', '0x'), 16),
      0.6
    );

    this.tweens.add({
      targets: overlay,
      alpha: 0,
      duration: duration,
      ease: 'Quad.easeOut',
      onComplete: () => {
        overlay.destroy();
      }
    });
  }

  /**
   * Shake camera effect
   * @param {number} intensity - Intensity of shake
   */
  shakeCam(intensity = 5) {
    this.cameras.main.shake(200, intensity / 100);
  }

  setOverlayAuthHelper(fn) {
    if (typeof fn === 'function') this.withOverlayAuth = fn;
  }

  normalizeSponsorPayload(payload = {}) {
    const duration = Number(payload.durationMs);
    const filename = payload.filename ? String(payload.filename) : '';
    let videoUrl = payload.videoUrl || payload.url || payload.src || '';
    if (!videoUrl && filename && typeof this.withOverlayAuth === 'function') {
      videoUrl = this.withOverlayAuth(`/sponsor/${encodeURIComponent(filename)}`, { v: payload._ts || Date.now() });
    }
    return {
      action: payload.action || 'show',
      partner: String(payload.partner || 'IntoTheBattle').slice(0, 70),
      kicker: /sponsor/i.test(String(payload.kicker || '')) ? 'Arena Spotlight' : String(payload.kicker || 'Arena Spotlight').slice(0, 70),
      title: /sponsor/i.test(String(payload.title || '')) || /presented by/i.test(String(payload.title || '')) ? 'Power Moment' : String(payload.title || 'Power Moment').slice(0, 90),
      subtitle: String(payload.subtitle || 'Stay locked in. The next fight is loading.').slice(0, 140),
      filename,
      videoUrl,
      fit: payload.fit === 'cover' ? 'cover' : 'contain',
      muted: payload.muted !== false,
      durationMs: Number.isFinite(duration) ? Math.max(5000, Math.min(120000, duration)) : 15000,
    };
  }

  playSponsorBreak(payload = {}) {
    if (payload && payload.action === 'hide') {
      this.stopSponsorBreak();
      return;
    }

    const scenePayload = this.normalizeSponsorPayload(payload);
    if (this.sponsorState !== 'battle') {
      this.sponsorQueue.push(scenePayload);
      return;
    }

    this.startSponsorIntro(scenePayload);
  }

  stopSponsorBreak() {
    this.sponsorQueue = [];
    if (this.sponsorState === 'battle') return;
    this.startSponsorOutro(this.activeSponsorPayload || {}, true);
  }

  startSponsorIntro(payload) {
    const w = this.scale.width;
    const h = this.scale.height;
    this.activeSponsorPayload = payload;
    this.sponsorState = 'intro';
    this.prepareSponsorLayer();
    this.setBattlePresentation(true);
    this.playSponsorTone('intro');

    const dim = this.add.rectangle(w / 2, h / 2, w, h, 0x02040a, 0).setOrigin(0.5);
    const centerGlow = this.add.circle(w / 2, h * 0.5, h * 0.16, 0xf6c95b, 0.04)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.65);
    const cyanRing = this.add.circle(w / 2, h * 0.5, h * 0.21)
      .setStrokeStyle(3, 0x55e7ff, 0.28)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.72);
    const goldRing = this.add.circle(w / 2, h * 0.5, h * 0.27)
      .setStrokeStyle(2, 0xf6c95b, 0.22)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.6);
    const sweep = this.add.rectangle(-w * 0.35, h * 0.5, w * 0.38, h * 1.35, 0xf6c95b, 0.18)
      .setAngle(-12)
      .setBlendMode(Phaser.BlendModes.ADD);
    const cyanSweep = this.add.rectangle(w * 1.25, h * 0.5, w * 0.24, h * 1.18, 0x55e7ff, 0.14)
      .setAngle(14)
      .setBlendMode(Phaser.BlendModes.ADD);
    const scanline = this.add.rectangle(w / 2, -30, w, 20, 0x55e7ff, 0.12)
      .setBlendMode(Phaser.BlendModes.ADD);
    const topRail = this.add.rectangle(w / 2, h * 0.19, 0, 4, 0xf6c95b, 0.9);
    const bottomRail = this.add.rectangle(w / 2, h * 0.81, 0, 4, 0x55e7ff, 0.7);
    const leftGate = this.add.rectangle(-w * 0.18, h / 2, w * 0.28, h, 0x050913, 0.92);
    const rightGate = this.add.rectangle(w * 1.18, h / 2, w * 0.28, h, 0x050913, 0.92);
    const sparks = [];
    for (let i = 0; i < 18; i += 1) {
      const x = w * (0.18 + Math.random() * 0.64);
      const y = h * (0.22 + Math.random() * 0.56);
      const color = i % 3 === 0 ? 0xf6c95b : 0x55e7ff;
      sparks.push(this.add.circle(x, y, 2 + Math.random() * 3, color, 0).setBlendMode(Phaser.BlendModes.ADD));
    }
    const title = this.add.text(w / 2, h * 0.5, 'POWER MOMENT', {
      font: '900 74px Exo 2',
      fill: '#fff8e6',
      align: 'center',
      shadow: { offsetX: 0, offsetY: 0, color: '#ff6a3d', blur: 24, fill: true }
    }).setOrigin(0.5).setAlpha(0).setScale(0.88);
    const partner = this.add.text(w / 2, h * 0.62, `FEATURING ${payload.partner.toUpperCase()}`, {
      font: '800 28px Rajdhani',
      fill: '#d7f5ff',
      align: 'center',
      letterSpacing: 2,
      shadow: { offsetX: 0, offsetY: 0, color: '#55e7ff', blur: 14, fill: true }
    }).setOrigin(0.5).setAlpha(0);

    this.sponsorLayer.add([dim, centerGlow, cyanRing, goldRing, leftGate, rightGate, sweep, cyanSweep, scanline, topRail, bottomRail, ...sparks, title, partner]);
    this.cameras.main.shake(260, 0.0035);
    this.tweens.add({ targets: this.sponsorLayer, alpha: 1, duration: 160, ease: 'Quad.easeOut' });
    this.tweens.add({ targets: dim, alpha: 0.84, duration: 380, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: [leftGate, rightGate], x: w / 2, alpha: 0.18, duration: 460, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: leftGate, x: -w * 0.2, duration: 580, delay: 340, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: rightGate, x: w * 1.2, duration: 580, delay: 340, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: centerGlow, scale: 1.25, alpha: 0.12, duration: 520, yoyo: true, repeat: 1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: cyanRing, scale: 1.08, alpha: 0.48, angle: 16, duration: 760, yoyo: true, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: goldRing, scale: 1.18, alpha: 0.34, angle: -18, duration: 900, yoyo: true, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: sweep, x: w * 1.35, duration: 950, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: cyanSweep, x: -w * 0.28, duration: 980, delay: 130, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: scanline, y: h + 30, duration: 1120, delay: 80, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: [topRail, bottomRail], width: w * 0.78, duration: 560, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: topRail, alpha: 0.42, duration: 220, delay: 620, yoyo: true, repeat: 1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: bottomRail, alpha: 0.35, duration: 220, delay: 700, yoyo: true, repeat: 1, ease: 'Sine.easeInOut' });
    sparks.forEach((spark, i) => {
      this.tweens.add({
        targets: spark,
        alpha: 0.8,
        scale: 1.9 + Math.random() * 1.4,
        x: spark.x + (Math.random() - 0.5) * 70,
        y: spark.y + (Math.random() - 0.5) * 50,
        duration: 360 + Math.random() * 420,
        delay: 120 + i * 18,
        yoyo: true,
        ease: 'Sine.easeOut'
      });
    });
    this.tweens.add({ targets: title, alpha: 1, scale: 1, y: title.y - 3, duration: 520, delay: 220, ease: 'Back.easeOut' });
    this.tweens.add({ targets: title, scale: 1.025, duration: 210, delay: 760, yoyo: true, repeat: 1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: partner, alpha: 1, y: partner.y + 8, duration: 420, delay: 360, ease: 'Quad.easeOut' });
    this.setSponsorTimer(() => this.startSponsorLive(payload), 1350);
  }

  startSponsorLive(payload) {
    if (this.sponsorState === 'battle') return;
    const w = this.scale.width;
    const h = this.scale.height;
    this.sponsorState = 'live';
    this.sponsorClockStarted = false;
    this.prepareSponsorLayer();

    const bg = this.add.rectangle(w / 2, h / 2, w, h, 0x03060c, 0.94).setOrigin(0.5);
    const scrim = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.42).setOrigin(0.5);
    const leftPanel = this.add.rectangle(w * 0.24, h / 2, w * 0.48, h, 0x050913, 0.72).setOrigin(0.5);
    const brand = this.add.text(w - 70, 58, payload.partner.toUpperCase(), {
      font: '900 28px Exo 2',
      fill: '#ffffff',
      align: 'right'
    }).setOrigin(1, 0).setAlpha(0);
    const kicker = this.add.text(70, h - 330, payload.kicker.toUpperCase(), {
      font: '900 18px Rajdhani',
      fill: '#ffdf8a',
      letterSpacing: 3,
      backgroundColor: 'rgba(246,201,91,0.12)',
      padding: { x: 14, y: 8 }
    }).setAlpha(0);
    const title = this.add.text(70, h - 272, payload.title, {
      font: '900 64px Exo 2',
      fill: '#fff8e6',
      lineSpacing: -8,
      wordWrap: { width: Math.min(900, w * 0.68) },
      shadow: { offsetX: 0, offsetY: 4, color: '#000000', blur: 18, fill: true }
    }).setAlpha(0);
    const subtitle = this.add.text(72, h - 164, payload.subtitle, {
      font: '800 27px Rajdhani',
      fill: '#d7f5ff',
      wordWrap: { width: Math.min(820, w * 0.62) },
      shadow: { offsetX: 0, offsetY: 3, color: '#000000', blur: 12, fill: true }
    }).setAlpha(0);
    const trackWidth = w - 140;
    const progressBg = this.add.rectangle(70, h - 42, trackWidth, 6, 0xffffff, 0.16).setOrigin(0, 0.5);
    const progress = this.add.rectangle(70, h - 42, 0, 6, 0xf6c95b, 1).setOrigin(0, 0.5);
    const returnHint = this.add.text(w - 70, h - 68, 'BACK TO THE BATTLE SOON', {
      font: '800 18px Rajdhani',
      fill: '#9fefff',
      letterSpacing: 2
    }).setOrigin(1, 0.5).setAlpha(0);

    this.sponsorLayer.add([bg]);
    const video = this.createSponsorVideo(payload, w, h, {
      onFirstFrame: () => this.startSponsorSceneClock(payload, progress, trackWidth, payload.durationMs),
    });
    if (video) this.sponsorLayer.add(video);
    this.sponsorLayer.add([scrim, leftPanel, brand, kicker, title, subtitle, progressBg, progress, returnHint]);

    this.sponsorLayer.setAlpha(0);
    this.tweens.add({ targets: this.sponsorLayer, alpha: 1, duration: 420, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: leftPanel, x: w * 0.22, alpha: 0.84, duration: 620, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: [brand, kicker, title, subtitle, returnHint], alpha: 1, duration: 420, delay: 180, ease: 'Quad.easeOut' });
    this.tweens.add({ targets: title, x: title.x + 14, duration: payload.durationMs, ease: 'Linear' });
    if (!video) this.startSponsorSceneClock(payload, progress, trackWidth, payload.durationMs);
  }

  startSponsorSceneClock(payload, progress, trackWidth, durationMs) {
    if (this.sponsorClockStarted || this.sponsorState !== 'live') return;
    this.sponsorClockStarted = true;
    this.sponsorProgressTween = this.tweens.add({
      targets: progress,
      width: trackWidth,
      duration: durationMs,
      ease: 'Linear'
    });

    this.setSponsorTimer(() => this.startSponsorOutro(payload), durationMs);
  }

  startSponsorOutro(payload = {}, forced = false) {
    if (this.sponsorState === 'battle') return;
    const w = this.scale.width;
    const h = this.scale.height;
    this.sponsorState = 'outro';
    this.clearSponsorTimer();
    this.playSponsorTone('outro');

    const outro = this.add.text(w / 2, h / 2, forced ? 'RETURNING TO BATTLE' : 'BACK TO THE BATTLE', {
      font: '900 64px Exo 2',
      fill: '#fff8e6',
      align: 'center',
      shadow: { offsetX: 0, offsetY: 0, color: '#55e7ff', blur: 24, fill: true }
    }).setOrigin(0.5).setAlpha(0).setScale(0.86);
    const wipe = this.add.rectangle(-w * 0.2, h / 2, w * 0.28, h * 1.25, 0x55e7ff, 0.22)
      .setAngle(12)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.sponsorLayer.add([wipe, outro]);
    this.tweens.add({ targets: wipe, x: w * 1.2, duration: 820, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: outro, alpha: 1, scale: 1, duration: 360, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: this.sponsorLayer,
      alpha: 0,
      duration: 520,
      delay: 700,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this.finishSponsorBreak();
      }
    });
  }

  createSponsorVideo(payload, width, height, hooks = {}) {
    if (!payload.videoUrl || typeof this.add.video !== 'function') return null;
    try {
      const video = this.add.video(width / 2, height / 2);
      this.sponsorVideo = video;
      video.setAlpha(0);
      video.setDisplaySize(width, height);
      video.loadURL(payload.videoUrl, payload.muted, 'anonymous');
      video.once('play', () => {
        this.tweens.add({ targets: video, alpha: payload.fit === 'contain' ? 1 : 0.92, duration: 450, ease: 'Quad.easeOut' });
        this.fitSponsorVideo(video, payload.fit, width, height);
        hooks.onFirstFrame?.();
      });
      video.once('loadeddata', () => this.fitSponsorVideo(video, payload.fit, width, height));
      video.once('complete', () => {
        if (this.sponsorState === 'live') this.startSponsorOutro(payload);
      });
      video.play(false);
      return video;
    } catch (err) {
      console.warn('Sponsor video failed to initialize:', err);
      return null;
    }
  }

  fitSponsorVideo(video, fit, width, height) {
    const media = video.video;
    const mediaWidth = media && media.videoWidth ? media.videoWidth : width;
    const mediaHeight = media && media.videoHeight ? media.videoHeight : height;
    const scale = fit === 'contain'
      ? Math.min(width / mediaWidth, height / mediaHeight)
      : Math.max(width / mediaWidth, height / mediaHeight);
    video.setDisplaySize(mediaWidth * scale, mediaHeight * scale);
  }

  prepareSponsorLayer() {
    this.clearSponsorTimer();
    this.sponsorClockStarted = false;
    if (this.sponsorProgressTween) {
      this.sponsorProgressTween.stop();
      this.sponsorProgressTween = null;
    }
    if (this.sponsorVideo) {
      try { this.sponsorVideo.stop(); } catch (_err) {}
      this.sponsorVideo = null;
    }
    this.sponsorLayer.removeAll(true);
    this.sponsorLayer.setVisible(true).setAlpha(1);
  }

  clearSponsorTimer() {
    if (!this.sponsorTimer) return;
    if (typeof this.sponsorTimer === 'number') {
      window.clearTimeout(this.sponsorTimer);
    } else if (typeof this.sponsorTimer.remove === 'function') {
      this.sponsorTimer.remove(false);
    }
    this.sponsorTimer = null;
  }

  setSponsorTimer(callback, delayMs) {
    this.clearSponsorTimer();
    this.sponsorTimer = window.setTimeout(() => {
      this.sponsorTimer = null;
      callback();
    }, delayMs);
  }

  finishSponsorBreak() {
    this.prepareSponsorLayer();
    this.sponsorLayer.setVisible(false).setAlpha(0);
    this.setBattlePresentation(false);
    this.sponsorState = 'battle';
    this.activeSponsorPayload = null;

    const next = this.sponsorQueue.shift();
    if (next) {
      window.setTimeout(() => this.startSponsorIntro(next), 250);
    }
  }

  setBattlePresentation(sponsorActive) {
    const alpha = sponsorActive ? 0.34 : 1;
    const targets = [this.playerContainer, this.damageContainer, this.bannerContainer].filter(Boolean);
    this.tweens.add({
      targets,
      alpha,
      duration: sponsorActive ? 420 : 520,
      ease: 'Cubic.easeOut'
    });
  }

  playSponsorTone(kind) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!this.sponsorAudioContext) this.sponsorAudioContext = new AudioContext();
      const ctx = this.sponsorAudioContext;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;

      const playTone = (start, duration, from, to, type, volume) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(from, now + start);
        osc.frequency.exponentialRampToValueAtTime(to, now + start + duration);
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(volume, now + start + duration * 0.24);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + duration + 0.02);
      };

      if (kind === 'intro') {
        playTone(0, 0.32, 160, 92, 'sawtooth', 0.08);
        playTone(0.18, 0.46, 420, 720, 'triangle', 0.045);
      } else {
        playTone(0, 0.24, 220, 520, 'triangle', 0.05);
        playTone(0.12, 0.34, 110, 70, 'sine', 0.055);
      }
    } catch (_err) {
      // Audio can be blocked by the browser/OBS until media interaction; visuals still run.
    }
  }
}
