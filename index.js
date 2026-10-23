require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const fs = require('fs');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let onlineUsers = {};

// --- API AUTH ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Semua medan diperlukan' });
    const password_hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO users (username, display_name, email, password_hash, status) VALUES (?, ?, ?, ?, ?)',
      [username, username, email, password_hash, 'online']
    );
    res.status(201).json({ message: 'Pendaftaran berjaya' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username atau email sudah wujud' });
    res.status(500).json({ error: 'Ralat pelayan' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Email atau password salah' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Email atau password salah' });
    
    const token = jwt.sign({ userId: user.id, username: user.username }, process.env.JWT_SECRET || 'rahasia_default', { expiresIn: '7d' });
    res.json({ token, username: user.username, display_name: user.display_name });
  } catch (err) {
    res.status(500).json({ error: 'Ralat pelayan' });
  }
});

// --- API PROFIL ---
app.get('/api/users/:username', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT username, display_name, bio, avatar_url, status, created_at FROM users WHERE username = ?',
      [req.params.username]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Pengguna tidak dijumpai' });
    
    const user = rows[0];
    const isOnline = Object.values(onlineUsers).find(u => u.username === user.username);
    user.status = isOnline ? isOnline.status : 'offline';

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Ralat pelayan' });
  }
});

app.put('/api/users/profile', upload.single('avatar'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Tiada token' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');

    const { bio, display_name, status } = req.body;
    let updateQuery = 'UPDATE users SET bio = ?, display_name = ?, status = ?';
    let params = [bio, display_name, status];

    if (req.file) {
      const avatar_url = '/uploads/' + req.file.filename;
      updateQuery += ', avatar_url = ?';
      params.push(avatar_url);
    }

    updateQuery += ' WHERE username = ?';
    params.push(decoded.username);
    await pool.execute(updateQuery, params);
    
    for (let socketId in onlineUsers) {
      if (onlineUsers[socketId].username === decoded.username) {
        onlineUsers[socketId].status = status;
        io.emit('user status changed', { username: decoded.username, status });
      }
    }

    const [rows] = await pool.execute('SELECT username, display_name, bio, avatar_url, status FROM users WHERE username = ?', [decoded.username]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Gagal update profil' });
  }
});

// --- API MESEJ ---
app.get('/api/messages/:channel', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT m.id, m.channel, m.text, m.created_at, m.username, m.is_edited, u.display_name, u.avatar_url, u.status 
      FROM messages m 
      JOIN users u ON m.username = u.username 
      WHERE m.channel = ? ORDER BY m.created_at ASC LIMIT 100
    `, [req.params.channel]);
    
    const messagesWithStatus = rows.map(msg => {
      const isOnline = Object.values(onlineUsers).find(u => u.username === msg.username);
      return { ...msg, status: isOnline ? isOnline.status : 'offline' };
    });

    res.json(messagesWithStatus);
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil mesej' });
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    const [rows] = await pool.execute('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    
    if (rows.length === 0 || rows[0].username !== decoded.username) {
      return res.status(403).json({ error: 'Tidak dibenarkan' });
    }

    await pool.execute('DELETE FROM messages WHERE id = ?', [req.params.id]);
    io.to(rows[0].channel).emit('message deleted', req.params.id); // REAL-TIME DELETE
    res.json({ message: 'Mesej dipadam' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal padam mesej' });
  }
});

app.put('/api/messages/:id', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    const { newText } = req.body;
    
    const [rows] = await pool.execute('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    if (rows.length === 0 || rows[0].username !== decoded.username) {
      return res.status(403).json({ error: 'Tidak dibenarkan' });
    }

    await pool.execute('UPDATE messages SET text = ?, is_edited = TRUE WHERE id = ?', [newText, req.params.id]);
    io.to(rows[0].channel).emit('message edited', { id: req.params.id, newText }); // REAL-TIME EDIT
    res.json({ message: 'Mesej dikemaskini' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal edit mesej' });
  }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  socket.on('user connected', async (data) => {
    const [rows] = await pool.execute('SELECT status FROM users WHERE username = ?', [data.username]);
    let dbStatus = rows.length > 0 ? rows[0].status : 'online';
    if (dbStatus === 'offline') {
      dbStatus = 'online';
      await pool.execute('UPDATE users SET status = ? WHERE username = ?', ['online', data.username]);
    }
    onlineUsers[socket.id] = { username: data.username, status: dbStatus };
    io.emit('user status changed', { username: data.username, status: dbStatus });
  });

  socket.on('join channel', (channel) => {
    Array.from(socket.rooms).forEach(room => { if (room !== socket.id) socket.leave(room); });
    socket.join(channel);
  });

  socket.on('chat message', async (data) => {
    try {
      await pool.execute('INSERT INTO messages (channel, username, text) VALUES (?, ?, ?)', [data.channel, data.username, data.text]);
      const user = onlineUsers[socket.id];
      const status = user ? user.status : 'offline';
      
      io.to(data.channel).emit('chat message', {
        channel: data.channel, username: data.username, display_name: data.display_name,
        avatar_url: data.avatar_url, status: status, text: data.text, created_at: new Date(), is_edited: false
      });
    } catch (err) { console.error(err); }
  });

  socket.on('typing', (data) => socket.to(data.channel).emit('typing', data));
  socket.on('stop typing', (channel) => socket.to(channel).emit('stop typing', channel));

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) {
      delete onlineUsers[socket.id];
      const stillOnline = Object.values(onlineUsers).find(u => u.username === user.username);
      if (!stillOnline) io.emit('user status changed', { username: user.username, status: 'offline' });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('✅ DISCHATS Server berjalan di port ' + PORT));