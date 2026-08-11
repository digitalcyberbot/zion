// server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dns = require('dns');
const path = require('path');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8,
    cors: { origin: '*' }
});

try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
    console.log('DNS settings skipped');
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

const PROFILE_FIELDS = new Set([
    'color', 'pfp', 'bio', 'location', 'status',
    'bgImage', 'font', 'textColor', 'customCss'
]);

let localUsers = {};
let activeUsers = {};
let pinnedMessages = [];
let chatHistory = [];
let isDbConnected = false;

function normalizeId(value) {
    return value == null ? '' : String(value);
}

function isMongoId(value) {
    return /^[a-f\d]{24}$/i.test(normalizeId(value));
}

function getContextQuery(context, currentUser) {
    if (context === 'public') return { toUser: null };
    return {
        $or: [
            { user: currentUser, toUser: context },
            { user: context, toUser: currentUser }
        ]
    };
}

function messageMatchesContext(message, context, currentUser) {
    if (context === 'public') return !message.toUser;
    return (
        (message.user === currentUser && message.toUser === context) ||
        (message.user === context && message.toUser === currentUser)
    );
}

function canUserSeeMessage(message, username) {
    return !message.toUser || message.user === username || message.toUser === username;
}

function visiblePinsFor(username) {
    return pinnedMessages.filter(message => canUserSeeMessage(message, username));
}

async function hydrateMessageProfiles(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const usernames = [...new Set(messages.map(message => message && message.user).filter(name => name && name !== 'System'))];
    if (usernames.length === 0) return messages;

    const profiles = new Map();
    if (isDbConnected) {
        const records = await User.find({ username: { $in: usernames } }).select('username pfp color').lean();
        records.forEach(record => profiles.set(record.username, record));
    } else {
        usernames.forEach(username => {
            const user = localUsers[username];
            if (user) profiles.set(username, { username, pfp: user.pfp || '', color: user.color || '#007AFF' });
        });
    }

    return messages.map(message => {
        const profile = profiles.get(message.user);
        if (!profile) return message;
        return {
            ...message,
            userPfp: profile.pfp || '',
            userColor: profile.color || message.userColor || '#007AFF'
        };
    });
}

function emitPinnedUpdates() {
    for (const [socketId, user] of Object.entries(activeUsers)) {
        io.to(socketId).emit('updatePinned', visiblePinsFor(user.username));
    }
}

function sanitizeProfileUpdate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const clean = {};
    for (const field of PROFILE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(data, field)) clean[field] = data[field];
    }
    return clean;
}

async function connectDatabase() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.log('⚡ Starting in OFFLINE MODE (MONGO_URI not configured)');
        return;
    }

    try {
        await mongoose.connect(mongoUri);
        isDbConnected = true;
        console.log('✅ Connected to MongoDB (Online Mode)');
        pinnedMessages = await Message.find({ isPinned: true }).sort({ timestamp: 1 }).lean();
    } catch (err) {
        console.log('⚡ Starting in OFFLINE MODE');
        isDbConnected = false;
    }
}

