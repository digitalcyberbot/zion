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

const MUSIC_CATALOG = {
    albums: [
        {
            id: 'neon-drift',
            title: 'Neon Drift',
            artist: 'Zion Radio',
            cover: '/music/neon-drift.png',
            price: 80,
            tracks: ['afterglow', 'night-drive', 'soft-static']
        },
        {
            id: 'glass-orbit',
            title: 'Glass Orbit',
            artist: 'Zion Radio',
            cover: '/music/glass-orbit.png',
            price: 90,
            tracks: ['blue-hour', 'low-gravity', 'signal-bloom']
        }
    ],
    tracks: [
        { id: 'afterglow', title: 'Afterglow', artist: 'Zion Radio', albumId: 'neon-drift', cover: '/music/neon-drift.png', audio: '/music/afterglow.wav', price: 30, duration: '0:16' },
        { id: 'night-drive', title: 'Night Drive', artist: 'Zion Radio', albumId: 'neon-drift', cover: '/music/neon-drift.png', audio: '/music/night-drive.wav', price: 30, duration: '0:16' },
        { id: 'soft-static', title: 'Soft Static', artist: 'Zion Radio', albumId: 'neon-drift', cover: '/music/neon-drift.png', audio: '/music/soft-static.wav', price: 30, duration: '0:16' },
        { id: 'blue-hour', title: 'Blue Hour', artist: 'Zion Radio', albumId: 'glass-orbit', cover: '/music/glass-orbit.png', audio: '/music/blue-hour.wav', price: 35, duration: '0:16' },
        { id: 'low-gravity', title: 'Low Gravity', artist: 'Zion Radio', albumId: 'glass-orbit', cover: '/music/glass-orbit.png', audio: '/music/low-gravity.wav', price: 35, duration: '0:16' },
        { id: 'signal-bloom', title: 'Signal Bloom', artist: 'Zion Radio', albumId: 'glass-orbit', cover: '/music/glass-orbit.png', audio: '/music/signal-bloom.wav', price: 35, duration: '0:16' }
    ]
};

const trackById = new Map(MUSIC_CATALOG.tracks.map(track => [track.id, track]));
const albumById = new Map(MUSIC_CATALOG.albums.map(album => [album.id, album]));

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
    z: { type: Number, default: 0 },
    activityPoints: { type: Number, default: 0, min: 0 },
    ownedTracks: { type: [String], default: [] },
    currentTrack: { type: String, default: null }
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
MessageSchema.index({ timestamp: -1 });
MessageSchema.index({ user: 1, toUser: 1, timestamp: -1 });

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
let offlineMessageSeq = 0;

const contributionState = new Map();
const CONTRIBUTION_COOLDOWN_MS = 45 * 1000;
const CONTRIBUTION_DAILY_CAP = 60;
const CONTRIBUTION_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

function normalizeId(value) {
    return value == null ? '' : String(value);
}

function isMongoId(value) {
    return /^[a-f\d]{24}$/i.test(normalizeId(value));
}

function publicUser(user) {
    if (!user) return null;
    return {
        username: user.username,
        color: user.color || '#007AFF',
        pfp: user.pfp || '',
        bio: user.bio || 'No bio written.',
        location: user.location || 'Unknown',
        status: user.status || 'Online',
        bgImage: user.bgImage || '',
        font: user.font || 'sans-serif',
        textColor: user.textColor || '#ffffff',
        customCss: user.customCss || '',
        x: Number(user.x) || 0,
        y: Number(user.y) || 0,
        z: Number(user.z) || 0,
        windowFocus: user.windowFocus !== false,
        currentTrack: trackById.has(user.currentTrack) ? user.currentTrack : null
    };
}

function publicUsersSnapshot() {
    const result = {};
    for (const [socketId, user] of Object.entries(activeUsers)) {
        result[socketId] = publicUser(user);
    }
    return result;
}

function emitUsers() {
    io.emit('updateUsers', publicUsersSnapshot());
}

function privateMusicState(user) {
    const owned = Array.isArray(user.ownedTracks) ? [...new Set(user.ownedTracks.filter(id => trackById.has(id)))] : [];
    return {
        activityPoints: Math.max(0, Number(user.activityPoints) || 0),
        ownedTracks: owned,
        currentTrack: owned.includes(user.currentTrack) ? user.currentTrack : null
    };
}

