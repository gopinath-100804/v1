// server.js - Node.js + Express + HTTPS + Socket.IO

const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();

// HTTPS certificate options
const options = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

// Create HTTPS server
const server = http.createServer(options, app);
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust for production (e.g., specify client URL)
    methods: ["GET", "POST"],
  },
});

// Serve static files from 'public' directory
app.use(express.static('public'));

// Room data structure: { room: { users: [{ id, name }], screenSharingParticipant: { id, name } | null, meetingOptions: { lockMeeting, muteOnJoin, videoOffOnJoin } } }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Check if room exists
  socket.on('check-room', (room, cb) => {
    cb(rooms.has(room));
  });

  // Handle joining a room
  socket.on('join-room', ({ room, name }, callback) => {
    if (!rooms.has(room)) {
      rooms.set(room, {
        users: [],
        screenSharingParticipant: null,
        meetingOptions: {
          lockMeeting: false,
          muteOnJoin: true,
          videoOffOnJoin: false,
        },
      });
    }

    const roomData = rooms.get(room);

    // Check if meeting is locked
    if (roomData.meetingOptions.lockMeeting && !roomData.users.some((user) => user.id === socket.id)) {
      socket.emit('end-meeting', { reason: 'Meeting is locked' });
      if (callback) callback({ error: 'Meeting is locked' });
      return;
    }

    // Add user to room
    roomData.users.push({ id: socket.id, name: name || 'Anonymous' });
    socket.join(room);

    // Inform existing users about the new user
    socket.to(room).emit('user-connected', { id: socket.id, name });

    // Send existing users and screen-sharing info to the new user
    const usersInRoom = roomData.users
      .filter((user) => user.id !== socket.id)
      .map((user) => ({ id: user.id, name: user.name }));
    socket.emit('all-users', usersInRoom, roomData.screenSharingParticipant);

    // Send current meeting options to the new user
    socket.emit('get-meeting-options', roomData.meetingOptions);

    // Acknowledge successful join
    if (callback) callback({ success: true });

    // Handle WebRTC signaling
    socket.on('signal', ({ to, signal, name }) => {
      io.to(to).emit('signal', {
        from: socket.id,
        signal,
        name: name || roomData.users.find((u) => u.id === socket.id)?.name || 'Anonymous',
      });
    });

    // Handle name updates
    socket.on('update-name', ({ room, name }) => {
      const roomData = rooms.get(room);
      if (roomData) {
        const user = roomData.users.find((u) => u.id === socket.id);
        if (user) {
          user.name = name || 'Anonymous';
          socket.to(room).emit('update-name', { participantId: socket.id, name });
        }
      }
    });

    // Handle meeting options retrieval
    socket.on('get-meeting-options', ({ room }) => {
      const roomData = rooms.get(room);
      if (roomData) {
        socket.emit('get-meeting-options', roomData.meetingOptions);
      }
    });

    // Handle meeting options updates (host only)
    socket.on('update-meeting-options', ({ room, lockMeeting, muteOnJoin, videoOffOnJoin }) => {
      const roomData = rooms.get(room);
      if (roomData && roomData.users[0]?.id === socket.id) { // First user is host
        roomData.meetingOptions = { lockMeeting, muteOnJoin, videoOffOnJoin };
        socket.to(room).emit('update-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
        io.to(room).emit('apply-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
      } else {
        socket.emit('error', { message: 'Only the host can update meeting options' });
      }
    });

    // Handle applying meeting options to a specific participant
    socket.on('apply-meeting-options', ({ room, participantId, lockMeeting, muteOnJoin, videoOffOnJoin }) => {
      io.to(participantId).emit('apply-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
    });

    // Handle captions
    socket.on('caption', ({ room, text, participantId }) => {
      socket.to(room).emit('caption', { text, participantId });
    });

    // Handle language interpretation
    socket.on('start-interpretation', ({ room, language, participantId }) => {
      socket.to(room).emit('start-interpretation', { language, participantId });
    });

    // Handle screen sharing
    socket.on('screen-share', ({ room, sharing, participantId }) => {
      const roomData = rooms.get(room);
      if (roomData) {
        roomData.screenSharingParticipant = sharing
          ? { id: participantId, name: roomData.users.find((u) => u.id === participantId)?.name || 'Anonymous' }
          : null;
        socket.to(room).emit('screen-share', { participantId, sharing });
      }
    });

    // Handle chat messages
    socket.on('chat-message', ({ room, message, name }) => {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      socket.to(room).emit('chat-message', { name, message, time });
    });

    // Handle reactions
    socket.on('reaction', ({ room, emoji, name }) => {
      socket.to(room).emit('reaction', { name, emoji });
    });

    // Handle meeting end (host only)
    socket.on('end-meeting', ({ room }) => {
      const roomData = rooms.get(room);
      if (roomData && roomData.users[0]?.id === socket.id) { // First user is host
        io.to(room).emit('end-meeting', { reason: 'Meeting ended by host' });
        rooms.delete(room);
      }
    });

    // Handle hand raise
    socket.on('toggle-hand', ({ room, raised }) => {
      socket.to(room).emit('toggle-hand', { participantId: socket.id, raised });
    });

    // Handle mic toggle
    socket.on('toggle-mic', ({ room, micOn }) => {
      socket.to(room).emit('toggle-mic', { participantId: socket.id, micOn });
    });

    // Handle camera toggle
    socket.on('toggle-camera', ({ room, cameraOn }) => {
      socket.to(room).emit('toggle-camera', { participantId: socket.id, cameraOn });
    });

    // Handle recording toggle
    socket.on('toggle-recording', ({ room, recording }) => {
      socket.to(room).emit('toggle-recording', { participantId: socket.id, recording });
    });

    // Handle remote mute
    socket.on('toggle-remote-mute', ({ room, participantId }) => {
      io.to(participantId).emit('toggle-remote-mute', { participantId });
    });

    // Handle remote video toggle
    socket.on('toggle-remote-video', ({ room, participantId }) => {
      io.to(participantId).emit('toggle-remote-video', { participantId });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      rooms.forEach((roomData, room) => {
        const userIndex = roomData.users.findIndex((u) => u.id === socket.id);
        if (userIndex !== -1) {
          const userName = roomData.users[userIndex].name;
          roomData.users.splice(userIndex, 1);
          socket.to(room).emit('user-disconnected', socket.id);
          if (roomData.screenSharingParticipant?.id === socket.id) {
            roomData.screenSharingParticipant = null;
            socket.to(room).emit('screen-share', { participantId: socket.id, sharing: false });
          }
          if (roomData.users.length === 0) {
            rooms.delete(room);
          }
          console.log(`User disconnected: ${socket.id} from room ${room} (${userName})`);
        }
      });
    });
  });
});

// Start server
server.listen(3000, '0.0.0.0', () => {
  console.log('Server running at http://localhost:3000');
});
