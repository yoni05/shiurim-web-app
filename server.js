const express = require('express');
const ytdl = require('@distube/ytdl-core');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();

const invidiousHosts = [
    'https://yt.chocolatemoo53.com',
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
    'https://invidious.privacyredirect.com',
    'https://inv.nadeko.net'
];

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

// 1. חיפוש שיעורים דרך YouTube Data API v3 (וגיבוי אוטומטי אם חסר מפתח)
app.get('/api/search', async (req, res) => {
    const q = (req.query.q || 'שיעור תורה הלכה').trim();

    if (YT_KEY) {
        try {
            const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&safeSearch=strict&maxResults=12&key=${YT_KEY}`;
            const ytRes = await fetchWithTimeout(ytUrl, {}, 9000);
            const ytData = await ytRes.json();

            if (ytRes.ok && ytData.items) {
                const items = ytData.items.map(it => ({
                    videoId: it.id.videoId,
                    title: it.snippet.title,
                    channel: it.snippet.channelTitle,
                    publishedAt: it.snippet.publishedAt ? new Date(it.snippet.publishedAt).toLocaleDateString('he-IL') : ''
                }));
                return res.json({ items });
            } else {
                console.error('[YT API Error]', JSON.stringify(ytData));
            }
        } catch (e) {
            console.error('[YT Search Exception]', e.message);
        }
    }

    // גיבוי חיפוש דרך שרתי Invidious במידה ולא הוזן מפתח
    for (const host of invidiousHosts) {
        try {
            const r = await fetchWithTimeout(`${host}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 5000);
            if (r.ok) {
                const data = await r.json();
                const items = (data || []).filter(x => x.videoId).slice(0, 12).map(x => ({
                    videoId: x.videoId,
                    title: x.title,
                    channel: x.author || 'ערוץ שיעורים',
                    publishedAt: x.publishedText || ''
                }));
                if (items.length > 0) return res.json({ items });
            }
        } catch (e) {}
    }

    return res.status(500).json({ error: 'לא ניתן לבצע חיפוש כעת. ודא שהזנת YOUTUBE_API_KEY תקין בהגדרות Render.' });
});

// 2. הזרמת שמע והורדת קובץ שמע
app.get('/api/audio/:id', async (req, res) => {
    const videoId = req.params.id;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).send('Invalid Video ID');
    }

    // ניסיון הזרמה מהיר דרך פרוקסי
    for (const host of invidiousHosts) {
        try {
            const streamUrl = `${host}/latest_version?id=${videoId}&itag=140&local=true`;
            const r = await fetchWithTimeout(streamUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 6000);

            if (r.ok && r.body) {
                const cType = (r.headers.get('content-type') || '').toLowerCase();
                if (!cType.includes('text/html') && !cType.includes('application/json')) {
                    res.setHeader('Content-Type', 'audio/mp4');
                    if (req.query.dl === '1') {
                        res.setHeader('Content-Disposition', `attachment; filename="shiur_${videoId}.m4a"`);
                    }
                    for await (const chunk of r.body) {
                        res.write(chunk);
                    }
                    return res.end();
                }
            }
        } catch (e) {}
    }

    // גיבוי הזרמה דרך ytdl-core
    try {
        res.setHeader('Content-Type', 'audio/mp4');
        if (req.query.dl === '1') {
            res.setHeader('Content-Disposition', `attachment; filename="shiur_${videoId}.m4a"`);
        }
        const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
            filter: 'audioonly',
            quality: 'lowestaudio'
        });
        st.on('error', err => {
            console.error('[YTDL Error]', err.message);
            if (!res.headersSent) res.status(500).end();
        });
        st.pipe(res);
    } catch (e) {
        if (!res.headersSent) res.status(500).send('Stream error');
    }
});

