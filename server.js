// server.js - Node.js + Express + HTTPs + Socket.io

const fs = require('fs');
const https = require('https');
const express = require('express');
const app = express();
const { Server } = require('socket.io');

const options = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

const server = https.createServer(options, app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {}; // roomName: { socketId: username }

io.on('connection', socket => {
  socket.on('check-room', (room, cb) => {
    cb(rooms[room] ? true : false);
  });

  socket.on('join-room', ({ room, name }) => {
    if (!rooms[room]) rooms[room] = {};
    rooms[room][socket.id] = name;

    socket.join(room);

    // Inform existing users about the new user
    socket.to(room).emit('user-connected', { id: socket.id, name });

    // Send existing users to the new user
    const usersInRoom = Object.entries(rooms[room])
      .filter(([id]) => id !== socket.id)
      .map(([id, username]) => ({ id, name: username }));

    socket.emit('all-users', usersInRoom);

    // Handle signaling data
    socket.on('signal', data => {
      io.to(data.to).emit('signal', {
        from: socket.id,
        signal: data.signal,
        name: rooms[room][socket.id],
      });
    });

    socket.on('disconnect', () => {
      if (rooms[room]) {
        delete rooms[room][socket.id];
        socket.to(room).emit('user-disconnected', socket.id);

        if (Object.keys(rooms[room]).length === 0) {
          delete rooms[room];
        }
      }
    });
  });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Server running at https://10.0.14.159:3000');
});