connectDatabase();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    socket.on('login', async (credentials = {}) => {
        try {
            const username = typeof credentials.username === 'string' ? credentials.username.trim() : '';
            const password = typeof credentials.password === 'string' ? credentials.password : '';

            if (!username || !password) {
                socket.emit('loginError', 'Username and password are required');
                return;
            }

            let userData = null;
            let isNewAccount = false;

            if (isDbConnected) {
                let user = await User.findOne({ username });
                if (user) {
                    const isMatch = await bcrypt.compare(password, user.password);
                    if (!isMatch) {
                        socket.emit('loginError', 'Incorrect password');
                        return;
                    }
                    userData = user;
                } else {
                    const hashed = await bcrypt.hash(password, 10);
                    const newUser = new User({
                        username,
                        password: hashed,
                        x: (Math.random() * 60) - 30,
                        y: (Math.random() * 20) + 5,
                        z: (Math.random() * 30) - 20
                    });
                    userData = await newUser.save();
                    isNewAccount = true;
                }
            } else if (localUsers[username]) {
                const isMatch = await bcrypt.compare(password, localUsers[username].password);
                if (!isMatch) {
                    socket.emit('loginError', 'Incorrect password (Offline)');
                    return;
                }
                userData = localUsers[username];
            } else {
                const hashed = await bcrypt.hash(password, 10);
                userData = {
                    username,
                    password: hashed,
                    color: '#007AFF',
                    pfp: '',
                    x: (Math.random() * 60) - 30,
                    y: (Math.random() * 20) + 5,
                    z: (Math.random() * 30) - 20,
                    bio: 'No bio.',
                    location: 'Unknown',
                    status: 'Online',
                    bgImage: '',
                    font: 'sans-serif',
                    textColor: '#ffffff',
                    customCss: ''
                };
                localUsers[username] = userData;
                isNewAccount = true;
            }

            const previousUser = activeUsers[socket.id];
            if (previousUser && previousUser.username !== userData.username) {
                socket.leave(previousUser.username);
            }

            socket.join(userData.username);
            const plainUser = userData.toObject ? userData.toObject() : userData;
            activeUsers[socket.id] = { ...plainUser, windowFocus: true };
            if (!activeUsers[socket.id].color) activeUsers[socket.id].color = '#007AFF';
            delete activeUsers[socket.id].password;

            let dmContacts = [];
            if (isDbConnected) {
                const sent = await Message.distinct('toUser', { user: userData.username, toUser: { $ne: null } });
                const received = await Message.distinct('user', { toUser: userData.username });
                dmContacts = [...new Set([...sent, ...received])];
            } else {
                const sent = chatHistory.filter(m => m.user === userData.username && m.toUser).map(m => m.toUser);
                const received = chatHistory.filter(m => m.toUser === userData.username).map(m => m.user);
                dmContacts = [...new Set([...sent, ...received])];
            }

            socket.emit('loginSuccess', { user: activeUsers[socket.id], contacts: dmContacts });
            socket.emit('updatePinned', visiblePinsFor(userData.username));
            io.emit('updateUsers', activeUsers);

            if (isDbConnected) {
                try {
                    const history = await Message.find({ toUser: null }).sort({ timestamp: -1 }).limit(20).lean();
                    socket.emit('history', await hydrateMessageProfiles(history.reverse()));
                } catch (e) {
                    console.error(e);
                }
            } else {
                const publicHistory = chatHistory.filter(m => !m.toUser).slice(-20);
                socket.emit('history', await hydrateMessageProfiles(publicHistory));
            }

            if (isNewAccount) {
                const sysMsgData = {
                    user: 'System',
                    text: `${userData.username} has registered a new account`,
                    type: 'bot',
                    timestamp: Date.now(),
                    toUser: null
                };

                let emitData = { ...sysMsgData, msgId: Date.now() + Math.random() };
                if (isDbConnected) {
                    const saved = await new Message(sysMsgData).save();
                    emitData = { ...sysMsgData, msgId: saved._id };
                } else {
                    chatHistory.push(emitData);
                    if (chatHistory.length > 50) chatHistory.shift();
                }
                io.emit('chatMessage', emitData);
            }
        } catch (e) {
            console.error(e);
            socket.emit('loginError', 'Server error');
        }
    });

    socket.on('loadMoreMessages', async ({ context = 'public', lastTimestamp, requestId = null } = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser) return;

        try {
            let moreMessages;
            if (isDbConnected) {
                const query = getContextQuery(context, currentUser.username);
                if (lastTimestamp) query.timestamp = { $lt: new Date(lastTimestamp) };
                moreMessages = await Message.find(query).sort({ timestamp: -1 }).limit(20).lean();
                moreMessages.reverse();
            } else {
                const cutoff = lastTimestamp ? new Date(lastTimestamp).getTime() : Infinity;
                moreMessages = chatHistory
                    .filter(message => messageMatchesContext(message, context, currentUser.username))
                    .filter(message => new Date(message.timestamp).getTime() < cutoff)
                    .slice(-20);
            }
            moreMessages = await hydrateMessageProfiles(moreMessages);
            socket.emit('moreHistory', { context, messages: moreMessages, requestId });
        } catch (e) {
            console.error(e);
            socket.emit('moreHistory', { context, messages: [], requestId });
        }
    });

    socket.on('loadContext', async ({ context = 'public', msgId } = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser || !msgId) return;

        try {
            if (isDbConnected) {
                const query = getContextQuery(context, currentUser.username);
                const targetMsg = await Message.findOne({ ...query, _id: msgId }).lean();
                if (!targetMsg) return;

                const before = await Message.find({ ...query, timestamp: { $lt: targetMsg.timestamp } })
                    .sort({ timestamp: -1 }).limit(10).lean();
                const after = await Message.find({ ...query, timestamp: { $gt: targetMsg.timestamp } })
                    .sort({ timestamp: 1 }).limit(10).lean();
                socket.emit('contextHistory', {
                    context,
                    messages: await hydrateMessageProfiles([...before.reverse(), targetMsg, ...after]),
                    targetId: msgId
                });
            } else {
                const contextMessages = chatHistory.filter(message =>
                    messageMatchesContext(message, context, currentUser.username)
                );
                const targetIndex = contextMessages.findIndex(message =>
                    normalizeId(message.msgId || message._id) === normalizeId(msgId)
                );
                if (targetIndex === -1) return;
                const start = Math.max(0, targetIndex - 10);
                const end = Math.min(contextMessages.length, targetIndex + 11);
                socket.emit('contextHistory', {
                    context,
                    messages: await hydrateMessageProfiles(contextMessages.slice(start, end)),
                    targetId: msgId
                });
            }
        } catch (e) {
            console.error(e);
        }
    });

    socket.on('updateProfile', async (data) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        try {
            const updates = sanitizeProfileUpdate(data);
            if (Object.keys(updates).length === 0) return;

            Object.assign(user, updates);
            if (isDbConnected) {
                await User.updateOne({ username: user.username }, { $set: updates });
            } else if (localUsers[user.username]) {
                Object.assign(localUsers[user.username], updates);
            }
            io.emit('updateUsers', activeUsers);
        } catch (e) {
            console.error('Failed to update profile:', e);
        }
    });

    socket.on('getUserProfile', async (targetUsername) => {
        try {
            if (typeof targetUsername !== 'string' || !targetUsername) {
                socket.emit('userProfileData', null);
                return;
            }

            const active = Object.values(activeUsers).find(u => u.username === targetUsername);
            if (active) {
                socket.emit('userProfileData', { ...active, status: 'Online' });
                return;
            }

            let userRecord = null;
            if (isDbConnected) {
                userRecord = await User.findOne({ username: targetUsername }).select('-password').lean();
            } else if (localUsers[targetUsername]) {
                const { password, ...safeUser } = localUsers[targetUsername];
                userRecord = safeUser;
            }

            if (userRecord) socket.emit('userProfileData', { ...userRecord, status: 'Offline' });
            else socket.emit('userProfileData', null);
        } catch (e) {
            socket.emit('userProfileData', null);
        }
    });

    socket.on('userFocus', (isFocused) => {
        const user = activeUsers[socket.id];
        if (user) {
            user.windowFocus = Boolean(isFocused);
            socket.broadcast.emit('updateUserStatus', {
                username: user.username,
                windowFocus: user.windowFocus
            });
        }
    });

    socket.on('chatMessage', async (data = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser) return;

        try {
            const msgData = {
                user: currentUser.username,
                userPfp: currentUser.pfp,
                userColor: currentUser.color || '#007AFF',
                toUser: typeof data.toUser === 'string' && data.toUser ? data.toUser : null,
                text: typeof data.text === 'string' && data.text ? data.text : null,
                files: Array.isArray(data.files) ? data.files : [],
                replyTo: data.replyTo && typeof data.replyTo === 'object' ? data.replyTo : null,
                type: 'user',
                timestamp: Date.now()
            };

            if (!msgData.text && msgData.files.length === 0) return;

            let savedMsgId = Date.now() + Math.random();
            if (isDbConnected) {
                const saved = await new Message(msgData).save();
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
        } catch (e) {
            console.error('Failed to send message:', e);
        }
    });

    socket.on('typing', ({ context = 'public' } = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        const safeContext = typeof context === 'string' && context ? context : 'public';
        const payload = { name: user.username, context: safeContext };
        if (safeContext === 'public') socket.broadcast.emit('userTyping', payload);
        else socket.to(safeContext).emit('userTyping', payload);
    });

    socket.on('stopTyping', ({ context = 'public' } = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        const safeContext = typeof context === 'string' && context ? context : 'public';
        const payload = { name: user.username, context: safeContext };
        if (safeContext === 'public') socket.broadcast.emit('userStoppedTyping', payload);
        else socket.to(safeContext).emit('userStoppedTyping', payload);
    });

    socket.on('pinMessage', async (msgData = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;

        const idToCheck = msgData._id || msgData.msgId;
        if (!idToCheck) return;
        const normalizedId = normalizeId(idToCheck);

        try {
            const exists = pinnedMessages.some(message =>
                normalizeId(message._id || message.msgId) === normalizedId
            );
            if (exists) return;

            let canonicalMessage = null;
            if (isDbConnected && isMongoId(normalizedId)) {
                canonicalMessage = await Message.findById(normalizedId).lean();
            } else {
                canonicalMessage = chatHistory.find(message =>
                    normalizeId(message._id || message.msgId) === normalizedId
                );
            }

            if (!canonicalMessage || !canUserSeeMessage(canonicalMessage, user.username)) return;

            const pinData = {
                ...canonicalMessage,
                msgId: canonicalMessage.msgId || canonicalMessage._id || idToCheck,
                pinnedBy: user.username,
                isPinned: true
            };
            pinnedMessages.push(pinData);
            if (pinnedMessages.length > 50) pinnedMessages.shift();

            if (isDbConnected && isMongoId(normalizedId)) {
                await Message.updateOne({ _id: normalizedId }, { $set: { isPinned: true } });
            }

            emitPinnedUpdates();

            if (!canonicalMessage.toUser) {
                const sysMsgData = {
                    user: 'System',
                    text: `${user.username} pinned a message`,
                    type: 'bot',
                    timestamp: Date.now(),
                    toUser: null
                };
                io.emit('chatMessage', { ...sysMsgData, msgId: Date.now() + Math.random() });
            }
        } catch (e) {
            console.error('Failed to pin message:', e);
        }
    });

    socket.on('unpinMessage', async (msgId) => {
        const user = activeUsers[socket.id];
        if (!user || !msgId) return;

        const normalizedId = normalizeId(msgId);
        const pinnedMessage = pinnedMessages.find(message =>
            normalizeId(message._id || message.msgId) === normalizedId
        );
        if (!pinnedMessage || !canUserSeeMessage(pinnedMessage, user.username)) return;

        try {
            pinnedMessages = pinnedMessages.filter(message =>
                normalizeId(message._id || message.msgId) !== normalizedId
            );
            if (isDbConnected && isMongoId(normalizedId)) {
                await Message.updateOne({ _id: normalizedId }, { $set: { isPinned: false } });
            }
            emitPinnedUpdates();
        } catch (e) {
            console.error('Failed to unpin message:', e);
        }
    });

    socket.on('disconnect', () => {
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
