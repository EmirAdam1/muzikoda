// MüzikOda v3
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════
// KALICI ODA AYARLARI — buradan değiştir
// ═══════════════════════════════════════
const PERMANENT_ROOM = {
  id: 'ana-oda',
  adminPass: 'emir2024',   // sadece yönetici bu şifreyle girer
  maxHistory: 50,
};

const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    const isPermanent = roomId === PERMANENT_ROOM.id;
    rooms[roomId] = {
      users: {},
      queue: [],
      cur: -1,
      playing: false,
      position: 0,
      posTimestamp: 0,
      pass: '',
      permanent: isPermanent,
      chatHistory: [],
      muted: [],
    };
  }
  return rooms[roomId];
}

// Kalıcı odayı başlangıçta oluştur
getRoom(PERMANENT_ROOM.id);

function getCurrentPosition(r) {
  if (!r.playing) return r.position;
  const elapsed = (Date.now() - r.posTimestamp) / 1000;
  return r.position + elapsed;
}

function addHistory(r, msg) {
  r.chatHistory.push(msg);
  if (r.chatHistory.length > PERMANENT_ROOM.maxHistory) r.chatHistory.shift();
}

io.on('connection', (socket) => {

  socket.on('join', ({ room, name, pass, create }) => {
    const isPermanent = room === PERMANENT_ROOM.id;
    const existing = rooms[room] && Object.keys(rooms[room].users).length > 0;

    if (create && !isPermanent && existing) {
      socket.emit('room-exists');
      return;
    }

    // Kalıcı odada şifre kontrolü: şifre varsa admin, yoksa normal üye
    let isAdmin = false;
    if (isPermanent) {
      if (pass && pass !== PERMANENT_ROOM.adminPass) {
        socket.emit('wrong-pass');
        return;
      }
      isAdmin = (pass === PERMANENT_ROOM.adminPass);
    } else {
      // Normal oda şifre kontrolü
      const r = getRoom(room);
      if (r.pass && r.pass !== (pass || '')) {
        socket.emit('wrong-pass');
        return;
      }
      if (!r.pass && pass) r.pass = pass;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;
    socket.data.isAdmin = isAdmin;

    const r = getRoom(room);
    r.users[socket.id] = { name, isAdmin };
    socket.data.muted = r.muted.includes(name);

    socket.emit('state', {
      users: Object.values(r.users).map(u => ({ name: u.name, isAdmin: u.isAdmin })),
      queue: r.queue,
      cur: r.cur,
      playing: r.playing,
      position: getCurrentPosition(r),
      serverTime: Date.now(),
      chatHistory: r.chatHistory,
      isPermanent,
      isAdmin,
      isMuted: socket.data.muted,
    });

    socket.to(room).emit('user-joined', { name, isAdmin });
    console.log(`[+] ${name}${isAdmin?' [YÖNETİCİ]':''} → #${room}`);
  });

  // Admin: kick
  socket.on('admin-kick', ({ targetName }) => {
    const { room } = socket.data;
    if (!room || !socket.data.isAdmin) return;
    const r = getRoom(room);
    const entry = Object.entries(r.users).find(([, u]) => u.name === targetName);
    if (!entry) return;
    io.to(entry[0]).emit('kicked');
    io.to(room).emit('sys-msg', { text: `${targetName} odadan atıldı.` });
  });

  // Admin: mesaj sil
  socket.on('admin-delete-msg', ({ msgId }) => {
    const { room } = socket.data;
    if (!room || !socket.data.isAdmin) return;
    const r = getRoom(room);
    r.chatHistory = r.chatHistory.filter(m => m.id !== msgId);
    io.to(room).emit('msg-deleted', { msgId });
  });

  // Admin: sustur / kaldır
  socket.on('admin-mute', ({ targetName, mute }) => {
    const { room } = socket.data;
    if (!room || !socket.data.isAdmin) return;
    const r = getRoom(room);
    if (mute) { if (!r.muted.includes(targetName)) r.muted.push(targetName); }
    else { r.muted = r.muted.filter(n => n !== targetName); }
    const entry = Object.entries(r.users).find(([, u]) => u.name === targetName);
    if (entry) io.to(entry[0]).emit('mute-status', { muted: mute });
    io.to(room).emit('sys-msg', { text: `${targetName} ${mute ? 'susturuldu' : 'susturması kaldırıldı'}.` });
  });

  socket.on('chat', ({ text }) => {
    const { room, name } = socket.data;
    if (!room) return;
    if (socket.data.muted) { socket.emit('sys-msg', { text: 'Susturuldunuz.' }); return; }
    const r = getRoom(room);
    const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name, text, ts: Date.now() };
    if (r.permanent) addHistory(r, msg);
    io.to(room).emit('chat', { name, text, msgId: msg.id, isAdmin: socket.data.isAdmin });
  });

  socket.on('add-song', ({ song }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    if (!r.queue.find(s => s.id === song.id)) {
      r.queue.push(song);
      socket.to(room).emit('add-song', { song, from: socket.data.name });
      if (r.cur === -1) { r.cur = 0; r.playing = true; r.position = 0; r.posTimestamp = Date.now(); }
    }
  });

  socket.on('play', ({ cur, position }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.cur = cur; r.playing = true; r.position = position || 0; r.posTimestamp = Date.now();
    socket.to(room).emit('play', { cur, position: r.position, serverTime: r.posTimestamp });
  });

  socket.on('pause', ({ position }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.playing = false; r.position = position || getCurrentPosition(r); r.posTimestamp = Date.now();
    socket.to(room).emit('pause', { position: r.position, serverTime: r.posTimestamp });
  });

  socket.on('seek', ({ position, cur }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.position = position; r.posTimestamp = Date.now(); r.cur = cur;
    socket.to(room).emit('seek', { position, cur, serverTime: r.posTimestamp });
  });

  socket.on('voice-join', () => {
    const { room } = socket.data;
    if (!room) return;
    socket.to(room).emit('voice-request-offer', { from: socket.id });
  });

  socket.on('offer',  ({ to, offer })     => { io.to(to).emit('offer',  { from: socket.id, offer }); });
  socket.on('answer', ({ to, answer })    => { io.to(to).emit('answer', { from: socket.id, answer }); });
  socket.on('ice',    ({ to, candidate }) => { io.to(to).emit('ice',    { from: socket.id, candidate }); });

  socket.on('speaking', ({ v }) => {
    const { room, name } = socket.data;
    if (!room) return;
    socket.to(room).emit('speaking', { name, v });
  });

  socket.on('disconnect', () => {
    const { room, name } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    delete r.users[socket.id];
    socket.to(room).emit('user-left', { name });
    if (!r.permanent && Object.keys(r.users).length === 0) delete rooms[room];
    console.log(`[-] ${name} ← #${room}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ MüzikOda sunucusu çalışıyor!`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🏠 Kalıcı oda: #${PERMANENT_ROOM.id}\n`);
});
