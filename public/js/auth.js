// Tukar tab
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target + '-form').classList.add('active');
    showMessage('');
  });
});

function showMessage(text, type = '') {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = 'message ' + type;
}

// DAFTAR
document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('reg-username').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();

    if (!res.ok) return showMessage(data.error, 'error');

    showMessage('✅ Pendaftaran berjaya! Sila log masuk.', 'success');
    document.getElementById('register-form').reset();
    // Auto tukar ke tab login
    setTimeout(() => document.querySelector('.tab[data-target="login"]').click(), 1200);
  } catch (err) {
    showMessage('Ralat sambungan', 'error');
  }
});

// LOG MASUK
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) return showMessage(data.error, 'error');

    // Simpan token
    localStorage.setItem('token', data.token);
    localStorage.setItem('username', data.username);
    showMessage('✅ Log masuk berjaya! Mengalih...', 'success');
    setTimeout(() => (window.location.href = '/chat.html'), 800);
  } catch (err) {
    showMessage('Ralat sambungan', 'error');
  }
});