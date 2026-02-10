const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8,
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

let users = {};
let pinnedMessages = []; 
let chatHistory = []; 

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    users[socket.id] = {
        username: "Soul",
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        x: (Math.random() * 60) - 30,
        y: (Math.random() * 20) + 5,
        z: (Math.random() * 30) - 20
    };

    socket.emit('updateUsers', users);
    socket.emit('updatePinned', pinnedMessages);
    socket.emit('history', chatHistory);

    socket.on('join', (username) => {
        if(users[socket.id]) {
            users[socket.id].username = username;
            io.emit('updateUsers', users);
            
            const sysMsg = {
                user: 'System',
                text: `${username} entered Zion`,
                type: 'bot',
                msgId: Date.now() + Math.random()
            };
            chatHistory.push(sysMsg);
            if(chatHistory.length > 50) chatHistory.shift();
            io.emit('chatMessage', sysMsg);
        }
    });

    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user && user.username) {
            const newMsg = {
                user: user.username,
                text: data.text || null,
                files: data.files || [],
                replyTo: data.replyTo || null,
                type: 'user',
                id: socket.id,
                msgId: Date.now() + Math.random()
            };
            
            chatHistory.push(newMsg);
            if(chatHistory.length > 50) chatHistory.shift();

            io.emit('chatMessage', newMsg);
        }
    });

    socket.on('typing', () => {
        const user = users[socket.id];
        if(user && user.username !== "Soul") {
            socket.broadcast.emit('userTyping', user.username);
        }
    });

    socket.on('stopTyping', () => {
        const user = users[socket.id];
        if(user) socket.broadcast.emit('userStoppedTyping', user.username);
    });

    socket.on('pinMessage', (msgData) => {
        const exists = pinnedMessages.find(m => m.msgId === msgData.msgId);
        const user = users[socket.id];
        
        if(!exists && user) {
            pinnedMessages.push(msgData);
            if(pinnedMessages.length > 50) pinnedMessages.shift();
            
            io.emit('updatePinned', pinnedMessages);
            
            const sysMsg = {
                user: 'System',
                text: `${user.username} pinned a message`,
                type: 'bot',
                msgId: Date.now() + Math.random()
            };
            chatHistory.push(sysMsg);
            io.emit('chatMessage', sysMsg);
        }
    });

    socket.on('unpinMessage', (msgId) => {
        pinnedMessages = pinnedMessages.filter(m => m.msgId !== msgId);
        io.emit('updatePinned', pinnedMessages);
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            const name = users[socket.id].username;
            delete users[socket.id];
            io.emit('updateUsers', users);
            
            const sysMsg = { user: 'System', text: `${name} left Zion`, type: 'bot', msgId: Date.now() };
            chatHistory.push(sysMsg);
            if(chatHistory.length > 50) chatHistory.shift();
            io.emit('chatMessage', sysMsg);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});