'use strict';
/* Google Drive bağlantısı ve cihazlar arası eşitleme.
   - Giriş: Google OAuth (yönlendirmeli), sadece Google Cloud'da "test kullanıcısı" olarak eklenen hesap girebilir.
   - Veriler: Drive'da "Rusça Defterim/rusca-data.json"
   - Klip videoları: "Rusça Defterim/Videolar" (Drive'daki kendi klasörlerinden açılan videolar tekrar yüklenmez)
   - Kaynak klasörler: kullanıcının seçtiği Drive klasörleri (ör. Learning Russing/Photo) toplu içe aktarılır. */
const GOOGLE_CLIENT_ID = '1043102652065-8js13bh3v36842v0vnunlkrimjkt8s96.apps.googleusercontent.com'; // OAuth istemci kimliği (gizli bilgi değildir)

const Drive = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const API = 'https://www.googleapis.com/drive/v3/', UP = 'https://www.googleapis.com/upload/drive/v3/';
  const ROOT = 'Rusça Defterim', VIDS = 'Videolar', DATA = 'rusca-data.json', FOLDER = 'application/vnd.google-apps.folder';
  const TK = 'rusca-drive-token';
  let tok = null, ids = {}, timer = null, busy = false, again = false, inSync = false, status = 'off', lastMsg = '';

  const cid = () => (DB.settings.gClientId || GOOGLE_CLIENT_ID || '').trim();
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const connected = () => { loadTok(); return !!tok; };

  function setStatus(s, msg) {
    status = s; lastMsg = msg || '';
    const label = { off: '☁️ Drive kapalı', need: '☁️ Bağlan', sync: '☁️ Eşitleniyor…', ok: '☁️ Eşitlendi', err: '☁️ Hata' }[s];
    const el = $('#syncPill');
    if (el) { el.textContent = label; el.title = msg || label; el.dataset.s = s; el.hidden = s === 'off'; }
    const st = $('#driveStatus'); if (st) st.textContent = msg || label;
  }
  function loadTok() {
    try { const t = JSON.parse(localStorage.getItem(TK) || 'null'); tok = t && t.exp > Date.now() + 60e3 ? t : null; } catch (e) { tok = null; }
  }

  /* ---------- Giriş ---------- */
  function login() {
    if (!cid()) { toast('Önce Ayarlar’a Google istemci kimliğini (Client ID) gir'); show('settings'); return; }
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('gstate', state);
    const p = new URLSearchParams({ client_id: cid(), redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state });
    if (DB.settings.gEmail) p.set('login_hint', DB.settings.gEmail);
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  }
  function handleRedirect() {
    const h = location.hash;
    if (!/access_token=|error=/.test(h)) return;
    const q = new URLSearchParams(h.slice(1));
    history.replaceState(null, '', redirectUri());
    if (q.get('error')) { toast('Google girişi yapılamadı: ' + q.get('error')); return; }
    if (q.get('state') !== sessionStorage.getItem('gstate')) { toast('Giriş doğrulanamadı, tekrar dene'); return; }
    tok = { t: q.get('access_token'), exp: Date.now() + (+q.get('expires_in') || 3600) * 1000 };
    localStorage.setItem(TK, JSON.stringify(tok));
    if (!DB.settings.drive) { DB.settings.drive = true; persist(); }
    toast('Google Drive’a bağlandı');
  }
  function logout() {
    if (tok) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tok.t), { method: 'POST' }).catch(() => {});
    tok = null; ids = {}; localStorage.removeItem(TK); DB.settings.drive = false; persist(); setStatus('off');
  }

  /* ---------- Drive API yardımcıları ---------- */
  async function api(url, opt = {}) {
    loadTok(); if (!tok) throw new Error('NOAUTH');
    const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + tok.t } });
    if (r.status === 401) { tok = null; localStorage.removeItem(TK); throw new Error('NOAUTH'); }
    if (!r.ok) throw new Error('Drive ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return r;
  }
  const json = async (u, o) => (await api(u, o)).json();
  const qs = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function list(q, fields = 'files(id,name,mimeType,size,modifiedTime,thumbnailLink)', orderBy = 'name') {
    let out = [], pageToken = '';
    do {
      const p = new URLSearchParams({ q, fields: 'nextPageToken,' + fields, pageSize: '200', orderBy, spaces: 'drive' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await json(API + 'files?' + p); out = out.concat(r.files || []); pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  async function folder(name, parent) {
    const k = parent + '/' + name; if (ids[k]) return ids[k];
    const f = await list(`name='${qs(name)}' and mimeType='${FOLDER}' and '${parent}' in parents and trashed=false`, 'files(id)');
    if (f.length) return ids[k] = f[0].id;
    const c = await json(API + 'files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
    return ids[k] = c.id;
  }
  const root = () => folder(ROOT, 'root');
  const subfolders = parent => list(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
  const filesIn = parent => list(`'${parent}' in parents and mimeType!='${FOLDER}' and trashed=false`);
  async function download(id) { return (await api(API + 'files/' + id + '?alt=media')).blob(); }
  const meta = id => json(API + 'files/' + encodeURIComponent(id) + '?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true');
  async function readText(f) { // Google Dokümanlar dışa aktarılır, diğer metin dosyaları doğrudan okunur
    if (f.mimeType === 'application/vnd.google-apps.document') return (await api(API + 'files/' + f.id + '/export?mimeType=text/plain')).text();
    return (await download(f.id)).text();
  }
  async function uploadBlob(blob, name, parent) {
    const r = await api(UP + 'files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify({ name, parents: [parent] })
    });
    const loc = r.headers.get('Location'); if (!loc) throw new Error('Yükleme adresi alınamadı');
    return (await (await api(loc, { method: 'PUT', body: blob })).json()).id;
  }
  const trash = id => api(API + 'files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });

  /* ---------- Veri dosyası ---------- */
  async function dataFileId() {
    if (ids.data) return ids.data;
    const f = await list(`name='${DATA}' and '${await root()}' in parents and trashed=false`, 'files(id)');
    return ids.data = f[0]?.id || null;
  }
  async function readRemote() { const id = await dataFileId(); return id ? json(API + 'files/' + id + '?alt=media') : null; }
  async function writeRemote(obj) {
    const body = JSON.stringify(obj), id = await dataFileId();
    if (id) { await api(UP + 'files/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }); return; }
    const b = 'rusca' + Date.now(), meta = { name: DATA, parents: [await root()], mimeType: 'application/json' };
    const mp = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    ids.data = (await json(UP + 'files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: mp })).id;
  }

  /* ---------- Birleştirme ---------- */
  const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
  const payload = () => ({ items: [...DB.items].sort((a, b) => a.id < b.id ? -1 : 1), deleted: DB.deleted, imported: DB.imported });
  function merge(remote) {
    const old = Date.now() - 90 * 864e5;
    const del = { ...(remote.deleted || {}) };
    for (const [k, t] of Object.entries(DB.deleted)) del[k] = Math.max(del[k] || 0, t);
    for (const k in del) if (del[k] < old) delete del[k];
    const map = new Map();
    for (const it of remote.items || []) map.set(it.id, it);
    for (const it of DB.items) { const r = map.get(it.id); if (!r || (it.upd || 0) >= (r.upd || 0)) map.set(it.id, it); }
    for (const [id, t] of Object.entries(del)) { const it = map.get(id); if (it && (it.upd || 0) <= t) map.delete(id); }
    // aynı kelime iki cihazda ayrı eklendiyse: yenisini tut
    const words = new Map();
    for (const it of [...map.values()]) {
      if (it.type !== 'word') continue;
      const k = norm(it.ru), o = words.get(k);
      if (!o) { words.set(k, it); continue; }
      const [keep, drop] = (it.upd || 0) >= (o.upd || 0) ? [it, o] : [o, it];
      if (!keep.tr && drop.tr) keep.tr = drop.tr;
      map.delete(drop.id); del[drop.id] = Date.now(); words.set(k, keep);
    }
    DB.items = [...map.values()]; DB.deleted = del;
    DB.imported = { ...(remote.imported || {}), ...DB.imported };
  }

  /* ---------- Eşitleme ---------- */
  async function uploadPendingVideos() {
    const pending = [...new Set(DB.items.filter(i => i.type === 'clip' && !i.driveId).map(i => i.videoId))];
    for (const vid of pending) {
      const blob = await idbGet(vid); if (!blob) continue;
      const clip = DB.items.find(i => i.videoId === vid);
      setStatus('sync', 'Video Drive’a yükleniyor: ' + (clip.video || '') + ' (' + Math.round(blob.size / 1048576) + ' MB)');
      const id = await uploadBlob(blob, clip.video || (vid + '.mp4'), await folder(VIDS, await root()));
      for (const c of DB.items) if (c.videoId === vid) { c.driveId = id; c.driveOwned = true; }
    }
  }
  async function sync() {
    if (!DB.settings.drive) { setStatus('off'); return; }
    if (!connected()) { setStatus('need', 'Drive eşitlemesi için bağlan'); return; }
    if (busy) { again = true; return; }
    busy = true; inSync = true; again = false; setStatus('sync');
    try {
      const remote = await readRemote();
      if (remote) { merge(remote); rebuildSnap(); }
      await uploadPendingVideos(); track();
      const local = payload();
      if (!remote || canon(local) !== canon({ items: [...(remote.items || [])].sort((a, b) => a.id < b.id ? -1 : 1), deleted: remote.deleted || {}, imported: remote.imported || {} }))
        await writeRemote({ ...local, v: 1, at: Date.now() });
      persist(); reindex(); updatePills(); refreshView(); refreshSpans();
      setStatus('ok', 'Son eşitleme: ' + new Date().toLocaleTimeString('tr-TR'));
    } catch (e) {
      if (e.message === 'NOAUTH') setStatus('need', 'Google oturumunun süresi doldu — tekrar bağlan');
      else { setStatus('err', 'Eşitleme hatası: ' + e.message); console.warn(e); }
    } finally {
      busy = false; inSync = false;
      if (again) { again = false; schedule(800); }
    }
  }
  function schedule(ms = 4000) {
    if (!DB.settings.drive) return;
    if (inSync) { again = true; return; }
    clearTimeout(timer); timer = setTimeout(sync, ms);
  }

  /* ---------- Başlangıç ---------- */
  function init() {
    handleRedirect(); loadTok();
    if (!DB.settings.drive) { setStatus('off'); return; }
    if (tok) { schedule(300); return; }
    // süresi dolmuşsa oturum başına bir kez otomatik yeniden bağlan (izin daha önce verildiği için hızlıca geri döner)
    if (!sessionStorage.getItem('gauto') && cid()) { sessionStorage.setItem('gauto', '1'); login(); return; }
    setStatus('need', 'Drive eşitlemesi için bağlan');
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && DB.settings.drive && connected()) schedule(800); });

  return window.Drive = { init, login, logout, sync, schedule, connected, download, meta, readText, uploadBlob, trash, subfolders, filesIn, root, folder, status: () => status, msg: () => lastMsg, clientId: cid };
})();
