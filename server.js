require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 1e8, cors: { origin: "*" } });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dns = require('dns');
const path = require('path'); // Added path module

try { dns.setServers(['8.8.8.8', '8.8.4.4']); } catch (e) { console.log("DNS settings skipped"); }

// --- KEY CHANGE: Serve only the 'public' folder ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://admin:Maximum2Rumba@zion0.0kybtmc.mongodb.net/?appName=Zion0";
let isDbConnected = false;

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB (Online Mode)');
        isDbConnected = true;
        try {
            const pins = await Message.find({ isPinned: true }).sort({ timestamp: 1 });
            pinnedMessages = pins;
            console.log(`📍 Loaded ${pins.length} pinned messages`);
        } catch (e) { console.error("Failed to load pins:", e); }
    })
    .catch(err => {
        console.log('⚡ Starting in OFFLINE MODE');
        isDbConnected = false;
    });

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    color: { type: String, default: '#007AFF' },
    pfp: { type: String, default: '' }, 
    bio: { type: String, default: 'No bio written.' },
    location: { type: String, default: 'Unknown' },
    status: { type: String, default: 'Online' },
    bgImage: { type: String, default: '' },
    font: { type: String, default: 'sans-serif' },
    textColor: { type: String, default: '#ffffff' },
    customCss: { type: String, default: '' },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    z: { type: Number, default: 0 }
});

const MessageSchema = new mongoose.Schema({
    user: String,
    userPfp: { type: String, default: '' },
    userColor: { type: String, default: '#007AFF' },
    toUser: { type: String, default: null },
    text: String,
    files: Array,
    replyTo: Object,
    type: { type: String, default: 'user' },
    timestamp: { type: Date, default: Date.now },
    isPinned: { type: Boolean, default: false }
});

const User = mongoose.model('User', UserSchema);
const Message = mongoose.model('Message', MessageSchema);

let localUsers = {}; 
let activeUsers = {}; 
let pinnedMessages = []; 
let chatHistory = []; 

