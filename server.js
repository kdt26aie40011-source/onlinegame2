const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./src/room');

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

// 絵の画像。IDは推測できないランダムな文字列で、部屋のゲーム中だけ取得できる
app.get('/api/rooms/:roomId/drawings/:drawingId.png', (req, res) => {
  const image = rooms.get(req.params.roomId)?.getImage(req.params.drawingId);
  if (!image) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('png').send(image);
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

  // 新しく入室する（join）か、2分以内に同じ席へ戻る（rejoin）
  const enter = (event, run) => {
    on(event, (payload, reply) => {
      if (socket.data.roomId) return reply({ ok: false, error: 'すでに入室しています' });
      const room = rooms.get(payload.roomId);
      if (!room) return reply({ ok: false, error: '部屋が見つかりません' });
      const result = run(room, payload);
      if (!result.ok) return reply(result);
      socket.data.roomId = room.id;
      socket.data.playerId = result.playerId;
      reply(result);
      room.broadcast();
    });
  };

  enter('join', (room, { name, icon, role }) => room.join(socket, name, icon, role));
  enter('rejoin', (room, { playerId, token }) => room.rejoin(socket, playerId, token));

  // 以下はすべて「入室済みのプレイヤー」からの操作
  const action = (event, run) => {
    on(event, (payload, reply) => {
      const room = currentRoom();
      if (!room) return reply({ ok: false, error: '入室していません' });
      reply(run(room, socket.data.playerId, payload));
    });
  };

  action('settings:update', (room, pid, settings) => room.updateSettings(pid, settings));
  action('role:switch', (room, pid, { role }) => room.switchRole(pid, role));
  action('game:start', (room, pid) => room.startGame(pid));
  action('game:next', (room, pid) => room.next(pid));
  action('topic:submit', (room, pid, { topic }) => room.gameAction('submitTopic', pid, topic));
  action('drawing:submit', (room, pid, { image }) => room.gameAction('submitDrawing', pid, image));
  action('winner:select', (room, pid, { drawingId }) => room.gameAction('selectWinner', pid, drawingId));
  action('drawing:rate', (room, pid, { kind, drawingId }) => room.gameAction('rate', pid, kind, drawingId));
  action('host:transfer', (room, pid, { playerId }) => room.transferHost(pid, playerId));
  action('room:close', (room, pid) => room.forceClose(pid));
  action('room:leave', (room, pid) => {
    socket.data.roomId = null;
    socket.leave(room.id);
    room.disconnect(pid);
    return { ok: true };
  });

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (room) room.disconnect(socket.data.playerId);
  });
});

server.listen(PORT, () => {
  console.log(`うろドロ: http://localhost:${PORT}`);
});
