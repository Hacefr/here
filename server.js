const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public')); // Serves index.html directly

const DB_FILE = './data.json';
const loadData = () => fs.existsSync(DB_FILE) 
  ? JSON.parse(fs.readFileSync(DB_FILE)) 
  : { users: [], messages: [], settings: { regOpen: true } };
const saveData = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Auth & Settings APIs
app.post('/api/auth', (req, res) => {
  const { username, password, action } = req.body;
  const db = loadData();

  if (action === 'register') {
    if (db.users.length > 0 && !db.settings.regOpen) {
      return res.status(403).json({ error: 'Registration is closed by the Owner.' });
    }
    if (db.users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Username taken.' });
    }

    // FIRST USER IS OWNER, others are Mods
    const role = db.users.length === 0 ? 'Owner' : 'Moderator';
    const user = { username, password, role };
    db.users.push(user);
    saveData(db);
    return res.json({ user });
  }

  // Login
  const user = db.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  res.json({ user });
});

app.post('/api/toggle-reg', (req, res) => {
  const { username } = req.body;
  const db = loadData();
  const user = db.users.find(u => u.username === username);
  if (user?.role !== 'Owner') return res.status(403).json({ error: 'Only the Owner can do this.' });

  db.settings.regOpen = !db.settings.regOpen;
  saveData(db);
  res.json({ regOpen: db.settings.regOpen });
});

// Real-time Chat
io.on('connection', (socket) => {
  const db = loadData();
  socket.emit('init_messages', db.messages);

  socket.on('send_msg', ({ user, channel, text }) => {
    // Permission check for announcements
    if (channel === 'announcements' && user.role !== 'Owner') {
      return socket.emit('error_msg', 'Only the Owner can speak in #announcements.');
    }

    const msg = { user: user.username, role: user.role, channel, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    db.messages.push(msg);
    saveData(db);
    io.emit('new_msg', msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`App running at http://localhost:${PORT}`));
