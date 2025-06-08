const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');

const app = express();

// Create HTTP server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// MySQL connection configuration
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'gOkulnathalagesan08@',
  database: 'meetings_db',
};

// Initialize MySQL connection pool
let db;

async function initializeDatabase() {
  try {
    db = await mysql.createPool(dbConfig);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS meetings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room VARCHAR(255) NOT NULL,
        host_id VARCHAR(255) NOT NULL,
        host_name VARCHAR(255),
        title VARCHAR(255),
        details TEXT,
        participants JSON,
        screen_sharing_participant JSON,
        is_ended BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_room (room)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS participants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id VARCHAR(255) NOT NULL,
        participant_id VARCHAR(255) NOT NULL,
        participant_name VARCHAR(255),
        in_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        out_time TIMESTAMP NULL,
        FOREIGN KEY (room_id) REFERENCES meetings(room) ON DELETE CASCADE
      )
    `);
    console.log('Connected to MySQL database');
  } catch (error) {
    console.error('Database connection error:', error);
  }
}

initializeDatabase();

// Serve static files from 'public' directory
app.use(express.static('public'));

// Serve index.html for the root route (/) and /meet
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/meet', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Fetch recent meetings (handled by PHP in recent-meetings.php)
app.get('/api/recent-meetings', async (req, res) => {
  try {
    const sessionId = req.headers.cookie?.split(';').find((c) => c.trim().startsWith('PHPSESSID='))?.split('=')[1];
    if (!sessionId) {
      return res.status(401).json({ error: 'No session found' });
    }
    res.status(410).json({ error: 'Endpoint deprecated, use /contents/files/recent-meetings.php' });
  } catch (error) {
    console.error('Error in /api/recent-meetings:', error);
    res.status(500).json({ error: 'Failed to fetch recent meetings' });
  }
});

// Room data structure
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('check-room', async (room, cb) => {
    try {
      // Check if the meeting exists
      const [existenceRows] = await db.execute('SELECT 1 FROM meetings WHERE room = ?', [room]);
      if (existenceRows.length === 0) {
        cb({ exists: false, isEnded: false });
        return;
      }

      // If exists, get the is_ended status
      const [statusRows] = await db.execute('SELECT is_ended FROM meetings WHERE room = ?', [room]);
      if (statusRows.length > 0) {
        cb({ exists: true, isEnded: statusRows[0].is_ended });
      } else {
        // This case is unlikely since existence was confirmed, but handle for robustness
        cb({ exists: false, isEnded: false });
      }
    } catch (error) {
      console.error('Error checking room in database:', error);
      cb({ exists: false, isEnded: false });
    }
  });

  socket.on('join-room', async ({ room, name, sessionId, title, isVideoOn, isMicOn }, callback) => {
    try {
      let roomExistsInDb = false;
      const [rows] = await db.execute('SELECT is_ended, details, participants, screen_sharing_participant FROM meetings WHERE room = ?', [room]);

      // Check if the meeting is already ended
      if (rows.length > 0 && rows[0].is_ended) {
        if (callback) callback({ error: 'This meeting has already ended.' });
        return;
      }

      roomExistsInDb = rows.length > 0;

      if (!rooms.has(room)) {
        let meetingOptions = { lockMeeting: false, muteOnJoin: true, videoOffOnJoin: false };
        let users = [];
        let screenSharingParticipant = null;

        if (roomExistsInDb) {
          const { details, participants, screen_sharing_participant } = rows[0];
          try {
            meetingOptions = details ? JSON.parse(details) : meetingOptions;
          } catch { }
          try {
            if (participants) {
              users = Array.isArray(JSON.parse(participants)) ? JSON.parse(participants) : [];
            }
          } catch { }
          try {
            screenSharingParticipant = screen_sharing_participant ? JSON.parse(screen_sharing_participant) : null;
          } catch { }
        } else {
          await db.execute(
            'INSERT INTO meetings (room, host_id, host_name, title, details, participants, screen_sharing_participant) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [room, socket.id, name || 'Anonymous', title || `Room ${room}`, JSON.stringify(meetingOptions), JSON.stringify([]), null]
          );
        }

        rooms.set(room, {
          users,
          screenSharingParticipant,
          meetingOptions,
          endTimeout: null,
        });
      }

      const roomData = rooms.get(room);

      // Clear pending end timeout if someone rejoins
      if (roomData.endTimeout) {
        clearTimeout(roomData.endTimeout);
        roomData.endTimeout = null;
        console.log(`End timeout cleared because ${socket.id} rejoined ${room}`);
      }

      await db.execute('INSERT INTO participants (room_id, participant_id, participant_name) VALUES (?, ?, ?)', [
        room,
        socket.id,
        name || 'Anonymous',
      ]);

      if (roomData.meetingOptions.lockMeeting && !roomData.users.some((u) => u.id === socket.id)) {
        socket.emit('end-meeting', { reason: 'Meeting is locked' });
        if (callback) callback({ error: 'Meeting is locked' });
        return;
      }

      // Add user with media status
      roomData.users.push({
        id: socket.id,
        name: name || 'Anonymous',
        isMicOn: isMicOn ?? !roomData.meetingOptions.muteOnJoin, // Respect muteOnJoin
        isVideoOn: isVideoOn ?? !roomData.meetingOptions.videoOffOnJoin, // Respect videoOffOnJoin
        isHost: roomData.users.length === 0, // First user is host
      });

      socket.join(room);

      // Update participants in database
      await db.execute('UPDATE meetings SET participants = ? WHERE room = ?', [JSON.stringify(roomData.users), room]);

      // Broadcast user-connected with media status
      socket.to(room).emit('user-connected', {
        id: socket.id,
        name: name || 'Anonymous',
        isHost: roomData.users.length === 1, // First user is host
        isVideoOn: isVideoOn ?? !roomData.meetingOptions.videoOffOnJoin,
        isMicOn: isMicOn ?? !roomData.meetingOptions.muteOnJoin,
      });

      // Send all users with their media status to the new joiner
      const usersInRoom = roomData.users
        .filter((u) => u.id !== socket.id)
        .map((u) => ({
          id: u.id,
          name: u.name,
          isMicOn: u.isMicOn,
          isVideoOn: u.isVideoOn,
          isHost: u.isHost,
        }));

      const screenSharingParticipant = roomData.screenSharingParticipant
        ? { id: roomData.screenSharingParticipant.id, name: roomData.screenSharingParticipant.name }
        : null;

      socket.emit('all-users', usersInRoom, screenSharingParticipant);
      socket.emit('get-meeting-options', roomData.meetingOptions);

      if (callback) callback({ success: true, screenSharingParticipant });
    } catch (error) {
      console.error('Error in join-room:', error);
      socket.emit('error', { message: 'Database error' });
      if (callback) callback({ error: 'Database error' });
    }
  });

  socket.on('signal', ({ to, signal, name }) => {
    const room = Array.from(socket.rooms).find((r) => r !== socket.id);
    const roomData = rooms.get(room);
    io.to(to).emit('signal', {
      from: socket.id,
      signal,
      name: name || roomData?.users.find((u) => u.id === socket.id)?.name || 'Anonymous',
    });
  });

  socket.on('toggle-video', async ({ room, isVideoOn }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      const user = roomData.users.find((u) => u.id === socket.id);
      if (user) {
        user.isVideoOn = isVideoOn;
        // Update database
        await db.execute('UPDATE meetings SET participants = ? WHERE room = ?', [JSON.stringify(roomData.users), room]);
        // Broadcast to others
        socket.to(room).emit('user-toggled-video', { id: socket.id, isVideoOn });
      }
    }
  });

  socket.on('toggle-mic', async ({ room, isMicOn }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      const user = roomData.users.find((u) => u.id === socket.id);
      if (user) {
        user.isMicOn = isMicOn;
        // Update database
        await db.execute('UPDATE meetings SET participants = ? WHERE room = ?', [JSON.stringify(roomData.users), room]);
        // Broadcast to others
        socket.to(room).emit('mic-toggled', { id: socket.id, isMicOn });
      }
    }
  });

  socket.on('update-name', async ({ room, name }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      const user = roomData.users.find((u) => u.id === socket.id);
      if (user) {
        user.name = name || 'Anonymous';
        socket.to(room).emit('update-name', { participantId: socket.id, name });
        try {
          await db.execute('UPDATE meetings SET participants = ? WHERE room = ?', [JSON.stringify(roomData.users), room]);
          await db.execute(
            'UPDATE participants SET participant_name = ? WHERE room_id = ? AND participant_id = ? AND out_time IS NULL',
            [name || 'Anonymous', room, socket.id]
          );
        } catch (error) {
          console.error('Error updating participants in database:', error);
        }
      }
    }
  });

  socket.on('get-meeting-options', ({ room }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      socket.emit('get-meeting-options', roomData.meetingOptions);
    }
  });

  socket.on('update-meeting-options', async ({ room, lockMeeting, muteOnJoin, videoOffOnJoin }) => {
    const roomData = rooms.get(room);
    if (roomData && roomData.users[0]?.id === socket.id) {
      roomData.meetingOptions = { lockMeeting, muteOnJoin, videoOffOnJoin };
      socket.to(room).emit('update-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
      io.to(room).emit('apply-meeting-options', { lockMeeting, muteOnJoin, videoOffOnJoin });
      try {
        await db.execute('UPDATE meetings SET details = ? WHERE room = ?', [
          JSON.stringify({ lockMeeting, muteOnJoin, videoOffOnJoin }),
          room,
        ]);
      } catch (error) {
        console.error('Error updating meeting details in database:', error);
      }
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

  socket.on('screen-share', async ({ room, sharing, participantId }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      roomData.screenSharingParticipant = sharing
        ? { id: participantId, name: roomData.users.find((u) => u.id === participantId)?.name || 'Anonymous' }
        : null;
      try {
        await db.execute('UPDATE meetings SET screen_sharing_participant = ? WHERE room = ?', [
          JSON.stringify(roomData.screenSharingParticipant),
          room,
        ]);
      } catch (error) {
        console.error('Error updating screen_sharing_participant in database:', error);
      }
      socket.to(room).emit('screen-share', {
        participantId,
        sharing,
        name: roomData.screenSharingParticipant?.name || null,
      });
    }
  });

  socket.on('chat-message', ({ room, message, name }) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    socket.to(room).emit('chat-message', { name, message, time });
  });

  socket.on('reaction', ({ room, emoji, name }) => {
    socket.to(room).emit('reaction', { name, emoji });
  });

  socket.on('end-meeting', async ({ room }, callback) => {
    try {
      const roomData = rooms.get(room);
      if (!roomData) {
        callback?.({ error: 'Room does not exist' });
        return;
      }

      const isHost = roomData.users[0]?.id === socket.id;

      io.to(room).emit('end-meeting');

      await db.execute('UPDATE meetings SET is_ended = TRUE WHERE room = ?', [room]);
      await db.execute('UPDATE participants SET out_time = NOW() WHERE room_id = ? AND out_time IS NULL', [room]);

      if (roomData.endTimeout) {
        clearTimeout(roomData.endTimeout);
      }
      rooms.delete(room);

      console.log(`Meeting ${room} ended by host ${socket.id}`);

      callback?.({ success: true });
    } catch (error) {
      console.error('Error ending meeting:', error);
      callback?.({ error: 'Failed to end meeting' });
    }
  });

  socket.on('toggle-hand', ({ room, raised }) => {
    socket.to(room).emit('toggle-hand', { participantId: socket.id, raised });
  });

  socket.on('toggle-remote-mute', ({ room, participantId }) => {
    io.to(participantId).emit('toggle-remote-mute', { participantId });
  });

  socket.on('toggle-remote-video', ({ room, participantId }) => {
    io.to(participantId).emit('toggle-remote-video', { participantId });
  });

  socket.on('disconnect', async () => {
    for (const [room, roomData] of rooms.entries()) {
      const userIndex = roomData.users.findIndex((u) => u.id === socket.id);
      if (userIndex !== -1) {
        const userName = roomData.users[userIndex].name;
        roomData.users.splice(userIndex, 1);
        socket.to(room).emit('user-disconnected', socket.id);

        // Stop screen share if this user was sharing
        if (roomData.screenSharingParticipant?.id === socket.id) {
          roomData.screenSharingParticipant = null;
          socket.to(room).emit('screen-share', { participantId: socket.id, sharing: false });
          try {
            await db.execute('UPDATE meetings SET screen_sharing_participant = NULL WHERE room = ?', [room]);
          } catch (err) {
            console.error('Error clearing screen sharing participant:', err);
          }
        }

        try {
          await db.execute('UPDATE meetings SET participants = ? WHERE room = ?', [JSON.stringify(roomData.users), room]);
          await db.execute(
            'UPDATE participants SET out_time = NOW() WHERE room_id = ? AND participant_id = ? AND out_time IS NULL',
            [room, socket.id]
          );

          const [rows] = await db.execute('SELECT is_ended FROM meetings WHERE room = ?', [room]);
          const isEnded = rows.length > 0 && rows[0].is_ended;

          if (roomData.users.length === 0 && !isEnded) {
            setMeetingEndTimeout(room);
          }

        } catch (err) {
          console.error('Error on disconnect DB update:', err);
        }

        console.log(`User disconnected: ${socket.id} from room ${room} (${userName})`);
      }
    }
  });

});

function setMeetingEndTimeout(room) {
  const roomData = rooms.get(room);
  if (!roomData) return;

  // Clear any existing timeout to avoid duplicates
  if (roomData.endTimeout) {
    clearTimeout(roomData.endTimeout);
    roomData.endTimeout = null;
    console.log(`End timeout cleared because ${socket.id} rejoined ${room}`);
  }


  const timeoutDuration = 1 * 60 * 1000; // 1 minute

  roomData.endTimeout = setTimeout(async () => {
    try {
      const roomDataCheck = rooms.get(room);
      if (roomDataCheck && roomDataCheck.users.length === 0) {
        await db.execute('UPDATE meetings SET is_ended = TRUE WHERE room = ?', [room]);
        rooms.delete(room);
        console.log(`Meeting ${room} marked as ended after 1 minute of no activity`);
      }
    } catch (err) {
      console.error('Error ending meeting after timeout:', err);
    }
  }, timeoutDuration);

  console.log(`End timeout set for room ${room}`);
}


// Start server on HTTP
server.listen(3000, '0.0.0.0', () => {
  console.log('Server running at http://localhost:3000');
});