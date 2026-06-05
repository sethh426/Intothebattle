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
    // Create player card sprite/container
    // This is a placeholder for future implementation
    console.log('addPlayerCard:', playerData);
  }

  /**
   * Remove player card from overlay
   * @param {string} playerId - Player ID
   */
  removePlayerCard(playerId) {
    // Remove player card
    console.log('removePlayerCard:', playerId);
  }

  /**
   * Update player card stats
   * @param {string} playerId - Player ID
   * @param {object} stats - Player stats (health, kills, etc)
   */
  updatePlayerStats(playerId, stats) {
    // Update player card visuals
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
