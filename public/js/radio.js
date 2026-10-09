// radio.js - Frontend logic for DoNotEn.tr radio

document.addEventListener('DOMContentLoaded', () => {
    let selectedSongId = null;
    let songList = [];

    const songListEl = document.getElementById('song-list');
    const searchInput = document.getElementById('search-input');
    const requestBtn = document.getElementById('request-selected-btn');
    const refreshBtn = document.getElementById('refresh-list-btn');
    const requestStatus = document.getElementById('request-status');
    const uploadStatus = document.getElementById('upload-status');
    const songCountSpan = document.getElementById('song-count');
    const nowPlayingDiv = document.getElementById('now-playing');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const playVisualizerArea = document.getElementById('play-visualizer-area');

    // Restore persisted volume
    const savedVolume = localStorage.getItem('radio-volume');
    if (savedVolume !== null) {
        volumeSlider.value = savedVolume;
    }
    const canvas = document.getElementById('visualizer');
    const ctx = canvas.getContext('2d');
    const streamUrl = '/stream';

    let howl = null;
    let audioCtx = null;
    let analyser = null;
    let source = null;
    let animFrame = null;

    function sliderToVolume(sliderVal) {
        return Math.pow(sliderVal / 100, 2);
    }

    volumeSlider.addEventListener('input', () => {
        const vol = volumeSlider.value;
        localStorage.setItem('radio-volume', vol);
        if (howl) howl.volume(sliderToVolume(parseInt(vol, 10)));
    });

    // Create the Howl once; reuse it to avoid pool exhaustion
    howl = new Howl({
        src: [streamUrl],
        html5: true,
        format: ['mp3'],
        volume: sliderToVolume(parseInt(volumeSlider.value, 10)),  // restored from localStorage if set
        onloaderror: showPlayButton,
        onend: showPlayButton
    });

    function setupAudioContext() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
    }

    function connectAnalyser() {
        if (analyser) {
            const node = howl._sounds[0]._node;
            if (source) source.disconnect();
            source = audioCtx.createMediaElementSource(node);
            source.connect(analyser);
            analyser.connect(audioCtx.destination);
        }
    }

    function resizeCanvas() {
        canvas.width = playVisualizerArea.clientWidth;
        canvas.height = playVisualizerArea.clientHeight;
    }

    function drawVisualizer() {
        resizeCanvas();
        const bufLen = analyser.frequencyBinCount;
        const data = new Uint8Array(bufLen);

        animFrame = requestAnimationFrame(drawVisualizer);

        analyser.getByteFrequencyData(data);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const barW = (canvas.width / bufLen) * 2.5;
        let x = 0;

        for (let i = 0; i < bufLen; i++) {
            const barH = (data[i] / 255) * canvas.height;
            ctx.fillStyle = getComputedStyle(document.documentElement)
                .getPropertyValue('--color-accent-bright').trim() || '#00f000';
            ctx.fillRect(x, canvas.height - barH, barW, barH);
            x += barW + 1;
        }
    }

    function showVisualizer() {
        playPauseBtn.style.display = 'none';
        canvas.style.display = 'block';
    }

    function showPlayButton() {
        playPauseBtn.style.display = '';
        canvas.style.display = 'none';
        if (animFrame) cancelAnimationFrame(animFrame);
    }

    // Reuse the same Howl; force live edge with cache-bust
    playPauseBtn.addEventListener('click', () => {
        // Stop previous stream if playing
        if (howl.playing()) howl.stop();

        // Force a fresh connection to the live edge
        howl._src = [streamUrl + '?_=' + Date.now()];

        setupAudioContext();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        howl.on('play', () => {
            connectAnalyser();
            drawVisualizer();
        });

        howl.load();
        howl.play();
        showVisualizer();
    });

    function parseFilename(filename) {
        const name = filename.replace(/\.mp3$/i, '');
        const parts = name.split(' - ');
        if (parts.length >= 2) {
            return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
        }
        return { artist: 'Unknown', title: name };
    }

    async function loadSongs(search = '') {
        try {
            const res = await fetch(`/radio/api/songs?q=${encodeURIComponent(search)}`);
            const data = await res.json();
            songList = data.songs;
            renderSongList(songList);
            songCountSpan.textContent = songList.length;
        } catch (err) {
            console.error('Failed to load songs:', err);
            songListEl.innerHTML = '<li>Error loading catalog</li>';
        }
    }

    // Artist/title come from public uploads — escape before injecting (stored XSS)
    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Mirrors the server's LICENSE_TYPES (radio/server.js)
    const LICENSES = {
        'CC-BY-4.0':       { label: 'CC BY 4.0',     url: 'https://creativecommons.org/licenses/by/4.0/' },
        'CC-BY-SA-4.0':    { label: 'CC BY-SA 4.0',  url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
        'CC-BY-NC-4.0':    { label: 'CC BY-NC 4.0',  url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
        'CC-BY-NC-SA-4.0': { label: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
        'CC0-1.0':         { label: 'CC0 1.0',       url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
        'DIRECT_CONSENT':  { label: "Uploaded with owner's consent", url: null },
        // Older / less common deeds (backfilled from attributions.html, not offered in the upload form)
        'CC-BY-SA-3.0':    { label: 'CC BY-SA 3.0',  url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
        'CC-BY-NC-SA-3.0': { label: 'CC BY-NC-SA 3.0', url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' },
        'CC-BY-NC-ND-3.0': { label: 'CC BY-NC-ND 3.0', url: 'https://creativecommons.org/licenses/by-nc-nd/3.0/' },
        'CC-BY-NC-ND-4.0': { label: 'CC BY-NC-ND 4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
        'SUNO_AI_FREE':    { label: 'Made with suno.ai (free plan)', url: 'https://suno.com/terms' },
    };
    const DEFAULT_SOURCE_URL = 'https://ssh-club.org/radio';

    // License tag rendered next to the [uploaded]/[original] badge.
    // CC licenses link to their deed; direct consent links to the source URL.
    function licenseTag(song) {
        const lic = LICENSES[song.license_type];
        if (!lic) return '';
        const href = lic.url || song.source_url || DEFAULT_SOURCE_URL;
        return `<span class="license"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(lic.label)}</a></span>`;
    }

    function selectedPaneHtml(song) {
        const sourceUrl = esc(song.source_url || DEFAULT_SOURCE_URL);
        return `> Selected: ${esc(song.artist)} - ${esc(song.title)}<br>` +
               `<span class="selected-meta">Retrieved from: <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${sourceUrl}</a></span>`;
    }

    function renderSongList(songs) {
        songListEl.innerHTML = '';
        if (songs.length === 0) {
            songListEl.innerHTML = '<li>No tracks found</li>';
            return;
        }
        songs.forEach(song => {
            const li = document.createElement('li');
            li.dataset.songId = song.id;
            li.innerHTML = `
            <span class="song-name"><strong>${esc(song.artist)}</strong> - ${esc(song.title)}</span>
            <span class="song-tags"><span class="badge ${esc(song.source)}">${esc(song.source)}</span>${licenseTag(song)}</span>
        `;
            li.addEventListener('click', () => {
                document.querySelectorAll('.song-list li').forEach(el => el.classList.remove('selected'));
                li.classList.add('selected');
                selectedSongId = song.id;
                requestBtn.disabled = false;
                requestStatus.innerHTML = selectedPaneHtml(song);
            });
            songListEl.appendChild(li);
        });
    }

    async function requestSelected() {
        if (!selectedSongId) return;
        requestStatus.textContent = `> Requesting...`;
        try {
            const res = await fetch('/radio/api/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songId: selectedSongId })
            });
            const data = await res.json();
            if (res.ok) {
                requestStatus.textContent = `> Queued! (${data.response.split('\n')[0]})`;
                const selectedLi = document.querySelector('.song-list li.selected');
                if (selectedLi) selectedLi.classList.add('requested');
                requestBtn.disabled = true;
                selectedSongId = null;
            } else {
                requestStatus.textContent = `> ERROR: ${data.error}`;
            }
        } catch (err) {
            requestStatus.textContent = `> NETWORK ERROR: ${err.message}`;
        }
    }

    document.getElementById('upload-btn').addEventListener('click', async () => {
        const artistInput = document.getElementById('upload-artist');
        const titleInput = document.getElementById('upload-title');
        const fileInput = document.getElementById('file-input');
        const file = fileInput.files[0];

        const artist = artistInput.value.trim();
        const title = titleInput.value.trim();
        const licenseSelect = document.getElementById('upload-license');
        const sourceInput = document.getElementById('upload-source');
        const licenseType = licenseSelect.value;
        const sourceUrl = sourceInput.value.trim();

        if (!artist || !title) return alert('Artist and title are required');
        if (!licenseType) return alert('A license is required');
        if (!file) return alert('Choose a file');

        uploadStatus.textContent = '> Uploading...';

        const formData = new FormData();
        formData.append('track', file);
        formData.append('artist', artist);
        formData.append('title', title);
        formData.append('licenseType', licenseType);
        if (sourceUrl) formData.append('sourceUrl', sourceUrl);

        try {
            const res = await fetch('/radio/api/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (res.ok) {
                uploadStatus.textContent = `> Uploaded: ${data.filename}`;
                artistInput.value = '';
                titleInput.value = '';
                licenseSelect.selectedIndex = 0;
                sourceInput.value = DEFAULT_SOURCE_URL;
                fileInput.value = '';
                loadSongs(searchInput.value);
            } else {
                uploadStatus.textContent = `> ERROR: ${data.error}`;
            }
        } catch (err) {
            uploadStatus.textContent = `> NETWORK ERROR: ${err.message}`;
        }
    });

    async function updateNowPlaying() {
        try {
            const res = await fetch('/radio/api/now-playing');
            const data = await res.json();
            let displayText = '';
            if (data.rawTitle && data.rawTitle !== 'Stream offline') {
                const parsed = parseFilename(data.rawTitle);
                displayText = `${parsed.artist} - ${parsed.title}`;
            } else {
                displayText = 'Stream offline';
            }
            nowPlayingDiv.textContent = `> NOW: ${displayText} | Listeners: ${data.listeners}`;
        } catch (e) {
            nowPlayingDiv.textContent = '> NOW: --';
        }
    }

    async function loadDocket() {
        try {
            const res = await fetch('/radio/api/docket');
            const data = await res.json();
            const laws = data.laws || [];

            const legalized = laws.filter(l => l.status === 'legalized');
            const criminalized = laws.filter(l => l.status === 'criminalized');

            const legalizedSpan = document.getElementById('legalized-docket');
            const criminalizedSpan = document.getElementById('criminalized-docket');

            function fillMarquee(items) {
                // Repeat items many times per half so the scroll strip is always
                // wider than the viewport, then double for the seamless loop.
                const repeat = 3;
                const half = Array(repeat).fill(items).join('  •  ');
                return half + '  •  ' + half;
            }

            if (legalized.length === 0) {
                legalizedSpan.textContent = '✓ Nothing is legal. Anarchy reigns.';
            } else {
                const items = legalized.map(l => `✓ ${l.text}`).join('  •  ');
                legalizedSpan.textContent = fillMarquee(items);
            }

            if (criminalized.length === 0) {
                criminalizedSpan.textContent = '✗ Nothing is criminalized. Pure freedom.';
            } else {
                const items = criminalized.map(l => `✗ ${l.text}`).join('  •  ');
                criminalizedSpan.textContent = fillMarquee(items);
            }
        } catch (e) {
            document.getElementById('legalized-docket').textContent = '✓ Docket offline';
            document.getElementById('criminalized-docket').textContent = '✗ Docket offline';
        }
    }

    // Call on page load
    loadDocket();
    // Refresh every 5 minutes
    setInterval(loadDocket, 300000);

    let searchTimer = null;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadSongs(e.target.value), 250);
    });
    requestBtn.addEventListener('click', requestSelected);
    refreshBtn.addEventListener('click', () => loadSongs(searchInput.value));

    loadSongs();
    updateNowPlaying();
    setInterval(updateNowPlaying, 15000);
});