// Explicit route to ensure index.html serves correctly on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', async (socket) => {
    console.log('User connected:', socket.id);

    socket.emit('updatePinned', pinnedMessages);
    
    socket.on('login', async ({ username, password }) => {
        try {
            let userData = null;
            let isNewAccount = false;

            if (isDbConnected) {
                let user = await User.findOne({ username });
                if (user) {
                    const isMatch = await bcrypt.compare(password, user.password);
                    if (!isMatch) { socket.emit('loginError', 'Incorrect password'); return; }
                    userData = user;
                } else {
                    const hashed = await bcrypt.hash(password, 10);
                    const newUser = new User({
                        username, password: hashed,
                        x: (Math.random()*60)-30, y: (Math.random()*20)+5, z: (Math.random()*30)-20
                    });
                    userData = await newUser.save();
                    isNewAccount = true;
                }
            } else {
                if (localUsers[username]) {
                    const isMatch = await bcrypt.compare(password, localUsers[username].password);
                    if (!isMatch) { socket.emit('loginError', 'Incorrect password (Offline)'); return; }
                    userData = localUsers[username];
                } else {
                    const hashed = await bcrypt.hash(password, 10);
                    userData = {
                        username, password: hashed,
                        color: '#007AFF', pfp: '',
                        x: (Math.random()*60)-30, y: (Math.random()*20)+5, z: (Math.random()*30)-20,
                        bio: 'No bio.', location: 'Unknown', status: 'Online',
                        bgImage: '', font: 'sans-serif', textColor: '#ffffff', customCss: ''
                    };
                    localUsers[username] = userData;
                    isNewAccount = true;
                }
            }

            socket.join(userData.username);
            activeUsers[socket.id] = {
                username: userData.username,
                color: userData.color,
                pfp: userData.pfp,
                bio: userData.bio, location: userData.location, status: userData.status,
                bgImage: userData.bgImage, font: userData.font, textColor: userData.textColor, customCss: userData.customCss,
                x: userData.x, y: userData.y, z: userData.z,
                windowFocus: true
            };

            socket.emit('loginSuccess', activeUsers[socket.id]); 
            io.emit('updateUsers', activeUsers);
            
            if (isDbConnected) {
                try {
                    const specificHistory = await Message.find({
                        $or: [
                            { toUser: null }, 
                            { toUser: userData.username },
                            { user: userData.username, toUser: { $ne: null } }
                        ]
                    }).sort({ timestamp: -1 }).limit(20); 
                    socket.emit('history', specificHistory.reverse());
                } catch (e) { console.error(e); }
            } else {
                socket.emit('history', chatHistory);
            }

            if (isNewAccount) {
                const sysMsgData = { user: 'System', text: `${userData.username} has registered a new account`, type: 'bot', timestamp: Date.now() };
                if (isDbConnected) { const m = new Message(sysMsgData); await m.save(); }
                io.emit('chatMessage', { ...sysMsgData, msgId: Date.now() + Math.random(), toUser: null });
            }

        } catch (e) {
            console.error(e);
            socket.emit('loginError', 'Server error');
        }
    });

    socket.on('updateProfile', async (data) => {
        const u = activeUsers[socket.id];
        if (u) {
            Object.assign(u, data);
            if (isDbConnected) await User.updateOne({ username: u.username }, data);
            io.emit('updateUsers', activeUsers);
        }
    });

    socket.on('getUserProfile', async (targetUsername) => {
        try {
            const active = Object.values(activeUsers).find(u => u.username === targetUsername);
            if (active) {
                socket.emit('userProfileData', { ...active, status: 'Online' });
                return;
            }
            let userRecord = null;
            if (isDbConnected) userRecord = await User.findOne({ username: targetUsername }).select('-password');
            else userRecord = localUsers[targetUsername];
            
            if (userRecord) {
                const profileData = { ... (userRecord.toObject ? userRecord.toObject() : userRecord), status: 'Offline' };
                socket.emit('userProfileData', profileData);
            } else {
                socket.emit('userProfileData', null);
            }
        } catch(e) { socket.emit('userProfileData', null); }
    });

    socket.on('userFocus', (isFocused) => {
        const u = activeUsers[socket.id];
        if(u) {
            u.windowFocus = isFocused;
            socket.broadcast.emit('updateUserStatus', { username: u.username, windowFocus: isFocused });
        }
    });

    socket.on('chatMessage', async (data) => {
        const currentUser = activeUsers[socket.id];
        if (currentUser) {
            const msgData = {
                user: currentUser.username,
                userPfp: currentUser.pfp, 
                userColor: currentUser.color || '#007AFF',
                toUser: data.toUser || null,
                text: data.text || null,
                files: data.files || [],
                replyTo: data.replyTo || null,
                type: 'user',
                timestamp: Date.now()
            };

            let savedMsgId = Date.now() + Math.random();
            if (isDbConnected) {
                const newMsg = new Message(msgData);
                const saved = await newMsg.save();
                savedMsgId = saved._id;
            }

            const emitData = { ...msgData, msgId: savedMsgId };
            chatHistory.push(emitData);
            if (chatHistory.length > 50) chatHistory.shift();

            if (msgData.toUser) {
                io.to(currentUser.username).to(msgData.toUser).emit('chatMessage', emitData);
            } else {
                io.emit('chatMessage', emitData);
            }
        }
    });

    socket.on('typing', () => {
        const u = activeUsers[socket.id];
        if(u) socket.broadcast.emit('userTyping', u.username);
    });
    socket.on('stopTyping', () => {
        const u = activeUsers[socket.id];
        if(u) socket.broadcast.emit('userStoppedTyping', u.username);
    });

    socket.on('pinMessage', async (msgData) => {
        const idToCheck = msgData._id || msgData.msgId;
        const exists = pinnedMessages.find(m => (m._id === idToCheck) || (m.msgId === idToCheck));
        const u = activeUsers[socket.id];
        
        if(!exists && u) {
            const pinData = { ...msgData, pinnedBy: u.username, isPinned: true };
            pinnedMessages.push(pinData);
            if(pinnedMessages.length > 50) pinnedMessages.shift();
            
            if(isDbConnected && idToCheck && idToCheck.length === 24) {
                await Message.updateOne({ _id: idToCheck }, { isPinned: true });
            }

            io.emit('updatePinned', pinnedMessages);
            if(!msgData.toUser) {
                const sysMsgData = { user: 'System', text: `${u.username} pinned a message`, type: 'bot', timestamp: Date.now() };
                io.emit('chatMessage', { ...sysMsgData, msgId: Date.now(), toUser: null });
            }
        }
    });

    socket.on('unpinMessage', async (msgId) => {
        pinnedMessages = pinnedMessages.filter(m => m.msgId !== msgId && m._id !== msgId);
        
        if(isDbConnected && msgId && msgId.length === 24) {
             await Message.updateOne({ _id: msgId }, { isPinned: false });
        }

        io.emit('updatePinned', pinnedMessages);
    });

    socket.on('disconnect', async () => {
        if (activeUsers[socket.id]) {
            delete activeUsers[socket.id];
            io.emit('updateUsers', activeUsers);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});