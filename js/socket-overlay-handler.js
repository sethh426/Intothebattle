/**
 * Socket.IO Overlay Handler
 * Bridges real-time Socket.IO events to Phaser scene rendering
 */

function initSocketOverlay(game) {
  const socket = io();
  const scene = game.scene.scenes[0];
  const statusBadge = document.getElementById('status-badge');

  // Status updates
  socket.on('connect', () => {
    console.log('Socket connected');
    statusBadge.textContent = 'CONNECTED';
    statusBadge.className = 'connected';
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected');
    statusBadge.textContent = 'DISCONNECTED';
    statusBadge.className = 'disconnected';
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    statusBadge.textContent = 'ERROR';
    statusBadge.className = 'disconnected';
  });

  // Overlay events
  socket.on('damage', (data) => {
    // data: { x, y, damage, type: 'normal'|'kill'|'critical' }
    scene.showDamage(data.x || game.scale.width / 2, data.y || game.scale.height / 2, data.damage, data.type);
  });

  socket.on('banner', (data) => {
    // data: { text, type: 'kill'|'streak'|'gift'|'legendary' }
    scene.showBanner(data.text, data.type);
  });

  socket.on('playerJoined', (data) => {
    // data: { id, name, avatar, ... }
    scene.addPlayerCard(data);
  });

  socket.on('playerLeft', (data) => {
    // data: { id }
    scene.removePlayerCard(data.id);
  });

  socket.on('playerUpdate', (data) => {
    // data: { id, stats: { health, kills, ... } }
    scene.updatePlayerStats(data.id, data.stats);
  });

  socket.on('effect:flash', (data) => {
    // data: { duration, color }
    scene.flashScreen(data.duration || 200, data.color || '#ff0000');
  });

  socket.on('effect:shake', (data) => {
    // data: { intensity }
    scene.shakeCam(data.intensity || 5);
  });

  // Demo data for testing (remove in production)
  window.overlaySocket = {
    socket,
    testDamage: (dmg = 25, type = 'normal') => {
      socket.emit('damage', {
        x: game.scale.width / 2 + Math.random() * 200 - 100,
        y: game.scale.height / 2 - 100,
        damage: dmg,
        type: type
      });
    },
    testBanner: (text = 'KILL STREAK!', type = 'kill') => {
      socket.emit('banner', { text, type });
    },
    testFlash: () => {
      socket.emit('effect:flash', { duration: 200, color: '#ff0000' });
    },
    testShake: () => {
      socket.emit('effect:shake', { intensity: 8 });
    }
  };

  console.log('Socket overlay initialized. Use window.overlaySocket for testing.');
}
