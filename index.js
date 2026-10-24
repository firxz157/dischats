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

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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

// Setup multer untuk simpan terus ke folder 'uploads'
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'avatar-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // Max 5MB
});

app.use(express.json({ limit: '50mb' })); 
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let onlineUsers = {};

// ==========================================
// 1. API AUTH
// ==========================================
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

// ==========================================
// 2. API PROFIL
// ==========================================
app.get('/api/users/:username', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT username, display_name, bio, avatar_url, status, created_at FROM users WHERE username = ?',
      [req.params.username]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Pengguna tidak dijumpai' });
    
    const user = rows[0];
    const isOnline = Object.values(onlineUsers).find(u => u.username === user.username);
    
    if (!isOnline) {
      user.status = 'offline';
    } else {
      user.status = isOnline.status;
    }

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
      // Simpan path fail gambar sahaja (contoh: /uploads/avatar-12345.jpg)
      const avatarPath = `/uploads/${req.file.filename}`;
      updateQuery += ', avatar_url = ?';
      params.push(avatarPath);
    }

    updateQuery += ' WHERE username = ?';
    params.push(decoded.username);
    await pool.execute(updateQuery, params);
    
    const [rows] = await pool.execute('SELECT username, display_name, bio, avatar_url, status FROM users WHERE username = ?', [decoded.username]);
    const updatedUser = rows[0];

    for (const socketId in onlineUsers) {
      if (onlineUsers[socketId].username === decoded.username) {
        onlineUsers[socketId].status = status;
      }
    }
    io.emit('user status changed', { username: decoded.username, status: status, profile: updatedUser });

    res.json(updatedUser);
  } catch (err) {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Saiz gambar melebihi 5MB' });
    res.status(500).json({ error: 'Gagal update profil' });
  }
});

// ==========================================
// 3. API MESEJ (GROUP CHAT)
// ==========================================
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
      if (msg.reply_id) replyTo = { id: msg.reply_id, username: msg.reply_username, text: msg.reply_text };
      return { ...msg, status: isOnline ? isOnline.status : 'offline', replyTo };
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
    io.emit('message deleted', req.params.id);
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
    io.emit('message edited', { id: req.params.id, newText });
    res.json({ message: 'Mesej dikemaskini' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal edit mesej' });
  }
});

// ==========================================
// 4. API FRIENDS (TAMBAH RAKAN)
// ==========================================
app.post('/api/friends/request', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Tiada token' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');

    const { receiver } = req.body;
    if (receiver === decoded.username) return res.status(400).json({ error: 'Tak boleh add diri sendiri' });

    const [existing] = await pool.execute(
      'SELECT * FROM friendships WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
      [decoded.username, receiver, receiver, decoded.username]
    );

    if (existing.length > 0) return res.status(400).json({ error: 'Dah hantar request atau dah berkawan' });

    await pool.execute('INSERT INTO friendships (sender_id, receiver_id, status) VALUES (?, ?, ?)', [decoded.username, receiver, 'pending']);
    
    io.emit('friend request received', { sender: decoded.username, receiver });
    
    res.json({ success: true, message: 'Request dihantar' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal hantar request' });
  }
});

