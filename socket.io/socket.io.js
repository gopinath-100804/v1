const { Server } = require('socket.io');
const server = require('http').createServer(); // Your HTTP server setup
const io = new Server(server, {
    cors: {
        origin: "https://10.0.14.159:3000",
        methods: ["GET", "POST"],
        credentials: true
    }
});

const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join-room', ({ roomId, userId, name, isMicOn, isCameraOn }) => {
        socket.join(roomId);
        let room = rooms.get(roomId) || { participants: new Map(), host: socket.id };
        room.participants.set(socket.id, { name, isMuted: !isMicOn, isVideoOn: isCameraOn, isHandRaised: false });
        rooms.set(roomId, room);

        io.to(roomId).emit('update-participants', {
            participants: Array.from(room.participants.entries()),
            host: room.host
        });

        socket.to(roomId).emit('user-connected', { userId: socket.id, name });
        socket.emit('existing-users', { participants: Array.from(room.participants.entries()).filter(([id]) => id !== socket.id) });
    });

    socket.on('offer', ({ offer, caller, target, roomId }) => {
        socket.to(target).emit('offer', { offer, caller, target });
    });

    socket.on('answer', ({ answer, caller, roomId }) => {
        socket.to(caller).emit('answer', { answer, target: socket.id, caller });
    });

    socket.on('ice-candidate', ({ candidate, target, roomId }) => {
        socket.to(target).emit('ice-candidate', { candidate, caller: socket.id, target });
    });

    socket.on('screen-share', ({ roomId, userId, isSharing }) => {
        socket.to(roomId).emit('screen-share', { userId, isSharing });
    });

    socket.on('update-participant-state', ({ roomId, userId, isMuted, isVideoOn, isHandRaised }) => {
        let room = rooms.get(roomId);
        if (room && room.participants.has(userId)) {
            const participant = room.participants.get(userId);
            if (isMuted !== undefined) participant.isMuted = isMuted;
            if (isVideoOn !== undefined) participant.isVideoOn = isVideoOn;
            if (isHandRaised !== undefined) participant.isHandRaised = isHandRaised;
            io.to(roomId).emit('update-participants', {
                participants: Array.from(room.participants.entries()),
                host: room.host
            });
        }
    });

    socket.on('leave-room', ({ roomId, userId }) => {
        let room = rooms.get(roomId);
        if (room) {
            room.participants.delete(userId);
            if (room.participants.size === 0) {
                rooms.delete(roomId);
            } else {
                rooms.set(roomId, room);
                io.to(roomId).emit('update-participants', {
                    participants: Array.from(room.participants.entries()),
                    host: room.host
                });
            }
        }
        socket.to(roomId).emit('user-disconnected', { userId, name: room?.participants.get(userId)?.name || 'Unknown' });
        socket.leave(roomId);
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => {
            if (room.participants.has(socket.id)) {
                room.participants.delete(socket.id);
                if (room.participants.size === 0) {
                    rooms.delete(roomId);
                } else {
                    io.to(roomId).emit('update-participants', {
                        participants: Array.from(room.participants.entries()),
                        host: room.host
                    });
                }
                socket.to(roomId).emit('user-disconnected', { userId: socket.id, name: room.participants.get(socket.id)?.name || 'Unknown' });
            }
        });
    });
});

server.listen(3000, () => console.log('Server running on https://10.0.14.159:3000'));