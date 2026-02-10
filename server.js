const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e7, // 10MB limit for images
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

let users = {};
let pinnedMessage = null; 

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Setup User (Random Color/Position)
    users[socket.id] = {
        username: "Soul",
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        x: (Math.random() * 60) - 30,
        y: (Math.random() * 20) + 5,
        z: (Math.random() * 30) - 20
    };

    // 2. Send current state
    socket.emit('updateUsers', users);
    if (pinnedMessage) {
        socket.emit('updatePinned', pinnedMessage);
    }

    // 3. Handle Join
    socket.on('join', (username) => {
        if(users[socket.id]) {
            users[socket.id].username = username;
            io.emit('updateUsers', users);
            io.emit('chatMessage', {
                user: 'SYSTEM',
                text: `${username} ENTERED THE REALM`,
                type: 'bot',
                msgId: Date.now()
            });
        }
    });

    // 4. Handle Chat
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user && user.username) {
            io.emit('chatMessage', {
                user: user.username,
                text: data.text || null,
                file: data.file || null,
                replyTo: data.replyTo || null,
                type: 'user',
                id: socket.id,
                msgId: Date.now()
            });
        }
    });

    // 5. Handle Pin
    socket.on('pinMessage', (msgData) => {
        pinnedMessage = msgData;
        io.emit('updatePinned', pinnedMessage);
    });

    // 6. Handle Unpin
    socket.on('unpinMessage', () => {
        pinnedMessage = null;
        io.emit('updatePinned', null);
    });

    // 7. Handle Disconnect
    socket.on('disconnect', () => {
        if (users[socket.id]) {
            const name = users[socket.id].username;
            delete users[socket.id];
            io.emit('updateUsers', users);
            io.emit('chatMessage', { 
                user: 'SYSTEM', 
                text: `${name} FADED AWAY`, 
                type: 'bot',
                msgId: Date.now()
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});