function syncPrivateUserState(username, updates) {
    for (const user of Object.values(activeUsers)) {
        if (user.username === username) Object.assign(user, updates);
    }
}

function emitPrivateMusicState(username, extra = {}) {
    const user = Object.values(activeUsers).find(entry => entry.username === username);
    if (!user) return;
    io.to(username).emit('musicState', { ...privateMusicState(user), ...extra });
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

function emitPinnedUpdates() {
    for (const [socketId, user] of Object.entries(activeUsers)) {
        io.to(socketId).emit('updatePinned', visiblePinsFor(user.username));
    }
}

function sanitizeProfileUpdate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const clean = {};
    for (const field of PROFILE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
        const value = data[field];
        if (typeof value === 'string') clean[field] = value.slice(0, field === 'customCss' ? 6000 : 2_000_000);
    }
    return clean;
}

function normalizeContributionText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, '<url>')
        .replace(/\s+/g, ' ')
        .trim();
}

function dayKey() {
    return new Date().toISOString().slice(0, 10);
}

function contributionAward(username, text, replyTo) {
    const normalized = normalizeContributionText(text);
    const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
    const meaningfulChars = normalized.replace(/[^\p{L}\p{N}]/gu, '').length;
    if (meaningfulChars < 18 || words.length < 4) return 0;

    const now = Date.now();
    let state = contributionState.get(username);
    if (!state || state.day !== dayKey()) {
        state = { day: dayKey(), earned: 0, lastAwardAt: 0, recent: [] };
        contributionState.set(username, state);
    }

    state.recent = state.recent.filter(item => now - item.at < CONTRIBUTION_DUPLICATE_WINDOW_MS);
    if (state.recent.some(item => item.text === normalized)) return 0;
    if (now - state.lastAwardAt < CONTRIBUTION_COOLDOWN_MS) return 0;
    if (state.earned >= CONTRIBUTION_DAILY_CAP) return 0;

    let points = 2;
    if (meaningfulChars >= 60) points += 1;
    if (meaningfulChars >= 140) points += 1;
    if (replyTo && typeof replyTo === 'object') points += 1;
    points = Math.min(points, 5, CONTRIBUTION_DAILY_CAP - state.earned);

    state.lastAwardAt = now;
    state.earned += points;
    state.recent.push({ text: normalized, at: now });
    return points;
}

async function addActivityPoints(user, amount) {
    if (!user || amount <= 0) return;
    user.activityPoints = Math.max(0, (Number(user.activityPoints) || 0) + amount);
    syncPrivateUserState(user.username, { activityPoints: user.activityPoints });
    if (isDbConnected) {
        await User.updateOne({ username: user.username }, { $inc: { activityPoints: amount } });
    } else if (localUsers[user.username]) {
        localUsers[user.username].activityPoints = user.activityPoints;
    }
    io.to(user.username).emit('activityPointsUpdate', {
        balance: user.activityPoints,
        delta: amount,
        reason: 'Meaningful contribution'
    });
}

function offlineSortValue(message) {
    const time = new Date(message.timestamp).getTime();
    const seq = Number(message._offlineSeq) || 0;
    return [time, seq];
}

function compareOfflineDesc(a, b) {
    const av = offlineSortValue(a);
    const bv = offlineSortValue(b);
    return bv[0] - av[0] || bv[1] - av[1];
}

function getOfflinePage(context, username, lastTimestamp, lastMessageId, limit = 20) {
    let items = chatHistory.filter(message => messageMatchesContext(message, context, username));
    items.sort(compareOfflineDesc);
    if (lastTimestamp) {
        const cutoff = new Date(lastTimestamp).getTime();
        const cursor = items.find(item => normalizeId(item.msgId || item._id) === normalizeId(lastMessageId));
        const cursorSeq = cursor ? Number(cursor._offlineSeq) || 0 : Number.MAX_SAFE_INTEGER;
        items = items.filter(item => {
            const [time, seq] = offlineSortValue(item);
            return time < cutoff || (time === cutoff && seq < cursorSeq);
        });
    }
    const slice = items.slice(0, limit + 1);
    return { messages: slice.slice(0, limit).reverse(), hasMore: slice.length > limit };
}

