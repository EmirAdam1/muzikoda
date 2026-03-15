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

const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      users: {},
      queue: [],
      cur: -1,
      playing: false,
      position: 0,
      posTimestamp: 0,
      pass: '',
    };
  }
  return rooms[roomId];
}

// Odanın şu anki gerçek pozisyonunu hesapla
function getCurrentPosition(r) {
  if (!r.playing) return r.position;
  const elapsed = (Date.now() - r.posTimestamp) / 1000;
  return r.position + elapsed;
}

io.on('connection', (socket) => {

  socket.on('join', ({ room, name, pass, create }) => {
    const existing = rooms[room] && Object.keys(rooms[room].users).length > 0;

    // Oda kur modunda ama oda zaten varsa hata döndür
    if(create && existing) {
      socket.emit('room-exists');
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    const r = getRoom(room);

    // Şifre kontrolü
    if(r.pass && r.pass !== (pass||'')) {
      socket.emit('wrong-pass');
      socket.leave(room);
      socket.data.room = null;
      return;
    }
    // Oda yeni oluşturuluyorsa şifreyi kaydet
    if(!r.pass && pass) r.pass = pass;

    r.users[socket.id] = { name };

    socket.emit('state', {
      users: Object.values(r.users).map(u => u.name),
      queue: r.queue,
      cur: r.cur,
      playing: r.playing,
      position: getCurrentPosition(r),
      serverTime: Date.now(),
    });

    socket.to(room).emit('user-joined', { name });
    console.log(`[+] ${name} → #${room}`);
  });

  socket.on('chat', ({ text }) => {
    const { room, name } = socket.data;
    if (!room) return;
    socket.to(room).emit('chat', { name, text });
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

  // Play — pozisyon + sunucu zamanı ile birlikte
  socket.on('play', ({ cur, position }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.cur = cur;
    r.playing = true;
    r.position = position || 0;
    r.posTimestamp = Date.now();
    // serverTime ekle — alıcı gecikmeyi hesaplayabilsin
    socket.to(room).emit('play', { cur, position: r.position, serverTime: r.posTimestamp });
  });

  // Pause — pozisyon + sunucu zamanı
  socket.on('pause', ({ position }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.playing = false;
    r.position = position || getCurrentPosition(r);
    r.posTimestamp = Date.now();
    socket.to(room).emit('pause', { position: r.position, serverTime: r.posTimestamp });
  });

  // Seek
  socket.on('seek', ({ position, cur }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.position = position;
    r.posTimestamp = Date.now();
    r.cur = cur;
    socket.to(room).emit('seek', { position, cur, serverTime: r.posTimestamp });
  });

  socket.on('voice-join', () => {
    const { room } = socket.data;
    if (!room) return;
    socket.to(room).emit('voice-request-offer', { from: socket.id });
  });

  socket.on('offer', ({ to, offer }) => { io.to(to).emit('offer', { from: socket.id, offer }); });
  socket.on('answer', ({ to, answer }) => { io.to(to).emit('answer', { from: socket.id, answer }); });
  socket.on('ice', ({ to, candidate }) => { io.to(to).emit('ice', { from: socket.id, candidate }); });

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
    if (Object.keys(r.users).length === 0) delete rooms[room];
    console.log(`[-] ${name} ← #${room}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ MüzikOda sunucusu çalışıyor!`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});
