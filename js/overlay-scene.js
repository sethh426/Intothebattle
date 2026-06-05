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

    this.add.image(this.scale.width / 2, this.scale.height / 2, 'backgroundTexture');
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
      const newWidth = (player.container.width - 16) * (stats.health / 100);
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
}
