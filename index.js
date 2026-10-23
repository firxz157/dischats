require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const sharp = require('sharp');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Setup Multer (Simpan dalam memori sementara, tak simpan dalam folder)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // Had 5MB
});

app.use(express.json({ limit: '50mb' })); 
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

// Update profil (Base64)
app.put('/api/users/profile', upload.single('avatar'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Tiada token' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');

    const { bio, display_name, status } = req.body;
    let updateQuery = 'UPDATE users SET bio = ?, display_name = ?, status = ?';
    let params = [bio, display_name, status];

    // Kalau ada gambar baru: compress & tukar ke Base64
    if (req.file) {
      const compressedBuffer = await sharp(req.file.buffer)
        .resize({ width: 400, height: 400, fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
      
      const base64Image = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
      
      updateQuery += ', avatar_url = ?';
      params.push(base64Image);
    }

    updateQuery += ' WHERE username = ?';
    params.push(decoded.username);
    await pool.execute(updateQuery, params);
    
    const [rows] = await pool.execute('SELECT username, display_name, bio, avatar_url, status FROM users WHERE username = ?', [decoded.username]);
    const updatedUser = rows[0];

    io.emit('profile updated', updatedUser);

    res.json(updatedUser);
  } catch (err) {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Saiz gambar melebihi 5MB' });
    }
    res.status(500).json({ error: 'Gagal update profil' });
  }
});

// --- API MESEJ (TAMBAH REPLY) ---
app.get('/api/messages/:channel', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT m.id, m.channel, m.text, m.created_at, m.username, u.display_name, u.avatar_url, u.status,
             m.reply_id, m.reply_username, m.reply_text
      FROM messages m 
      JOIN users u ON m.username = u.username 
      WHERE m.channel = ? ORDER BY m.created_at ASC LIMIT 100
    `, [req.params.channel]);
    
    const messagesWithStatus = rows.map(msg => {
      const isOnline = Object.values(onlineUsers).find(u => u.username === msg.username);
      
      let replyTo = null;
      if (msg.reply_id) {
        replyTo = {
          id: msg.reply_id,
          username: msg.reply_username,
          text: msg.reply_text
        };
      }
      return { ...msg, status: isOnline ? onlineUsers : 'offline', replyTo };
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
    io.to(rows[0].channel).emit('message deleted', req.params.id);
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
    io.to(rows[0].channel).emit('message edited', { id: req.params.id, newText });
    res.json({ message: 'Mesej dikemaskini' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal edit mesej' });
  }
});

// --- SOCKET.IO (TAMBAH REPLY) ---
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
      const replyId = data.replyTo ? data.replyTo.id : null;
      const replyUsername = data.replyTo ? data.replyTo.username : null;
      const replyText = data.replyTo ? data.replyTo.text : null;

      const [result] = await pool.execute(
        'INSERT INTO messages (channel, username, text, reply_id, reply_username, reply_text) VALUES (?, ?, ?, ?, ?, ?)', 
        [data.channel, data.username, data.text, replyId, replyUsername, replyText]
      );
      
      const user = onlineUsers[socket.id];
      const status = user ? user.status : 'offline';
      
      const [rows] = await pool.execute('SELECT display_name, avatar_url FROM users WHERE username = ?', [data.username]);
      const userData = rows[0];

      io.to(data.channel).emit('chat message', {
        id: result.insertId,
        channel: data.channel, username: data.username, 
        display_name: userData.display_name, avatar_url: userData.avatar_url, 
        status: status, text: data.text, created_at: new Date(), is_edited: false, replyTo: data.replyTo
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