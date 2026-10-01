const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const DB_FILE = './data.json';

const defaultData = {
  users: [],
  roles: [
    { id: 'owner', name: 'Owner', isOwner: true },
    { id: 'mod', name: 'Moderator', isOwner: false }
  ],
  channels: [
    { id: 'announcements', name: 'announcements', isReadOnly: true, allowedRoles: ['*'] },
    { id: 'staff-general', name: 'staff-general', isReadOnly: false, allowedRoles: ['*'] }
  ],
  messages: [],
  settings: { regOpen: true }
};

const loadData = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : defaultData;
const saveData = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Auth Middleware Helper
function verifyOwner(req, res, next) {
  const { username } = req.body;
  const db = loadData();
  const user = db.users.find(u => u.username === username);
  if (!user || user.role !== 'Owner') {
    return res.status(403).json({ error: 'Permission denied: Owner only.' });
  }
  req.db = db;
  next();
}

// 1. AUTH (First user is Owner)
app.post('/api/auth', (req, res) => {
  const { username, password, action } = req.body;
  const db = loadData();

  if (action === 'register') {
    if (db.users.length > 0 && !db.settings.regOpen) {
      return res.status(403).json({ error: 'Registration is closed by the Owner.' });
    }
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Username taken.' });
    }

    const isFirstUser = db.users.length === 0;
    const role = isFirstUser ? 'Owner' : 'Moderator';
    const newUser = { id: 'u_' + Date.now(), username, password, role, isBanned: false };
    
    db.users.push(newUser);
    saveData(db);
    io.emit('sync_data');
    return res.json({ user: newUser });
  }

  // Login
  const user = db.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  if (user.isBanned) return res.status(403).json({ error: 'You are banned from this server.' });

  res.json({ user });
});

// 2. GET APP STATE
app.get('/api/state', (req, res) => {
  const db = loadData();
  const safeUsers = db.users.map(({ password, ...u }) => u);
  res.json({
    roles: db.roles,
    channels: db.channels,
    users: safeUsers,
    settings: db.settings,
    messages: db.messages
  });
});

// 3. OWNER: TOGGLE REGISTRATION
app.post('/api/toggle-reg', verifyOwner, (req, res) => {
  req.db.settings.regOpen = !req.db.settings.regOpen;
  saveData(req.db);
  io.emit('sync_data');
  res.json({ regOpen: req.db.settings.regOpen });
});

// 4. OWNER: ROLE MANAGEMENT
app.post('/api/roles/create', verifyOwner, (req, res) => {
  const { roleName } = req.body;
  if (!roleName) return res.status(400).json({ error: 'Role name required' });
  if (req.db.roles.find(r => r.name.toLowerCase() === roleName.toLowerCase())) {
    return res.status(400).json({ error: 'Role already exists' });
  }

  req.db.roles.push({ id: 'r_' + Date.now(), name: roleName, isOwner: false });
  saveData(req.db);
  io.emit('sync_data');
  res.json({ success: true });
});

// 5. OWNER: CHANNEL CRUD
app.post('/api/channels/save', verifyOwner, (req, res) => {
  const { id, name, isReadOnly, allowedRoles } = req.body;
  if (!name) return res.status(400).json({ error: 'Channel name required' });

  const cleanName = name.toLowerCase().replace(/\s+/g, '-');
  
  if (id) {
    // Edit Channel
    const channel = req.db.channels.find(c => c.id === id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    channel.name = cleanName;
    channel.isReadOnly = !!isReadOnly;
    channel.allowedRoles = allowedRoles || ['*'];
  } else {
    // Create Channel
    req.db.channels.push({
      id: 'c_' + Date.now(),
      name: cleanName,
      isReadOnly: !!isReadOnly,
      allowedRoles: allowedRoles || ['*']
    });
  }

  saveData(req.db);
  io.emit('sync_data');
  res.json({ success: true });
});

app.post('/api/channels/delete', verifyOwner, (req, res) => {
  const { channelId } = req.body;
  req.db.channels = req.db.channels.filter(c => c.id !== channelId);
  req.db.messages = req.db.messages.filter(m => m.channelId !== channelId);
  saveData(req.db);
  io.emit('sync_data');
  res.json({ success: true });
});

// 6. OWNER: MEMBER MANAGEMENT (Assign Roles & Banning)
app.post('/api/users/set-role', verifyOwner, (req, res) => {
  const { targetUsername, newRole } = req.body;
  const target = req.db.users.find(u => u.username === targetUsername);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'Owner') return res.status(400).json({ error: 'Cannot modify Owner role' });

  target.role = newRole;
  saveData(req.db);
  io.emit('sync_data');
  res.json({ success: true });
});

app.post('/api/users/toggle-ban', verifyOwner, (req, res) => {
  const { targetUsername } = req.body;
  const target = req.db.users.find(u => u.username === targetUsername);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'Owner') return res.status(400).json({ error: 'Cannot ban the Owner' });

  target.isBanned = !target.isBanned;
  saveData(req.db);
  io.emit('user_banned_event', { username: target.username, isBanned: target.isBanned });
  io.emit('sync_data');
  res.json({ isBanned: target.isBanned });
});

// 7. REALTIME MESSAGING
io.on('connection', (socket) => {
  socket.on('send_msg', ({ user, channelId, text }) => {
    const db = loadData();
    const dbUser = db.users.find(u => u.username === user.username);
    if (!dbUser || dbUser.isBanned) return;

    const channel = db.channels.find(c => c.id === channelId);
    if (!channel) return;

    // Permissions check
    if (channel.isReadOnly && dbUser.role !== 'Owner') {
      return socket.emit('error_msg', 'Only the Owner can post announcements.');
    }
    if (!channel.allowedRoles.includes('*') && !channel.allowedRoles.includes(dbUser.role) && dbUser.role !== 'Owner') {
      return socket.emit('error_msg', 'Access denied to this channel.');
    }

    const msg = {
      id: 'm_' + Date.now(),
      user: dbUser.username,
      role: dbUser.role,
      channelId,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    db.messages.push(msg);
    saveData(db);
    io.emit('new_msg', msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Staff App online at http://localhost:${PORT}`));
