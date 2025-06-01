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
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// MySQL connection configuration
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'gOkulnathalagesan08@',
  database: 'meetings_db'
};

// Initialize MySQL connection pool
let db;

async function initializeDatabase() {
  try {
    db = await mysql.createPool(dbConfig);
    
    // Create meetings table if it doesn't exist
    await db.execute(`
      CREATE TABLE IF NOT EXISTS meetings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room VARCHAR(255) NOT NULL,
        host_id VARCHAR(255) NOT NULL,
        host_name VARCHAR(255),
        title VARCHAR(255),
        details TEXT,
        participants JSON,
        is_ended BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_room (room)
      )
    `);

    // Create participants table if it doesn't exist
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
    const sessionId = req.headers.cookie?.split(';').find(c => c.trim().startsWith('PHPSESSID='))?.split('=')[1];
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
      const [rows] = await db.execute('SELECT 1 FROM meetings WHERE room = ?', [room]);
      cb(rows.length > 0);
    } catch (error) {
      console.error('Error checking room in database:', error);
      cb(false);
    }
  });

  socket.on('join-room', async ({ room, name, sessionId, title }, callback) => {
    // Check if room exists in database
    let roomExistsInDb = false;
    try {
      const [rows] = await db.execute('SELECT details, participants FROM meetings WHERE room = ?', [room]);
      roomExistsInDb = rows.length > 0;

      if (!rooms.has(room)) {
        // Initialize room in memory
        let meetingOptions = {
          lockMeeting: false,
          muteOnJoin: true,
          videoOffOnJoin: false,
        };
        let users = [];

        if (roomExistsInDb) {
          // Load existing room data from database
          const { details, participants } = rows[0];
          if (details) {
            try {
              meetingOptions = JSON.parse(details);
            } catch (error) {
              console.error('Error parsing meeting details from database:', error);
            }
          }
          if (participants) {
            try {
              users = JSON.parse(participants);
            } catch (error) {
              console.error('Error parsing participants from database:', error);
            }
          }
        } else {
          // Create new meeting in database
          await db.execute(
            'INSERT INTO meetings (room, host_id, host_name, title, details, participants) VALUES (?, ?, ?, ?, ?, ?)',
            [room, socket.id, name || 'Anonymous', title || `Room ${room}`, JSON.stringify(meetingOptions), JSON.stringify([])]
          );
        }

        rooms.set(room, {
          users,
          screenSharingParticipant: null,
          meetingOptions,
        });
      }

      // Add participant to database
      await db.execute(
        'INSERT INTO participants (room_id, participant_id, participant_name) VALUES (?, ?, ?)',
        [room, socket.id, name || 'Anonymous']
      );
    } catch (error) {
      console.error('Error checking/creating room or adding participant in database:', error);
      socket.emit('error', { message: 'Database error' });
      if (callback) callback({ error: 'Database error' });
      return;
    }

    const roomData = rooms.get(room);

    if (roomData.meetingOptions.lockMeeting && !roomData.users.some((user) => user.id === socket.id)) {
      socket.emit('end-meeting', { reason: 'Meeting is locked' });
      if (callback) callback({ error: 'Meeting is locked' });
      return;
    }

    roomData.users.push({ id: socket.id, name: name || 'Anonymous' });
    socket.join(room);

    // Update participants in database
    try {
      await db.execute(
        'UPDATE meetings SET participants = ? WHERE room = ?',
        [JSON.stringify(roomData.users), room]
      );
    } catch (error) {
      console.error('Error updating participants in database:', error);
    }

    socket.to(room).emit('user-connected', { id: socket.id, name });

    const usersInRoom = roomData.users
      .filter((user) => user.id !== socket.id)
      .map((user) => ({ id: user.id, name: user.name }));
    socket.emit('all-users', usersInRoom, roomData.screenSharingParticipant);

    socket.emit('get-meeting-options', roomData.meetingOptions);

    if (callback) callback({ success: true });
  });

  socket.on('signal', ({ to, signal, name }) => {
    const roomData = rooms.get(Array.from(socket.rooms).find(r => r !== socket.id));
    io.to(to).emit('signal', {
      from: socket.id,
      signal,
      name: name || roomData?.users.find((u) => u.id === socket.id)?.name || 'Anonymous',
    });
  });

  socket.on('update-name', async ({ room, name }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      const user = roomData.users.find((u) => u.id === socket.id);
      if (user) {
        user.name = name || 'Anonymous';
        socket.to(room).emit('update-name', { participantId: socket.id, name });
        // Update participants in database
        try {
          await db.execute(
            'UPDATE meetings SET participants = ? WHERE room = ?',
            [JSON.stringify(roomData.users), room]
          );
          // Update participant name in participants table
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
      // Update meeting details in database
      try {
        await db.execute(
          'UPDATE meetings SET details = ? WHERE room = ?',
          [JSON.stringify({ lockMeeting, muteOnJoin, videoOffOnJoin }), room]
        );
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

  socket.on('end-meeting', async ({ room }) => {
    const roomData = rooms.get(room);
    if (roomData && roomData.users[0]?.id === socket.id) {
      io.to(room).emit('end-meeting', { reason: 'Meeting ended by host' });
      // Update meeting as ended
      try {
        await db.execute('UPDATE meetings SET is_ended = TRUE WHERE room = ?', [room]);
      } catch (error) {
        console.error('Error updating meeting status in database:', error);
      }
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

  socket.on('disconnect', async () => {
    rooms.forEach(async (roomData, room) => {
      const userIndex = roomData.users.findIndex((u) => u.id === socket.id);
      if (userIndex !== -1) {
        const userName = roomData.users[userIndex].name;
        roomData.users.splice(userIndex, 1);
        socket.to(room).emit('user-disconnected', socket.id);
        if (roomData.screenSharingParticipant?.id === socket.id) {
          roomData.screenSharingParticipant = null;
          socket.to(room).emit('screen-share', { participantId: socket.id, sharing: false });
        }
        // Update participants in database
        try {
          await db.execute(
            'UPDATE meetings SET participants = ? WHERE room = ?',
            [JSON.stringify(roomData.users), room]
          );
          // Update out_time in participants table
          await db.execute(
            'UPDATE participants SET out_time = NOW() WHERE room_id = ? AND participant_id = ? AND out_time IS NULL',
            [room, socket.id]
          );
          // If no users remain, mark meeting as ended
          if (roomData.users.length === 0) {
            await db.execute('UPDATE meetings SET is_ended = TRUE WHERE room = ?', [room]);
            rooms.delete(room);
          }
        } catch (error) {
          console.error('Error updating participants or meeting status in database:', error);
        }
        console.log(`User disconnected: ${socket.id} from room ${room} (${userName})`);
      }
    });
  });
});

// Start server on HTTP
server.listen(3000, '0.0.0.0', () => {
  console.log('Server running at http://localhost:3000');
});

 