app.post('/api/friends/accept', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    const { sender } = req.body;
    
    const [result] = await pool.execute(
      'UPDATE friendships SET status = "accepted" WHERE sender_id = ? AND receiver_id = ? AND status = "pending"',
      [sender, decoded.username]
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Request tak jumpa' });
    
    io.emit('friend request accepted', { sender, receiver: decoded.username });
    
    res.json({ success: true, message: 'Request diterima' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal terima request' });
  }
});

app.get('/api/friends/:username', async (req, res) => {
  try {
    const username = req.params.username;

    const [friends] = await pool.execute(`
      SELECT u.username, u.display_name, u.avatar_url, u.status 
      FROM friendships f 
      JOIN users u ON (f.sender_id = u.username OR f.receiver_id = u.username)
      WHERE f.status = 'accepted' AND (f.sender_id = ? OR f.receiver_id = ?) AND u.username != ?
    `, [username, username, username]);

    const [requests] = await pool.execute(`
      SELECT f.id as request_id, u.username, u.display_name, u.avatar_url 
      FROM friendships f 
      JOIN users u ON f.sender_id = u.username 
      WHERE f.receiver_id = ? AND f.status = 'pending'
    `, [username]);

    const realtimeFriends = friends.map(f => {
      const isOnline = Object.values(onlineUsers).find(u => u.username === f.username);
      return { ...f, status: isOnline ? isOnline.status : 'offline' };
    });

    res.json({ friends: realtimeFriends, requests });
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil senarai kawan' });
  }
});

app.post('/api/friends/unfriend', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    const { friend } = req.body;

    await pool.execute(
      'DELETE FROM friendships WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
      [decoded.username, friend, friend, decoded.username]
    );

    io.emit('friend removed', { user1: decoded.username, user2: friend });
    res.json({ success: true, message: 'Kawan dibuang' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal buang kawan' });
  }
});

// ==========================================
// 5. API DM (DIRECT MESSAGE), BLOCK, MUTUAL
// ==========================================

app.get('/api/dm/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const [rows] = await pool.execute(`
      SELECT * FROM direct_messages 
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY created_at ASC LIMIT 100
    `, [user1, user2, user2, user1]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Gagal ambil DM' }); }
});

app.post('/api/dm', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    const { receiver, text } = req.body;
    
    const [blocked] = await pool.execute('SELECT * FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [decoded.username, receiver, receiver, decoded.username]);
    if (blocked.length > 0) return res.status(403).json({ error: 'Tak boleh hantar mesej' });

    const [result] = await pool.execute('INSERT INTO direct_messages (sender_id, receiver_id, text) VALUES (?, ?, ?)', [decoded.username, receiver, text]);
    
    io.emit('dm message', {
      id: result.insertId, sender_id: decoded.username, receiver_id: receiver, text, created_at: new Date()
    });
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Gagal hantar DM' }); }
});

app.delete('/api/dm/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Tiada token' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    
    const [rows] = await pool.execute('SELECT * FROM direct_messages WHERE id = ?', [req.params.id]);
    if (rows.length === 0 || rows[0].sender_id !== decoded.username) {
      return res.status(403).json({ error: 'Tidak dibenarkan' });
    }

    await pool.execute('DELETE FROM direct_messages WHERE id = ?', [req.params.id]);
    
    io.emit('dm deleted', req.params.id); 
    
    res.json({ success: true, message: 'Mesej dipadam' });
  } catch (err) { 
    res.status(500).json({ error: 'Gagal padam mesej' }); 
  }
});

app.post('/api/friends/block', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rahasia_default');
    const { target } = req.body;

    await pool.execute('INSERT IGNORE INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)', [decoded.username, target]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Gagal block' }); }
});

app.get('/api/friends/details/:username/:target', async (req, res) => {
  try {
    const { username, target } = req.params;

    const [mutual] = await pool.execute(`
      SELECT u.username, u.display_name, u.avatar_url FROM friendships f1
      JOIN friendships f2 ON (f1.sender_id = f2.sender_id OR f1.sender_id = f2.receiver_id OR f1.receiver_id = f2.sender_id OR f1.receiver_id = f2.receiver_id)
      JOIN users u ON (u.username = f1.sender_id OR u.username = f1.receiver_id)
      WHERE f1.status = 'accepted' AND f2.status = 'accepted' 
      AND (f1.sender_id = ? OR f1.receiver_id = ?) 
      AND (f2.sender_id = ? OR f2.receiver_id = ?)
      AND u.username != ? AND u.username != ? AND u.username != f1.sender_id AND u.username != f1.receiver_id
      GROUP BY u.username
    `, [username, username, target, target, username, target]);

    const [outgoing] = await pool.execute(`
      SELECT u.username, u.display_name, u.avatar_url 
      FROM friendships f 
      JOIN users u ON f.receiver_id = u.username
      WHERE f.sender_id = ? AND f.status = 'pending'
    `, [username]);

    res.json({ mutual, outgoing });
  } catch (err) { res.status(500).json({ error: 'Gagal ambil details' }); }
});


// ==========================================
// 6. SOCKET.IO (REAL-TIME)
// ==========================================
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
    io.emit('system message', `👻 ${data.username} join Anak Hantu Chat`);
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

      io.emit('chat message', {
        id: result.insertId,
        channel: data.channel, username: data.username, 
        display_name: userData.display_name, avatar_url: userData.avatar_url, 
        status: status, text: data.text, created_at: new Date(), is_edited: false, replyTo: data.replyTo
      });
    } catch (err) { console.error(err); }
  });

  socket.on('typing', (data) => socket.broadcast.emit('typing', data));
  socket.on('stop typing', () => socket.broadcast.emit('stop typing'));

  socket.on('dm typing', (data) => {
    socket.broadcast.emit('dm typing', { sender: data.sender, receiver: data.receiver });
  });

  socket.on('disconnect', async () => {
    const user = onlineUsers[socket.id];
    if (user) {
      delete onlineUsers[socket.id];
      
      const stillOnline = Object.values(onlineUsers).find(u => u.username === user.username);
      
      if (!stillOnline) {
        io.emit('user status changed', { username: user.username, status: 'offline' });
      }
    }
  });
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('✅ Anak Hantu Chat berjalan di port ' + PORT));