// 1. SEMAK TOKEN
const token = localStorage.getItem('token');
const username = localStorage.getItem('username');

if (!token) {
  window.location.href = '/';
}

// Set nama pengguna di panel bawah
document.getElementById('user-name').textContent = username;
document.getElementById('user-avatar').textContent = username.charAt(0).toUpperCase();

// 2. SAMBUNG SOCKET.IO
const socket = io();

// 3. LOGIK MESEJ
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const messagesContainer = document.getElementById('messages');
let currentChannel = 'umum';

// Hantar mesej
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value.trim() !== '') {
    // Hantar ke pelayan: mesej, pengguna, saluran
    socket.emit('chat message', {
      text: input.value,
      username: username,
      channel: currentChannel
    });
    input.value = '';
  }
});

// Terima mesej dari pelayan
socket.on('chat message', (data) => {
  // Hanya paparkan jika mesej dari saluran semasa
  if (data.channel === currentChannel) {
    appendMessage(data);
  }
});

// Fungsi untuk masukkan mesej ke skrin
function appendMessage(data) {
  // Buang empty state jika ada
  const emptyState = document.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const isOwn = data.username === username;

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${isOwn ? 'own' : ''}`;

  // Masa
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  msgDiv.innerHTML = `
    <div class="msg-header">
      <span class="msg-author">${data.username}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-content">${escapeHTML(data.text)}</div>
  `;

  messagesContainer.appendChild(msgDiv);
  
  // Auto scroll ke bawah
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Keselamatan: Elak XSS (script injection)
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// 4. TUKAR SALURAN
window.switchChannel = function(channelName, element) {
  // Kemas kini UI
  document.querySelectorAll('.channel').forEach(c => c.classList.remove('active'));
  element.classList.add('active');

  currentChannel = channelName;

  // Kemas kini header
  document.getElementById('current-channel').textContent = channelName;
  document.getElementById('channel-name-header').textContent = channelName;
  
  // Kosongkan mesej lama
  messagesContainer.innerHTML = `<div class="empty-state">Ini adalah permulaan saluran #${channelName}.</div>`;
  
  // Notify server masuk bilik baru
  socket.emit('join channel', channelName);
};

// 5. LOG KELUAR
window.logout = function() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  window.location.href = '/';
};