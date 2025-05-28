const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();

// Create HTTP server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from 'public' directory
app.use(express.static('public'));

// Serve index.html for the root route (/) and /meet
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/meet', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Room data structure
const rooms = new Map();

// Validate PHP session
async function validateSession(sessionId) {
  try {
    const response = await axios.get('https://localhost/get-session.php', {
      headers: { 'Cookie': `PHPSESSID=${sessionId}` },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false // Allow self-signed certificates (remove in production)
      })
    });
    return response.data.username || null;
  } catch (error) {
    console.error('Error validating session:', error.message);
    return null;
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('check-room', (room, cb) => {
    cb(rooms.has(room));
  });

  socket.on('join-room', async ({ room, name, sessionId }, callback) => {
    // Validate session
    const sessionUsername = await validateSession(sessionId);
    if (!sessionUsername || sessionUsername === 'Anonymous') {
      socket.emit('error', { message: 'Invalid session. Please log in.' });
      if (callback) callback({ error: 'Invalid session. Please log in.' });
      return;
    }

    // Ensure the provided name matches the session username
    if (name && name !== sessionUsername) {
      socket.emit('error', { message: 'Name does not match session username.' });
      if (callback) callback({ error: 'Name does not match session username.' });
      return;
    }

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

    if (roomData.meetingOptions.lockMeeting && !roomData.users.some((user) => user.id === socket.id)) {
      socket.emit('end-meeting', { reason: 'Meeting is locked' });
      if (callback) callback({ error: 'Meeting is locked' });
      return;
    }

    const userName = sessionUsername || 'Anonymous'; // Use session username
    roomData.users.push({ id: socket.id, name: userName });
    socket.join(room);

    socket.to(room).emit('user-connected', { id: socket.id, name: userName });

    const usersInRoom = roomData.users
      .filter((user) => user.id !== socket.id)
      .map((user) => ({ id: user.id, name: user.name }));
    socket.emit('all-users', usersInRoom, roomData.screenSharingParticipant);

    socket.emit('get-meeting-options', roomData.meetingOptions);

    if (callback) callback({ success: true });

    socket.on('signal', ({ to, signal, name }) => {
      io.to(to).emit('signal', {
        from: socket.id,
        signal,
        name: name || roomData.users.find((u) => u.id === socket.id)?.name || 'Anonymous',
      });
    });

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

    socket.on('get-meeting-options', ({ room }) => {
      const roomData = rooms.get(room);
      if (roomData) {
        socket.emit('get-meeting-options', roomData.meetingOptions);
      }
    });

    socket.on('update-meeting-options', ({ room, lockMeeting, muteOnJoin, videoOffOnJoin }) => {
      const roomData = rooms.get(room);
      if (roomData && roomData.users[0]?.id === socket.id) {
        roomData.meetingOptions = { lockMeeting, muteOnJoin, videoOffOnJoin };
        socket.to(room).emit('update-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
        io.to(room).emit('apply-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
      } else {
        socket.emit('error', { message: 'Only the host can update meeting options' });
      }
    });

    socket.on('apply-meeting-options', ({ room, participantId, lockMeeting, muteOnJoin, videoOffOnJoin }) => {
      io.to(participantId).emit('apply-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
    });

    socket.on('caption', ({ room, text, participantId }) => {
      socket.to(room).emit('caption', { text, participantId });
    });

    socket.on('start-interpretation', ({ room, language, participantId }) => {
      socket.to(room).emit('start-interpretation', { language, participantId });
    });

    socket.on('screen-share', ({ room, sharing, participantId }) => {
      const roomData = rooms.get(room);
      if (roomData) {
        roomData.screenSharingParticipant = sharing
          ? { id: participantId, name: roomData.users.find((u) => u.id === participantId)?.name || 'Anonymous' }
          : null;
        socket.to(room).emit('screen-share', { participantId, sharing });
      }
    });

    socket.on('chat-message', ({ room, message, name }) => {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      socket.to(room).emit('chat-message', { name, message, time });
    });

    socket.on('reaction', ({ room, emoji, name }) => {
      socket.to(room).emit('reaction', { name, emoji });
    });

    socket.on('end-meeting', ({ room }) => {
      const roomData = rooms.get(room);
      if (roomData && roomData.users[0]?.id === socket.id) {
        io.to(room).emit('end-meeting', { reason: 'Meeting ended by host' });
        rooms.delete(room);
      }
    });

    socket.on('toggle-hand', ({ room, raised }) => {
      socket.to(room).emit('toggle-hand', { participantId: socket.id, raised });
    });

    socket.on('toggle-mic', ({ room, micOn }) => {
      socket.to(room).emit('toggle-mic', { participantId: socket.id, micOn });
    });

    socket.on('toggle-camera', ({ room, cameraOn }) => {
      socket.to(room).emit('toggle-camera', { participantId: socket.id, cameraOn });
    });

    socket.on('toggle-recording', ({ room, recording }) => {
      socket.to(room).emit('toggle-recording', { participantId: socket.id, recording });
    });

    socket.on('toggle-remote-mute', ({ room, participantId }) => {
      io.to(participantId).emit('toggle-remote-mute', { participantId });
    });

    socket.on('toggle-remote-video', ({ room, participantId }) => {
      io.to(participantId).emit('toggle-remote-video', { participantId });
    });

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

  // Handle schedule-meeting event
  socket.on('schedule-meeting', ({ room, title, date, time, duration, invitees }, callback) => {
    console.log(`Scheduled meeting: ${title} at ${date} ${time} for ${duration} with invitees: ${invitees.join(', ')}`);
    if (callback) callback({ success: true, room });
  });

  // Handle send-invites event
  socket.on('send-invites', ({ emails, link }, callback) => {
    console.log(`Sending invites to: ${emails.join(', ')} with link: ${link}`);
    if (callback) callback({ success: true });
  });
});

// Start server on HTTP
server.listen(3000, '0.0.0.0', () => {
  console.log('Server running at http://localhost:3000');
});