const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Statik dosyalar (index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Oda durumlarını hafızada tut
const rooms = {}; // roomId → { users: {socketId → {name}}, queue, cur, playing }

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { users: {}, queue: [], cur: -1, playing: false };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {

  // Odaya katıl
  socket.on('join', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    const r = getRoom(room);
    r.users[socket.id] = { name };

    // Yeni kullanıcıya mevcut durumu gönder
    socket.emit('state', {
      users: Object.values(r.users).map(u => u.name),
      queue: r.queue,
      cur: r.cur,
      playing: r.playing
    });

    // Odadakilere bildir
    socket.to(room).emit('user-joined', { name });

    console.log(`[+] ${name} → #${room} (toplam: ${Object.keys(r.users).length})`);
  });

  // Sohbet mesajı
  socket.on('chat', ({ text }) => {
    const { room, name } = socket.data;
    if (!room) return;
    socket.to(room).emit('chat', { name, text });
  });

  // Şarkı eklendi
  socket.on('add-song', ({ song }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    if (!r.queue.find(s => s.id === song.id)) {
      r.queue.push(song);
      socket.to(room).emit('add-song', { song, from: socket.data.name });
      if (r.cur === -1) { r.cur = 0; r.playing = true; }
    }
  });

  // Play / pause
  socket.on('play', ({ cur }) => {
    const { room } = socket.data;
    if (!room) return;
    const r = getRoom(room);
    r.cur = cur; r.playing = true;
    socket.to(room).emit('play', { cur });
  });

  socket.on('pause', () => {
    const { room } = socket.data;
    if (!room) return;
    getRoom(room).playing = false;
    socket.to(room).emit('pause');
  });

  // Ses kanalına katıldı — odadaki herkese bildir (offer alsınlar)
  socket.on('voice-join', () => {
    const { room } = socket.data;
    if (!room) return;
    // Odadaki diğer herkese: "bana offer gönder" de
    socket.to(room).emit('voice-request-offer', { from: socket.id });
  });

  // WebRTC sinyalleri (ses için)
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });
  socket.on('ice', ({ to, candidate }) => {
    io.to(to).emit('ice', { from: socket.id, candidate });
  });

  // Konuşma durumu
  socket.on('speaking', ({ v }) => {
    const { room, name } = socket.data;
    if (!room) return;
    socket.to(room).emit('speaking', { name, v });
  });

  // Bağlantı kesildi
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
  console.log(`🌐 Tarayıcıda aç: http://localhost:${PORT}`);
  console.log(`📡 Aynı Wi-Fi'dan erişim için IP adresini kullan\n`);
});