// 3. ממשק האפליקציה המלא (מוגש בנתיב הראשי)
const HTML_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ספריית שיעורים - חיפוש והאזנה</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--hover:#334155;--ink:#f8fafc;--mut:#94a3b8;--acc:#10b981;--accink:#052e16;--line:#334155}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 20px;position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.logo{font-size:20px;font-weight:800;color:var(--acc);cursor:pointer}
.search-bar{flex:1;max-width:540px;display:flex;gap:8px}
.search-bar input{flex:1;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
.search-bar input:focus{outline:2px solid var(--acc)}
button,.btn{background:var(--acc);color:var(--accink);border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
button.sec,.btn.sec{background:var(--hover);color:var(--ink);font-weight:500}
button:disabled{opacity:.5;cursor:wait}
.cats{display:flex;gap:8px;padding:12px 20px;overflow-x:auto;border-bottom:1px solid var(--line)}
.cat{background:var(--card);color:var(--ink);border:1px solid var(--line);padding:6px 14px;border-radius:99px;font-size:14px;cursor:pointer;white-space:nowrap}
.cat.active,.cat:hover{background:var(--acc);color:var(--accink);border-color:var(--acc);font-weight:700}
main{max-width:1180px;margin:0 auto;padding:20px}
#playerBox{display:none;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:24px}
.video-wrap{aspect-ratio:16/9;width:100%;max-width:740px;background:#000;border-radius:8px;overflow:hidden;margin-bottom:12px}
.video-wrap iframe{width:100%;height:100%;border:0}
.audio-wrap{background:var(--bg);padding:14px;border-radius:8px;border:1px solid var(--line);margin-top:10px}
.audio-wrap audio{width:100%;margin-top:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;transition:.15s}
.card:hover{border-color:var(--acc);transform:translateY(-2px)}
.card-icon{height:84px;border-radius:8px;background:linear-gradient(135deg,#064e3b,#0f172a);display:flex;align-items:center;justify-content:center;font-size:30px;color:var(--acc);margin-bottom:12px}
.card h3{font-size:16px;margin:0 0 8px;line-height:1.4}
.meta{font-size:13px;color:var(--mut);display:flex;justify-content:space-between;margin-top:8px}
#status{text-align:center;padding:30px;color:var(--mut)}
</style>
</head>
<body>
<header>
  <div class="logo" onclick="doSearch('שיעור תורה הלכה')">▶ מאגר שיעורים</div>
  <form class="search-bar" onsubmit="onFormSubmit(event)">
    <input id="qInput" type="text" placeholder="חפש שיעור, נושא, הלכה או שם רב...">
    <button type="submit" id="sBtn">חפש</button>
  </form>
</header>
<nav class="cats">
  <button class="cat active" onclick="pickCat('שיעור תורה הלכה', this)">הלכה ושיעורים</button>
  <button class="cat" onclick="pickCat('שיעור פרשת השבוע', this)">פרשת השבוע</button>
  <button class="cat" onclick="pickCat('שיעור הדף היומי גמרא', this)">הדף היומי</button>
  <button class="cat" onclick="pickCat('נפלאות הבריאה טבע', this)">נפלאות הבריאה</button>
  <button class="cat" onclick="pickCat('היסטוריה יהודית שיעור', this)">היסטוריה יהודית</button>
</nav>
<main>
  <section id="playerBox">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <h2 id="pTitle" style="margin:0;font-size:18px"></h2>
      <button class="sec" onclick="closePlayer()">סגור נגן ✕</button>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <button id="bVid" onclick="setMode('video')">צפייה בווידאו</button>
      <button id="bAud" class="sec" onclick="setMode('audio')">האזנה לשמע בלבד</button>
      <a id="dlBtn" class="btn sec" href="#" download>⬇ הורדת שמע</a>
    </div>
    <div id="vBox" class="video-wrap"></div>
    <div id="aBox" class="audio-wrap" style="display:none">
      <div style="font-size:14px;color:var(--mut)">הזרמת שמע ישירה מהשרת:</div>
      <audio id="aPlayer" controls preload="none"></audio>
    </div>
  </section>
  <div id="status">טוען שיעורים...</div>
  <div id="grid" class="grid"></div>
</main>
<script>
let curId = null;
async function doSearch(q) {
  const st = document.getElementById('status');
  const gr = document.getElementById('grid');
  const btn = document.getElementById('sBtn');
  st.style.display = 'block';
  st.textContent = 'מחפש: "' + q + '"...';
  gr.innerHTML = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    const d = await r.json();
    btn.disabled = false;
    if (!r.ok || !d.items || !d.items.length) {
      st.textContent = d.error || 'לא נמצאו תוצאות.';
      return;
    }
    st.style.display = 'none';
    d.items.forEach(item => {
      const c = document.createElement('div');
      c.className = 'card';
      c.onclick = () => openItem(item);
      c.innerHTML = '<div><div class="card-icon">▶</div><h3>' + item.title + '</h3></div>' +
        '<div class="meta"><span>' + (item.channel || '') + '</span><span>' + (item.publishedAt || '') + '</span></div>';
      gr.appendChild(c);
    });
  } catch (e) {
    btn.disabled = false;
    st.textContent = 'שגיאת תקשורת עם השרת.';
  }
}
function onFormSubmit(e) {
  e.preventDefault();
  const v = document.getElementById('qInput').value.trim();
  if (v) doSearch(v);
}
function pickCat(q, b) {
  document.querySelectorAll('.cat').forEach(x => x.classList.remove('active'));
  if (b) b.classList.add('active');
  document.getElementById('qInput').value = q;
  doSearch(q);
}
function openItem(item) {
  curId = item.videoId;
  document.getElementById('playerBox').style.display = 'block';
  document.getElementById('pTitle').textContent = item.title;
  document.getElementById('dlBtn').href = '/api/audio/' + curId + '?dl=1';
  setMode('video');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setMode(m) {
  if (!curId) return;
  const vb = document.getElementById('vBox');
  const ab = document.getElementById('aBox');
  const ap = document.getElementById('aPlayer');
  if (m === 'video') {
    ap.pause(); ap.src = '';
    ab.style.display = 'none';
    vb.style.display = 'block';
    vb.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + curId + '?autoplay=1&rel=0" allowfullscreen allow="autoplay"></iframe>';
    document.getElementById('bVid').className = '';
    document.getElementById('bAud').className = 'sec';
  } else {
    vb.innerHTML = '';
    vb.style.display = 'none';
    ab.style.display = 'block';
    ap.src = '/api/audio/' + curId;
    ap.play().catch(() => {});
    document.getElementById('bVid').className = 'sec';
    document.getElementById('bAud').className = '';
  }
}
function closePlayer() {
  curId = null;
  document.getElementById('vBox').innerHTML = '';
  const ap = document.getElementById('aPlayer');
  ap.pause(); ap.src = '';
  document.getElementById('playerBox').style.display = 'none';
}
doSearch('שיעור תורה הלכה');
<` + `/script>
</body>
</html>`;

app.get('*', (req, res) => {
    res.type('text/html; charset=utf-8').send(HTML_PAGE);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Web App Server Ready on port ${port} ===`));