async function getDbPage(context, username, lastTimestamp, lastMessageId, limit = 20) {
    const contextQuery = getContextQuery(context, username);
    const and = [contextQuery];
    if (lastTimestamp) {
        const timestamp = new Date(lastTimestamp);
        const cursorTerms = [{ timestamp: { $lt: timestamp } }];
        if (isMongoId(lastMessageId)) {
            cursorTerms.push({ timestamp, _id: { $lt: lastMessageId } });
        }
        and.push({ $or: cursorTerms });
    }
    const query = and.length === 1 ? and[0] : { $and: and };
    const rows = await Message.find(query).sort({ timestamp: -1, _id: -1 }).limit(limit + 1).lean();
    return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

async function getContactProfiles(usernames) {
    const unique = [...new Set((usernames || []).filter(Boolean))];
    if (!unique.length) return {};
    const result = {};
    if (isDbConnected) {
        const docs = await User.find({ username: { $in: unique } }).select('-password -activityPoints -ownedTracks').lean();
        for (const doc of docs) result[doc.username] = publicUser(doc);
    } else {
        for (const username of unique) {
            if (localUsers[username]) result[username] = publicUser(localUsers[username]);
        }
    }
    return result;
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
            const username = typeof credentials.username === 'string' ? credentials.username.trim().slice(0, 64) : '';
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
                    userData = await new User({
                        username,
                        password: hashed,
                        x: (Math.random() * 60) - 30,
                        y: (Math.random() * 20) + 5,
                        z: (Math.random() * 30) - 20,
                        activityPoints: 0,
                        ownedTracks: [],
                        currentTrack: null
                    }).save();
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
                    customCss: '',
                    activityPoints: 0,
                    ownedTracks: [],
                    currentTrack: null
                };
                localUsers[username] = userData;
                isNewAccount = true;
            }

            const previous = activeUsers[socket.id];
            if (previous && previous.username !== username) socket.leave(previous.username);
            const wasAlreadyOnline = Object.entries(activeUsers).some(([id, user]) => id !== socket.id && user.username === username);
            socket.join(username);

            const plainUser = userData.toObject ? userData.toObject() : userData;
            if (!wasAlreadyOnline) {
                plainUser.currentTrack = null;
                if (isDbConnected) await User.updateOne({ username }, { $set: { currentTrack: null } });
                else if (localUsers[username]) localUsers[username].currentTrack = null;
            }
            activeUsers[socket.id] = { ...plainUser, windowFocus: true };
            delete activeUsers[socket.id].password;
            if (!Array.isArray(activeUsers[socket.id].ownedTracks)) activeUsers[socket.id].ownedTracks = [];
            if (!trackById.has(activeUsers[socket.id].currentTrack)) activeUsers[socket.id].currentTrack = null;

            let dmContacts = [];
            if (isDbConnected) {
                const sent = await Message.distinct('toUser', { user: username, toUser: { $ne: null } });
                const received = await Message.distinct('user', { toUser: username });
                dmContacts = [...new Set([...sent, ...received])];
            } else {
                const sent = chatHistory.filter(m => m.user === username && m.toUser).map(m => m.toUser);
                const received = chatHistory.filter(m => m.toUser === username).map(m => m.user);
                dmContacts = [...new Set([...sent, ...received])];
            }
            const contactProfiles = await getContactProfiles(dmContacts);

            socket.emit('loginSuccess', {
                user: publicUser(activeUsers[socket.id]),
                contacts: dmContacts,
                contactProfiles
            });
            socket.emit('musicCatalog', MUSIC_CATALOG);
            socket.emit('musicState', privateMusicState(activeUsers[socket.id]));
            socket.emit('updatePinned', visiblePinsFor(username));
            emitUsers();

            const page = isDbConnected
                ? await getDbPage('public', username, null, null)
                : getOfflinePage('public', username, null, null);
            socket.emit('history', page);

            if (isNewAccount) {
                const sysMsgData = {
                    user: 'System',
                    text: `${username} has registered a new account`,
                    type: 'bot',
                    timestamp: Date.now(),
                    toUser: null
                };
                let emitData = { ...sysMsgData, msgId: `offline-${++offlineMessageSeq}`, _offlineSeq: offlineMessageSeq };
                if (isDbConnected) {
                    const saved = await new Message(sysMsgData).save();
                    emitData = { ...sysMsgData, msgId: saved._id };
                } else {
                    chatHistory.push(emitData);
                }
                io.emit('chatMessage', emitData);
            }
        } catch (error) {
            console.error(error);
            socket.emit('loginError', 'Server error');
        }
    });

    socket.on('loadMoreMessages', async ({ context = 'public', lastTimestamp = null, lastMessageId = null, requestId = null } = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser) return;
        try {
            const page = isDbConnected
                ? await getDbPage(context, currentUser.username, lastTimestamp, lastMessageId)
                : getOfflinePage(context, currentUser.username, lastTimestamp, lastMessageId);
            socket.emit('moreHistory', { context, requestId, ...page });
        } catch (error) {
            console.error(error);
            socket.emit('moreHistory', { context, requestId, messages: [], hasMore: false });
        }
    });

    socket.on('loadContext', async ({ context = 'public', msgId, searchRequestId = null, searchJumpId = null } = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser || !msgId) return;
        try {
            let messages = [];
            if (isDbConnected && isMongoId(msgId)) {
                const contextQuery = getContextQuery(context, currentUser.username);
                const targetMsg = await Message.findOne({ $and: [contextQuery, { _id: msgId }] }).lean();
                if (!targetMsg) return;
                const before = await Message.find({ $and: [contextQuery, { timestamp: { $lt: targetMsg.timestamp } }] })
                    .sort({ timestamp: -1, _id: -1 }).limit(10).lean();
                const after = await Message.find({ $and: [contextQuery, { timestamp: { $gt: targetMsg.timestamp } }] })
                    .sort({ timestamp: 1, _id: 1 }).limit(10).lean();
                messages = [...before.reverse(), targetMsg, ...after];
            } else {
                const contextMessages = chatHistory
                    .filter(message => messageMatchesContext(message, context, currentUser.username))
                    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                const index = contextMessages.findIndex(message => normalizeId(message.msgId || message._id) === normalizeId(msgId));
                if (index < 0) return;
                messages = contextMessages.slice(Math.max(0, index - 10), index + 11);
            }
            socket.emit('contextHistory', { context, messages, targetId: msgId, searchRequestId, searchJumpId });
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('searchMessages', async ({ context = 'public', term = '', requestId = null } = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser) return;
        const cleanTerm = String(term).trim().slice(0, 100);
        if (!cleanTerm) {
            socket.emit('searchResults', { context, term: '', results: [], requestId });
            return;
        }
        try {
            let results = [];
            if (isDbConnected) {
                const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const contextQuery = getContextQuery(context, currentUser.username);
                results = await Message.find({
                    $and: [
                        contextQuery,
                        { type: 'user' },
                        { user: { $ne: 'System' } },
                        { text: { $regex: escaped, $options: 'i' } }
                    ]
                }).sort({ timestamp: -1, _id: -1 }).limit(50).lean();
            } else {
                const needle = cleanTerm.toLowerCase();
                results = chatHistory
                    .filter(message => messageMatchesContext(message, context, currentUser.username))
                    .filter(message => message.type !== 'bot' && message.user !== 'System')
                    .filter(message => String(message.text || '').toLowerCase().includes(needle))
                    .sort(compareOfflineDesc)
                    .slice(0, 50);
            }
            socket.emit('searchResults', { context, term: cleanTerm, results, requestId });
        } catch (error) {
            console.error(error);
            socket.emit('searchResults', { context, term: cleanTerm, results: [], requestId });
        }
    });

    socket.on('updateProfile', async (data) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        try {
            const updates = sanitizeProfileUpdate(data);
            if (!Object.keys(updates).length) return;
            Object.assign(user, updates);
            if (isDbConnected) {
                await User.updateOne({ username: user.username }, { $set: updates });
            } else if (localUsers[user.username]) {
                Object.assign(localUsers[user.username], updates);
            }
            emitUsers();
        } catch (error) {
            console.error('Failed to update profile:', error);
        }
    });

    socket.on('getUserProfile', async (targetUsername) => {
        try {
            const name = typeof targetUsername === 'string' ? targetUsername : '';
            if (!name) {
                socket.emit('userProfileData', null);
                return;
            }
            const active = Object.values(activeUsers).find(user => user.username === name);
            if (active) {
                socket.emit('userProfileData', { ...publicUser(active), status: 'Online' });
                return;
            }
            let record = null;
            if (isDbConnected) record = await User.findOne({ username: name }).select('-password -activityPoints -ownedTracks').lean();
            else record = localUsers[name] || null;
            socket.emit('userProfileData', record ? { ...publicUser(record), status: 'Offline' } : null);
        } catch (error) {
            socket.emit('userProfileData', null);
        }
    });

    socket.on('userFocus', (isFocused) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        user.windowFocus = Boolean(isFocused);
        socket.broadcast.emit('updateUserStatus', { username: user.username, windowFocus: user.windowFocus });
    });

    socket.on('chatMessage', async (data = {}) => {
        const currentUser = activeUsers[socket.id];
        if (!currentUser) return;
        try {
            const text = typeof data.text === 'string' ? data.text.slice(0, 8000) : '';
            const files = Array.isArray(data.files) ? data.files.slice(0, 8) : [];
            const toUser = typeof data.toUser === 'string' && data.toUser && data.toUser !== currentUser.username ? data.toUser : null;
            if (!text.trim() && files.length === 0) return;

            const msgData = {
                user: currentUser.username,
                userPfp: currentUser.pfp || '',
                userColor: currentUser.color || '#007AFF',
                toUser,
                text: text || null,
                files,
                replyTo: data.replyTo && typeof data.replyTo === 'object' ? data.replyTo : null,
                type: 'user',
                timestamp: Date.now()
            };

            let emitData;
            if (isDbConnected) {
                const saved = await new Message(msgData).save();
                emitData = { ...msgData, msgId: saved._id };
            } else {
                const seq = ++offlineMessageSeq;
                emitData = { ...msgData, msgId: `offline-${seq}`, _offlineSeq: seq };
                chatHistory.push(emitData);
                if (chatHistory.length > 1000) chatHistory.shift();
            }

            if (toUser) io.to(currentUser.username).to(toUser).emit('chatMessage', emitData);
            else io.emit('chatMessage', emitData);

            const reward = contributionAward(currentUser.username, text, msgData.replyTo);
            if (reward > 0) await addActivityPoints(currentUser, reward);
        } catch (error) {
            console.error('Failed to send message:', error);
        }
    });

    socket.on('typing', ({ context = 'public' } = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        if (context === 'public') {
            socket.broadcast.emit('userTyping', { name: user.username, context: 'public' });
            return;
        }
        io.to(context).emit('userTyping', { name: user.username, context: user.username });
    });

    socket.on('stopTyping', ({ context = 'public' } = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        if (context === 'public') {
            socket.broadcast.emit('userStoppedTyping', { name: user.username, context: 'public' });
            return;
        }
        io.to(context).emit('userStoppedTyping', { name: user.username, context: user.username });
    });

    socket.on('pinMessage', async (msgData = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        const idToCheck = msgData._id || msgData.msgId;
        if (!idToCheck) return;
        const normalizedId = normalizeId(idToCheck);
        try {
            if (pinnedMessages.some(message => normalizeId(message._id || message.msgId) === normalizedId)) return;
            let canonicalMessage = null;
            if (isDbConnected && isMongoId(normalizedId)) canonicalMessage = await Message.findById(normalizedId).lean();
            else canonicalMessage = chatHistory.find(message => normalizeId(message._id || message.msgId) === normalizedId);
            if (!canonicalMessage || !canUserSeeMessage(canonicalMessage, user.username)) return;

            const pinData = {
                ...canonicalMessage,
                msgId: canonicalMessage.msgId || canonicalMessage._id || idToCheck,
                pinnedBy: user.username,
                isPinned: true
            };
            pinnedMessages.push(pinData);
            if (pinnedMessages.length > 100) pinnedMessages.shift();
            if (isDbConnected && isMongoId(normalizedId)) {
                await Message.updateOne({ _id: normalizedId }, { $set: { isPinned: true } });
            }
            emitPinnedUpdates();

            if (!canonicalMessage.toUser) {
                io.emit('chatMessage', {
                    user: 'System',
                    text: `${user.username} pinned a message`,
                    type: 'bot',
                    timestamp: Date.now(),
                    toUser: null,
                    msgId: `system-${Date.now()}-${Math.random()}`
                });
            }
        } catch (error) {
            console.error('Failed to pin message:', error);
        }
    });

    socket.on('unpinMessage', async (msgId) => {
        const user = activeUsers[socket.id];
        if (!user || !msgId) return;
        const normalizedId = normalizeId(msgId);
        const pinned = pinnedMessages.find(message => normalizeId(message._id || message.msgId) === normalizedId);
        if (!pinned || !canUserSeeMessage(pinned, user.username)) return;
        try {
            pinnedMessages = pinnedMessages.filter(message => normalizeId(message._id || message.msgId) !== normalizedId);
            if (isDbConnected && isMongoId(normalizedId)) {
                await Message.updateOne({ _id: normalizedId }, { $set: { isPinned: false } });
            }
            emitPinnedUpdates();
        } catch (error) {
            console.error('Failed to unpin message:', error);
        }
    });

    socket.on('purchaseMusic', async ({ type, id } = {}) => {
        const user = activeUsers[socket.id];
        if (!user) return;
        try {
            let trackIds = [];
            let price = 0;
            if (type === 'track' && trackById.has(id)) {
                trackIds = [id];
                price = trackById.get(id).price;
            } else if (type === 'album' && albumById.has(id)) {
                const album = albumById.get(id);
                trackIds = album.tracks.filter(trackId => trackById.has(trackId));
                price = album.price;
            } else {
                return;
            }

            const owned = new Set(Array.isArray(user.ownedTracks) ? user.ownedTracks : []);
            const newTracks = trackIds.filter(trackId => !owned.has(trackId));
            if (!newTracks.length) {
                emitPrivateMusicState(user.username, { purchaseStatus: 'already-owned' });
                return;
            }
            if ((Number(user.activityPoints) || 0) < price) {
                emitPrivateMusicState(user.username, { purchaseStatus: 'insufficient-points' });
                return;
            }

            user.activityPoints -= price;
            newTracks.forEach(trackId => owned.add(trackId));
            user.ownedTracks = [...owned];
            syncPrivateUserState(user.username, {
                activityPoints: user.activityPoints,
                ownedTracks: [...user.ownedTracks]
            });

            if (isDbConnected) {
                await User.updateOne(
                    { username: user.username },
                    { $set: { activityPoints: user.activityPoints, ownedTracks: user.ownedTracks } }
                );
            } else if (localUsers[user.username]) {
                localUsers[user.username].activityPoints = user.activityPoints;
                localUsers[user.username].ownedTracks = [...user.ownedTracks];
            }

            emitPrivateMusicState(user.username, {
                purchaseStatus: 'purchased',
                purchasedType: type,
                purchasedId: id
            });
        } catch (error) {
            console.error('Music purchase failed:', error);
        }
    });

    socket.on('playTrack', async (trackId) => {
        const user = activeUsers[socket.id];
        if (!user || !trackById.has(trackId)) return;
        const owned = new Set(Array.isArray(user.ownedTracks) ? user.ownedTracks : []);
        if (!owned.has(trackId)) return;
        user.currentTrack = trackId;
        syncPrivateUserState(user.username, { currentTrack: trackId });
        if (isDbConnected) await User.updateOne({ username: user.username }, { $set: { currentTrack: trackId } });
        else if (localUsers[user.username]) localUsers[user.username].currentTrack = trackId;
        emitPrivateMusicState(user.username);
        emitUsers();
    });

    socket.on('stopTrack', async () => {
        const user = activeUsers[socket.id];
        if (!user) return;
        user.currentTrack = null;
        syncPrivateUserState(user.username, { currentTrack: null });
        if (isDbConnected) await User.updateOne({ username: user.username }, { $set: { currentTrack: null } });
        else if (localUsers[user.username]) localUsers[user.username].currentTrack = null;
        emitPrivateMusicState(user.username);
        emitUsers();
    });

    socket.on('disconnect', async () => {
        const leaving = activeUsers[socket.id];
        if (!leaving) return;
        delete activeUsers[socket.id];
        const stillOnline = Object.values(activeUsers).some(user => user.username === leaving.username);
        if (!stillOnline) {
            try {
                if (isDbConnected) await User.updateOne({ username: leaving.username }, { $set: { currentTrack: null } });
                else if (localUsers[leaving.username]) localUsers[leaving.username].currentTrack = null;
            } catch (error) {
                console.error('Failed to clear current track on disconnect:', error);
            }
        }
        emitUsers();
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
