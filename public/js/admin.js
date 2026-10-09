(function() {
    let adminToken = localStorage.getItem('adminToken');
    const loginSection = document.getElementById('login-section');
    const adminContent = document.getElementById('admin-content');
    const loginStatus = document.getElementById('login-status');

    function showLogin(message) {
        adminContent.style.display = 'none';
        loginSection.style.display = 'block';
        if (message) loginStatus.textContent = message;
    }

    // Escape HTML — song metadata comes from public uploads, docket text is
    // admin input; neither may inject markup into the admin page
    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Authenticated admin request; bounces back to login on 401
    function adminFetch(url, options = {}) {
        const headers = Object.assign({}, options.headers || {});
        headers['Authorization'] = `Bearer ${adminToken}`;
        return fetch(url, Object.assign({}, options, { headers })).then(res => {
            if (res.status === 401) {
                adminToken = null;
                localStorage.removeItem('adminToken');
                showLogin('> SESSION INVALID OR EXPIRED — LOGIN AGAIN');
            }
            return res;
        });
    }

    // Report failed admin mutations instead of silently reloading the list
    async function mustOk(res, label) {
        if (res.ok) return true;
        const data = await res.json().catch(() => ({}));
        alert(`Failed (${res.status}) ${label}: ${data.error || 'unknown error'}`);
        return false;
    }

    // Check if we already hold a valid token
    (async () => {
        if (!adminToken) return;
        const res = await adminFetch('/radio/api/admin/songs');
        if (res.ok) {
            loginSection.style.display = 'none';
            adminContent.style.display = 'block';
            loadAllData();
        }
        // else: adminFetch already handled the 401 (show login)
    })();

    // Login: exchange password for a short-lived token
    document.getElementById('login-btn').addEventListener('click', async () => {
        const pass = document.getElementById('admin-password').value;
        if (!pass) return;
        loginStatus.textContent = '> AUTHENTICATING...';
        try {
            const res = await fetch('/radio/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pass })
            });
            const data = await res.json();
            if (res.ok && data.token) {
                adminToken = data.token;
                localStorage.setItem('adminToken', adminToken);
                loginStatus.textContent = '> ACCESS GRANTED (7 DAYS)';
                loginSection.style.display = 'none';
                adminContent.style.display = 'block';
                loadAllData();
            } else {
                loginStatus.textContent = '> ACCESS DENIED';
            }
        } catch (err) {
            loginStatus.textContent = `> NETWORK ERROR: ${err.message}`;
        }
    });

    async function loadAllData() {
        await loadSongs();
        await loadDocket();
        await loadNews();
    }

    // ---------- Song Management ----------
    async function loadSongs(search = '') {
        try {
            const res = await fetch(`/radio/api/songs?q=${encodeURIComponent(search)}`);
            const data = await res.json();
            const songs = data.songs || [];
            const list = document.getElementById('admin-song-list');
            list.innerHTML = songs.map(s => `
                <li>
                    <span class="song-info">
                        <span class="song-id">#${s.id}</span>
                        <strong>${esc(s.artist) || '?'}</strong> — ${esc(s.title || s.filename)}
                        <span class="badge ${esc(s.source)}">${esc(s.source)}</span>
                        <span class="req-count">(${s.request_count} req)</span>
                    </span>
                    <span class="song-actions">
                        <button data-id="${s.id}" class="trash-btn">TRASH</button>
                        <button data-id="${s.id}" data-artist="${esc(s.artist || '')}" data-title="${esc(s.title || '')}" class="edit-btn">EDIT</button>
                    </span>
                </li>
            `).join('');
            document.getElementById('admin-song-count').textContent = songs.length;

            // Attach event listeners
            document.querySelectorAll('.trash-btn').forEach(btn => {
                btn.addEventListener('click', () => deleteSong(btn.dataset.id));
            });
            document.querySelectorAll('.edit-btn').forEach(btn => {
                btn.addEventListener('click', () => editSong(btn.dataset.id, btn.dataset.artist, btn.dataset.title));
            });
        } catch (err) {
            console.error('Failed to load songs:', err);
        }
    }

    async function deleteSong(id) {
        if (!confirm('Move this song to the trash folder?')) return;
        const res = await adminFetch(`/radio/api/admin/songs/${id}`, { method: 'DELETE' });
        if (!(await mustOk(res, 'delete song'))) return;
        loadSongs(document.getElementById('admin-search').value);
    }

    async function editSong(id, artist, title) {
        const newArtist = prompt('Artist:', artist);
        const newTitle = prompt('Title:', title);
        if (!newArtist || !newTitle) return;
        const res = await adminFetch(`/radio/api/admin/songs/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ artist: newArtist, title: newTitle })
        });
        if (!(await mustOk(res, 'edit song'))) return;
        loadSongs(document.getElementById('admin-search').value);
    }

    let adminSearchTimer = null;
    document.getElementById('admin-search').addEventListener('input', (e) => {
        clearTimeout(adminSearchTimer);
        adminSearchTimer = setTimeout(() => loadSongs(e.target.value), 250);
    });

    // ---------- Jingle Upload ----------
    document.getElementById('upload-jingle-btn').addEventListener('click', async () => {
        const fileInput = document.getElementById('jingle-file');
        const file = fileInput.files[0];
        if (!file) return alert('Choose a file');

        const statusDiv = document.getElementById('jingle-status');
        statusDiv.textContent = '> Uploading...';

        const formData = new FormData();
        formData.append('jingle', file);

        try {
            const res = await adminFetch('/radio/api/admin/jingles', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (res.ok) {
                statusDiv.textContent = `> Uploaded: ${data.filename}`;
                fileInput.value = '';
            } else {
                statusDiv.textContent = `> ERROR: ${data.error}`;
            }
        } catch (err) {
            statusDiv.textContent = `> NETWORK ERROR: ${err.message}`;
        }
    });

    // ---------- Legislative Docket ----------
    async function loadDocket() {
        const res = await fetch('/radio/api/docket');
        const data = await res.json();
        const tbody = document.getElementById('docket-list');
        tbody.innerHTML = data.laws.map(l => `
            <tr>
                <td>${l.id}</td>
                <td>${esc(l.text)}</td>
                <td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td>
                <td>
                    <button data-id="${l.id}" data-status="${l.status === 'legalized' ? 'criminalized' : 'legalized'}" class="flip-btn">FLIP</button>
                    <button data-id="${l.id}" class="repeal-btn">REPEAL</button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.flip-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleLaw(btn.dataset.id, btn.dataset.status));
        });
        document.querySelectorAll('.repeal-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteLaw(btn.dataset.id));
        });
    }

    async function addLaw() {
        const text = document.getElementById('new-law-text').value.trim();
        const status = document.getElementById('new-law-status').value;
        if (!text) return;
        const res = await adminFetch('/radio/api/admin/docket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, status })
        });
        if (!(await mustOk(res, 'add law'))) return;
        document.getElementById('new-law-text').value = '';
        loadDocket();
    }

    async function toggleLaw(id, newStatus) {
        const res = await adminFetch(`/radio/api/admin/docket/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        if (!(await mustOk(res, 'flip law'))) return;
        loadDocket();
    }

    async function deleteLaw(id) {
        if (!confirm('Repeal this law?')) return;
        const res = await adminFetch(`/radio/api/admin/docket/${id}`, { method: 'DELETE' });
        if (!(await mustOk(res, 'repeal law'))) return;
        loadDocket();
    }

    document.getElementById('add-law-btn').addEventListener('click', addLaw);

    // ---------- News Marquee (graffiti wall) ----------
    const newsInput = document.getElementById('new-news-text');
    const newsPreview = document.getElementById('news-live-preview');
    const newsPreviewBox = document.getElementById('news-live-preview-container');
    const newsPaletteBar = document.getElementById('news-palette-bar');
    const newsBlinkBtn = document.getElementById('news-blink-btn');

    // Armed defaults: applied to text typed with no active selection
    let newsActiveColor = null;
    let newsActiveBlink = false;
    let newsLastValue = '';

    // Live preview: NewsFormat escapes all HTML and only converts approved
    // [color]/[blink] tags, so this innerHTML can't be injected through
    function updateNewsPreview() {
        const v = newsInput.value;
        if (!v.trim()) { newsPreviewBox.hidden = true; return; }
        newsPreviewBox.hidden = false;
        newsPreview.innerHTML = NewsFormat.render(v);
    }

    function newsHasSelection() {
        return newsInput.selectionStart !== newsInput.selectionEnd;
    }

    function newsSetSelection(s, e) {
        newsInput.focus();
        newsInput.setSelectionRange(s, e);
    }

    // Wrap the current selection in a tag pair; false if nothing selected
    function newsWrapSelection(open, close) {
        const s = newsInput.selectionStart, e = newsInput.selectionEnd;
        if (s === e) return false;
        const v = newsInput.value;
        newsInput.value = v.slice(0, s) + open + v.slice(s, e) + close + v.slice(e);
        newsSetSelection(s + open.length, e + open.length);
        return true;
    }

    // Unwrap the selection if it is already enclosed by exactly one pair
    function newsUnwrapSelection(open, close) {
        const s = newsInput.selectionStart, e = newsInput.selectionEnd;
        if (s === e) return false;
        const v = newsInput.value;
        if (v.slice(e, e + close.length) !== close) return false;
        const before = v.slice(0, s);
        const o = before.lastIndexOf(open);
        if (o < 0) return false;
        if (before.slice(o + open.length).includes(close)) return false; // inner close => nested, don't touch
        newsInput.value = before.slice(0, o) + v.slice(s, e) + v.slice(e + close.length);
        newsSetSelection(o, o + (e - s));
        return true;
    }

    function syncNewsControls() {
        newsPaletteBar.querySelectorAll('.news-swatch').forEach(b =>
            b.classList.toggle('active', b.dataset.color === newsActiveColor));
        newsBlinkBtn.classList.toggle('active', newsActiveBlink);
    }

    function applyNewsColor(hex) {
        if (newsHasSelection()) {
            // selected text: toggle that color's tags on the selection
            const open = `[color=${hex}]`;
            if (!newsUnwrapSelection(open, '[/color]')) newsWrapSelection(open, '[/color]');
            newsActiveColor = null;
        } else {
            // no selection: arm/disarm as default typing color
            newsActiveColor = (newsActiveColor === hex) ? null : hex;
        }
        syncNewsControls();
        updateNewsPreview();
    }

    NewsFormat.PALETTE.forEach(hex => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'news-swatch';
        b.dataset.color = hex;
        b.style.backgroundColor = hex;
        b.title = `Color: ${hex}`;
        b.addEventListener('click', () => applyNewsColor(hex));
        newsPaletteBar.appendChild(b);
    });

    newsBlinkBtn.addEventListener('click', () => {
        if (newsHasSelection()) {
            if (!newsUnwrapSelection('[blink]', '[/blink]')) newsWrapSelection('[blink]', '[/blink]');
            newsActiveBlink = false;
        } else {
            newsActiveBlink = !newsActiveBlink;
        }
        syncNewsControls();
        updateNewsPreview();
    });

    // Armed typing: with a color and/or blink armed (no selection was made),
    // text appended at the end of the field gets wrapped automatically.
    newsInput.addEventListener('input', () => {
        const v = newsInput.value;
        const armed =
            (newsActiveColor ? `[color=${newsActiveColor}]` : '') +
            (newsActiveBlink ? '[blink]' : '');
        if (armed && v.length > newsLastValue.length &&
            v.startsWith(newsLastValue) && newsInput.selectionStart === v.length) {
            const added = v.slice(newsLastValue.length);
            const close = (newsActiveBlink ? '[/blink]' : '') + (newsActiveColor ? '[/color]' : '');
            newsInput.value = newsLastValue + armed + added + close;
            const caret = newsLastValue.length + armed.length + added.length;
            newsSetSelection(caret, caret);
        }
        newsLastValue = newsInput.value;
        updateNewsPreview();
    });

    newsInput.addEventListener('keyup', () => {
        newsLastValue = newsInput.value;
        updateNewsPreview();
    });

    async function loadNews() {
        const res = await fetch('/radio/api/news');
        const data = await res.json();
        const tbody = document.getElementById('news-list');
        // NewsFormat escapes everything first, then allows approved
        // color/blink spans through — safe to inject, live in the table too
        tbody.innerHTML = data.news.map(n => `
            <tr>
                <td>${n.id}</td>
                <td>${NewsFormat.render(n.text)}</td>
                <td>
                    <button data-id="${n.id}" class="delete-news-btn">DELETE</button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.delete-news-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteNews(btn.dataset.id));
        });
    }

    async function addNews() {
        const text = newsInput.value.trim();
        if (!text) return;
        const res = await adminFetch('/radio/api/admin/news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        if (!(await mustOk(res, 'add news'))) return;
        newsInput.value = '';
        newsActiveColor = null;
        newsActiveBlink = false;
        newsLastValue = '';
        syncNewsControls();
        updateNewsPreview();
        loadNews();
    }

    async function deleteNews(id) {
        if (!confirm('Remove this news entry?')) return;
        const res = await adminFetch(`/radio/api/admin/news/${id}`, { method: 'DELETE' });
        if (!(await mustOk(res, 'delete news'))) return;
        loadNews();
    }

    document.getElementById('add-news-btn').addEventListener('click', addNews);

    // ---------- Joke Feature ----------
    document.getElementById('legalize-everything-btn').addEventListener('click', () => {
        document.getElementById('joke-output').textContent = '> Bill rejected by the Fun Police. Try again never.';
    });
})();