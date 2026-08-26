// ============================================================
// 白色失明文字麻将 - 信令服务器 (Signaling Server)
// 用法: node signaling-server.js [端口]
// 默认端口 8765
// ============================================================

const WebSocket = require('ws');

const PORT = parseInt(process.argv[2]) || 8765;
const wss = new WebSocket.Server({ port: PORT });

// 房间管理: roomId -> { players: Map<ws, playerInfo> }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: new Map() });
  }
  return rooms.get(roomId);
}

function getPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    isCreator: p.isCreator,
    seat: p.seat,
    ready: p.ready || false
  }));
}

function broadcastToRoom(room, message, excludeWs) {
  const data = JSON.stringify(message);
  room.players.forEach((info, ws) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function sendToPlayer(room, targetId, message) {
  const data = JSON.stringify(message);
  room.players.forEach((info, ws) => {
    if (info.id === targetId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (!msg.type) return;

    switch (msg.type) {
      case 'join-room': {
        const roomId = msg.roomId;
        const player = msg.player || {};
        const room = getRoom(roomId);

        // 如果这个连接已经在别的房间，先离开
        if (ws.roomId && ws.roomId !== roomId) {
          const oldRoom = rooms.get(ws.roomId);
          if (oldRoom) {
            oldRoom.players.delete(ws);
            broadcastToRoom(oldRoom, { type: 'room-update', players: getPlayerList(oldRoom) });
          }
        }

        ws.roomId = roomId;
        ws.playerId = player.id;

        // 分配座位
        let seat = player.seat;
        if (seat === undefined || seat === null) {
          const usedSeats = new Set(Array.from(room.players.values()).map(p => p.seat));
          for (let i = 0; i < 4; i++) {
            if (!usedSeats.has(i)) { seat = i; break; }
          }
        }

        room.players.set(ws, {
          id: player.id,
          name: player.name || '匿名',
          isCreator: !!player.isCreator,
          seat: seat,
          ready: false
        });

        // 告诉新玩家当前房间列表
        ws.send(JSON.stringify({
          type: 'room-joined',
          players: getPlayerList(room)
        }));

        // 广播给房间内其他人
        broadcastToRoom(room, {
          type: 'room-update',
          players: getPlayerList(room)
        }, ws);

        console.log(`[加入] 房间=${roomId} 玩家=${player.name} 座位=${seat}  当前${room.players.size}人`);
        break;
      }

      case 'ready-change': {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const info = room.players.get(ws);
        if (info) {
          info.ready = !!msg.ready;
          broadcastToRoom(room, {
            type: 'room-update',
            players: getPlayerList(room)
          });
        }
        break;
      }

      case 'p2p-offer': {
        if (!ws.roomId || !msg.targetId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        sendToPlayer(room, msg.targetId, {
          type: 'p2p-offer',
          fromId: ws.playerId,
          offer: msg.offer,
          targetId: msg.targetId
        });
        break;
      }

      case 'p2p-answer': {
        if (!ws.roomId || !msg.targetId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        sendToPlayer(room, msg.targetId, {
          type: 'p2p-answer',
          fromId: ws.playerId,
          answer: msg.answer,
          targetId: msg.targetId
        });
        break;
      }

      case 'p2p-ice': {
        if (!ws.roomId || !msg.targetId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        sendToPlayer(room, msg.targetId, {
          type: 'p2p-ice',
          fromId: ws.playerId,
          candidate: msg.candidate,
          targetId: msg.targetId
        });
        break;
      }

      case 'broadcast': {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        broadcastToRoom(room, {
          type: 'room-msg',
          fromId: ws.playerId,
          payload: msg.payload
        }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const info = room.players.get(ws);
    const name = info ? info.name : '未知';
    room.players.delete(ws);

    console.log(`[离开] 房间=${ws.roomId} 玩家=${name}  当前${room.players.size}人`);

    if (room.players.size === 0) {
      rooms.delete(ws.roomId);
      console.log(`[销毁] 房间=${ws.roomId} 已空`);
    } else {
      broadcastToRoom(room, {
        type: 'room-update',
        players: getPlayerList(room)
      });
    }
  });

  ws.on('error', () => {});
});

console.log('========================================');
console.log('  白色失明文字麻将 - 信令服务器已启动');
console.log('  端口: ' + PORT);
console.log('  本地地址: ws://localhost:' + PORT);
console.log('  用 ngrok 暴露: ngrok http ' + PORT);
console.log('  (ngrok 会给出 wss://xxx.ngrok-free.app 地址)');
console.log('========================================');
