const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const COLORS = [
  '#f9c74f', // Amber / Gold
  '#f94144', // Red
  '#43aa8b', // Green
  '#577590', // Blue-slate
  '#f9844a', // Orange
  '#9b5de5', // Purple
  '#00bbf9', // Cyan
  '#f15bb5', // Pink
];

// Room state storage in memory
// Map<string, RoomState>
const rooms = new Map();

function assignColor(room) {
  const usedColors = new Set(Array.from(room.players.values()).map(p => p.color));
  const available = COLORS.find(c => !usedColors.has(c));
  if (available) return available;
  return COLORS[room.players.size % COLORS.length];
}

function serializePlayers(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    lives: p.lives,
    progress: p.progress,
    status: p.status,
    weapon: p.weapon,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    hidden: p.hidden,
    attack: p.attack,
    rank: p.rank,
    isHost: p.isHost,
  }));
}

function serializeRoom(room) {
  return {
    id: room.id,
    status: room.status,
    finishers: room.finishers,
    players: serializePlayers(room),
    seed: room.seed,
  };
}

function handlePlayerLeave(io, socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) {
    delete socket.data.roomId;
    return;
  }

  const leavingPlayer = room.players.get(socket.id);
  const wasHost = leavingPlayer ? leavingPlayer.isHost : false;
  room.players.delete(socket.id);
  socket.leave(roomId);
  delete socket.data.roomId;

  console.log(`[Socket ${socket.id}] Left room ${roomId}. Remaining: ${room.players.size}`);

  // If room is now empty, immediately destroy room state to prevent ghost memory leaks
  if (room.players.size === 0) {
    rooms.delete(roomId);
    console.log(`[Room ${roomId}] Destroyed (0 players left).`);
    return;
  }

  // If the host left, designate the next player as host
  if (wasHost) {
    const nextHost = room.players.values().next().value;
    if (nextHost) {
      nextHost.isHost = true;
    }
  }

  // If race was in progress, check if remaining players have all finished
  if (room.status === 'in-progress') {
    const activeRunners = Array.from(room.players.values()).filter(p => p.status === 'RUNNING');
    if (activeRunners.length === 0 && room.finishers.length > 0) {
      room.status = 'results';
      io.to(roomId).emit('race-ended', {
        finishers: room.finishers,
        players: serializePlayers(room),
      });
    }
  }

  io.to(roomId).emit('player-left', { playerId: socket.id });
  io.to(roomId).emit('room-update', {
    roomId,
    status: room.status,
    players: serializePlayers(room),
    finishers: room.finishers,
  });
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  io.on('connection', socket => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // Join Room handler
    socket.on('join-room', (payload, callback) => {
      const rawRoomId = (payload && payload.roomId) || 'PX7K2';
      const roomId = String(rawRoomId).toUpperCase().trim().slice(0, 8);
      const runnerName = (payload && payload.name && String(payload.name).trim().slice(0, 12)) || '';

      // If socket is already in another room, leave it first
      if (socket.data.roomId) {
        handlePlayerLeave(io, socket);
      }

      let room = rooms.get(roomId);

      // Check if room is mid-race (Edge case: block mid-race join)
      if (room && room.status === 'in-progress') {
        const errorResp = {
          success: false,
          code: 'RACE_IN_PROGRESS',
          message: 'Race is currently in progress. Please wait for the round to finish or join another room.',
        };
        if (typeof callback === 'function') callback(errorResp);
        socket.emit('join-error', errorResp);
        return;
      }

      // Check room capacity limit (max 8 players)
      if (room && room.players.size >= 8) {
        const errorResp = {
          success: false,
          code: 'ROOM_FULL',
          message: 'This room is full (maximum 8 runners).',
        };
        if (typeof callback === 'function') callback(errorResp);
        socket.emit('join-error', errorResp);
        return;
      }

      // Create room if it doesn't exist (starts completely empty)
      if (!room) {
        room = {
          id: roomId,
          status: 'lobby',
          players: new Map(),
          seed: Math.floor(Math.random() * 1000000),
          finishers: [],
          collectedPickups: new Set(),
          createdAt: Date.now(),
        };
        rooms.set(roomId, room);
        console.log(`[Room ${roomId}] Created new empty room.`);
      }

      // Fresh player creation: always reset lives=5, start line=0, weapon=unarmed
      const isHost = room.players.size === 0;
      const player = {
        id: socket.id,
        name: runnerName || `RUNNER ${room.players.size + 1}`,
        color: assignColor(room),
        lives: 5,
        progress: 0,
        status: 'RUNNING',
        weapon: 'unarmed',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        hidden: false,
        attack: 0,
        rank: null,
        isHost,
      };

      room.players.set(socket.id, player);
      socket.join(roomId);
      socket.data.roomId = roomId;

      console.log(`[Room ${roomId}] Player joined: ${player.name} (${socket.id}). Total: ${room.players.size}`);

      const successResp = {
        success: true,
        player,
        room: serializeRoom(room),
      };

      if (typeof callback === 'function') callback(successResp);
      socket.emit('joined-room', successResp);

      // Broadcast updated roster to everyone in the room
      io.to(roomId).emit('room-update', {
        roomId,
        status: room.status,
        players: serializePlayers(room),
        finishers: room.finishers,
      });

      socket.to(roomId).emit('player-joined', { player });
    });

    // Leave Room handler (triggered explicitly on Back button or leaving game screen)
    socket.on('leave-room', () => {
      handlePlayerLeave(io, socket);
    });

    // Start Race (Host only)
    socket.on('start-race', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const player = room.players.get(socket.id);
      if (!player || !player.isHost) return;

      room.status = 'in-progress';
      room.finishers = [];
      room.collectedPickups = new Set();
      room.seed = Math.floor(Math.random() * 1000000);

      // Fresh state for all runners at the start line
      for (const p of room.players.values()) {
        p.lives = 5;
        p.progress = 0;
        p.status = 'RUNNING';
        p.weapon = 'unarmed';
        p.x = 0;
        p.y = 0;
        p.vx = 0;
        p.vy = 0;
        p.hidden = false;
        p.attack = 0;
        p.rank = null;
      }

      console.log(`[Room ${roomId}] Race started with seed ${room.seed}`);
      io.to(roomId).emit('race-started', {
        seed: room.seed,
        players: serializePlayers(room),
      });
    });

    // Real-time movement & position update
    socket.on('player-update', payload => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const player = room.players.get(socket.id);
      if (!player) return;

      if (typeof payload.x === 'number') player.x = payload.x;
      if (typeof payload.y === 'number') player.y = payload.y;
      if (typeof payload.vx === 'number') player.vx = payload.vx;
      if (typeof payload.vy === 'number') player.vy = payload.vy;
      if (typeof payload.hidden === 'boolean') player.hidden = payload.hidden;
      if (typeof payload.weapon === 'string') player.weapon = payload.weapon;
      if (typeof payload.attack === 'number') player.attack = payload.attack;
      if (typeof payload.lives === 'number') player.lives = payload.lives;
      if (typeof payload.status === 'string') player.status = payload.status;
      if (typeof payload.progress === 'number') player.progress = payload.progress;

      // Broadcast position to other runners
      socket.to(roomId).emit('player-moved', {
        playerId: socket.id,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        hidden: player.hidden,
        weapon: player.weapon,
        attack: player.attack,
        lives: player.lives,
        status: player.status,
        progress: player.progress,
      });
    });

    // Combat attack event
    socket.on('player-attacked', payload => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      socket.to(roomId).emit('player-attacked', {
        attackerId: socket.id,
        weapon: payload.weapon,
        x: payload.x,
        y: payload.y,
        hidden: payload.hidden,
      });
    });

    // Weapon pickup event (prevents duplicate pickups)
    socket.on('pickup-collected', payload => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const pickupKey = payload.pickupId || `${payload.x}_${payload.weapon}`;
      if (room.collectedPickups.has(pickupKey)) {
        return; // Already picked up
      }
      room.collectedPickups.add(pickupKey);

      const player = room.players.get(socket.id);
      if (player && payload.weapon) {
        player.weapon = payload.weapon;
      }

      io.to(roomId).emit('pickup-collected', {
        playerId: socket.id,
        pickupId: pickupKey,
        weapon: payload.weapon,
      });
    });

    // Finish line crossed
    socket.on('player-finished', payload => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      if (room.finishers.includes(socket.id)) return;

      room.finishers.push(socket.id);
      const rank = room.finishers.length;

      const player = room.players.get(socket.id);
      if (player) {
        player.status = 'FINISHED';
        player.rank = rank;
        player.progress = 100;
      }

      io.to(roomId).emit('player-finished', {
        playerId: socket.id,
        rank,
        finishers: room.finishers,
      });

      // Check if race ends (top 3 finish or all runners finish)
      const totalPlayers = room.players.size;
      const finishedCount = room.finishers.length;
      if (rank >= 3 || finishedCount >= totalPlayers) {
        room.status = 'results';
        io.to(roomId).emit('race-ended', {
          finishers: room.finishers,
          players: serializePlayers(room),
        });
      }
    });

    // Replay / Reset race back to lobby (Host or player)
    socket.on('reset-race', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      room.status = 'lobby';
      room.finishers = [];
      room.collectedPickups = new Set();

      for (const p of room.players.values()) {
        p.lives = 5;
        p.progress = 0;
        p.status = 'RUNNING';
        p.weapon = 'unarmed';
        p.x = 0;
        p.y = 0;
        p.vx = 0;
        p.vy = 0;
        p.hidden = false;
        p.attack = 0;
        p.rank = null;
      }

      io.to(roomId).emit('room-reset', {
        status: 'lobby',
        players: serializePlayers(room),
      });
    });

    // Disconnect handler
    socket.on('disconnect', reason => {
      console.log(`[Socket Disconnected] ID: ${socket.id} (${reason})`);
      handlePlayerLeave(io, socket);
    });
  });

  server.listen(port, () => {
    console.log(`> Pixel Pursuit Multiplayer Server ready on http://${hostname}:${port}`);
  });
});
