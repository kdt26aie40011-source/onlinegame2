const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./src/rooms');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
// 絵（PNGのdata URL）を送るので、Socket.IOの受信上限を少し広げる
const io = new Server(server, { maxHttpBufferSize: 5e6 });
const rooms = new RoomManager(io);

app.use(express.static(PUBLIC_DIR));

app.post('/api/rooms', (req, res) => {
  const room = rooms.create();
  res.json({ roomId: room.id });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: '部屋が見つかりません' });
  res.json(room.publicInfo());
});

app.get('/r/:roomId', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'room.html'));
});

io.on('connection', (socket) => {
  // ack が無い・payload が壊れている呼び出しでも落ちないようにする
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        handler(payload && typeof payload === 'object' ? payload : {}, reply);
      } catch (err) {
        console.error(`[${event}]`, err);
        reply({ ok: false, error: 'サーバーでエラーが発生しました' });
      }
    });
  };

  const currentRoom = () => rooms.get(socket.data.roomId);

  on('join', ({ roomId, name, icon }, reply) => {
    if (socket.data.roomId) return reply({ ok: false, error: 'すでに入室しています' });
    const room = rooms.get(roomId);
    if (!room) return reply({ ok: false, error: '部屋が見つかりません' });
    const result = room.join(socket, name, icon);
    if (!result.ok) return reply(result);
    socket.data.roomId = room.id;
    socket.data.playerId = result.playerId;
    reply(result);
    room.broadcast();
  });

  // 以下はすべて「入室済みのプレイヤー」からの操作
  const action = (event, run) => {
    on(event, (payload, reply) => {
      const room = currentRoom();
      if (!room) return reply({ ok: false, error: '入室していません' });
      reply(run(room, socket.data.playerId, payload));
    });
  };

  action('settings:update', (room, pid, settings) => room.updateSettings(pid, settings));
  action('game:start', (room, pid) => room.startGame(pid));
  action('game:next', (room, pid) => room.next(pid));
  action('topic:submit', (room, pid, { topic }) => room.submitTopic(pid, topic));
  action('drawing:submit', (room, pid, { image }) => room.submitDrawing(pid, image));
  action('winner:select', (room, pid, { drawingId }) => room.selectWinner(pid, drawingId));
  action('drawing:like', (room, pid, { drawingId }) => room.like(pid, drawingId));

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (room) room.leave(socket.data.playerId);
  });
});

server.listen(PORT, () => {
  console.log(`うろドロ: http://localhost:${PORT}`);
});
