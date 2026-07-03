const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_DATA = path.join(__dirname, 'data');

// Use /data on HF Spaces (persistent storage), fall back to __dirname/data locally
const DATA_ROOT = (fs.existsSync('/data') ? '/data' : APP_DATA);
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const URLS_PATH = path.join(DATA_ROOT, 'urls.json');
const PASSWORD_FILE = path.join(DATA_ROOT, 'admin-password.txt');
const UPLOADS_ROOT = path.join(DATA_ROOT, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || 'class-memories-secret-key-change-in-production';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_ROOT);
ensureDir(UPLOADS_ROOT);

// Migrate existing data from git-tracked data/ to persistent /data on first run
if (DATA_ROOT !== APP_DATA && !fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(APP_DATA, 'config.json'))) {
  console.log('Migrating data to persistent storage...');
  const copyRecursive = function(src, dst) {
    if (!fs.existsSync(src)) return;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) { ensureDir(d); copyRecursive(s, d); }
      else fs.copyFileSync(s, d);
    }
  };
  copyRecursive(APP_DATA, DATA_ROOT);
}

const defaultConfig = path.join(APP_DATA, 'config.json');
if (DATA_ROOT !== APP_DATA && fs.existsSync(defaultConfig)) {
  // On HF: always overwrite persistent /data/config.json from git-tracked copy
  fs.copyFileSync(defaultConfig, CONFIG_PATH);
  console.log('Config refreshed from git backup');
}
if (!fs.existsSync(CONFIG_PATH)) {
  if (fs.existsSync(defaultConfig)) {
    fs.copyFileSync(defaultConfig, CONFIG_PATH);
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ people: [], generalUrls: {} }, null, 2));
  }
}

// Restore any person deleted from /data/config.json but present in git-tracked data/
if (DATA_ROOT !== APP_DATA && fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(APP_DATA, 'config.json'))) {
  try {
    var liveConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    var gitConfig = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'config.json'), 'utf8'));
    var restored = false;
    gitConfig.people.forEach(function(gp) {
      var found = liveConfig.people.some(function(lp) { return lp.id === gp.id; });
      if (!found) {
        console.log('Restoring missing person:', gp.id, gp.name);
        liveConfig.people.push(gp);
        restored = true;
      }
    });
    if (restored) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(liveConfig, null, 2));
      console.log('Restored missing people to persistent config');
    }
  } catch (e) {
    console.log('Restore check error:', e.message);
  }
}

const persist = require('./persist');
persist.init(DATA_ROOT);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_ROOT, req.body.personId, req.body.sectionId);
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const musicStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_ROOT, req.params.id, 'music');
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname));
  }
});
const uploadMusic = multer({
  storage: musicStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp3|wav|ogg|m4a|flac|mp4|webm)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|mp3|wav|ogg|m4a|mp4|webm|mov|pdf|txt|doc|docx|zip|rar)$/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

var DEFAULT_URLS = {
  week1: '', week2: '', week3: '', week4: '', week5: '', week6: '', week7: '',
  skill1: '', skill2: '', skill3: '', skill4: '', skill5: '', skill6: '', skill7: '', skill8: '', skill9: ''
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    var backupPath = path.join(APP_DATA, 'config.json');
    if (DATA_ROOT !== APP_DATA && fs.existsSync(backupPath)) {
      console.log('DATA_ROOT config missing — restoring from git-tracked backup');
      fs.copyFileSync(backupPath, CONFIG_PATH);
    }
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  let changed = false;
  // Restore URLs from persistent /data/urls.json (survives rebuilds, no git needed)
  if (DATA_ROOT !== APP_DATA && fs.existsSync(URLS_PATH)) {
    try {
      var savedUrls = JSON.parse(fs.readFileSync(URLS_PATH, 'utf-8'));
      if (savedUrls && typeof savedUrls === 'object') {
        config.generalUrls = savedUrls;
      }
    } catch (e) { /* ignore */ }
  }
  if (!config.generalUrls) { config.generalUrls = {}; changed = true; }
  Object.keys(DEFAULT_URLS).forEach(function(k) {
    if (config.generalUrls[k] === undefined) { config.generalUrls[k] = ''; changed = true; }
  });
  config.people.forEach(p => {
    if (!p.accessToken) { p.accessToken = crypto.randomBytes(16).toString('hex'); changed = true; }
    if (!p.roadmap) { p.roadmap = []; changed = true; }
    if (!p.sections) { p.sections = []; changed = true; }
  });
  if (changed) saveConfig(config);
  return config;
}
function saveConfig(config) {
  // Always write to both DATA_ROOT (live / HF persistent) and APP_DATA (git-tracked)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  if (DATA_ROOT !== APP_DATA) {
    fs.writeFileSync(path.join(APP_DATA, 'config.json'), JSON.stringify(config, null, 2));
    // Also backup URLs to persistent storage (survives rebuilds without git)
    if (config.generalUrls) {
      try { fs.writeFileSync(URLS_PATH, JSON.stringify(config.generalUrls, null, 2)); } catch (e) {}
    }
  }
  persist.saveConfig(config);
}

function getAdminPassword() {
  if (fs.existsSync(PASSWORD_FILE)) return fs.readFileSync(PASSWORD_FILE, 'utf-8').trim();
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  return 'admin123';
}

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/admin/login');
}

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/p/:token', (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.accessToken === req.params.token);
  if (!person) return res.status(404).render('index', { error: 'Invalid or expired link' });
  if (person.type === 'friend') return res.redirect('/friend/' + req.params.token);
  if (!person.visits) person.visits = 0;
  person.visits++;
  if (person.gardenFlowers === undefined) person.gardenFlowers = 0;
  if (person.gardenFlowers < 50) person.gardenFlowers++;
  person.lastVisitDate = new Date().toISOString().split('T')[0];
  saveConfig(config);
  const cardPath = path.join(__dirname, 'public', 'cards', person.id + '.html');
  const hasCard = fs.existsSync(cardPath);
  const hasFiles = person.sections.some(function(s) { return s.items.length > 0; });
  res.render('person', { person, hasCard, hasFiles, generalUrls: config.generalUrls });
});

app.get('/friend/:token', (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.accessToken === req.params.token);
  if (!person) return res.status(404).render('index', { error: 'Invalid or expired link' });
  if (person.type !== 'friend') return res.redirect('/p/' + req.params.token);
  if (!person.visits) person.visits = 0;
  person.visits++;
  person.lastVisitDate = new Date().toISOString().split('T')[0];
  saveConfig(config);
  if (person.id === 'areeha' && fs.existsSync(path.join(__dirname, 'public', 'cards', 'areeha-birthday.html'))) {
    return res.sendFile(path.join(__dirname, 'public', 'cards', 'areeha-birthday.html'));
  }
  res.render('friend', { person });
});

app.get('/admin/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === getAdminPassword()) {
    req.session.authenticated = true;
    res.redirect('/admin');
  } else {
    res.render('login', { error: 'Wrong password' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ─── Config Backup Download ───
app.get('/admin/download-config', requireAuth, (req, res) => {
  const config = loadConfig();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=class-memories-backup-' + new Date().toISOString().split('T')[0] + '.json');
  res.send(JSON.stringify(config, null, 2));
});

// ─── Config Backup Upload ───
app.post('/admin/upload-config', requireAuth, (req, res) => {
  try {
    var data = req.body.config;
    if (!data) return res.json({ error: 'No config data received' });
    var config = JSON.parse(data);
    if (!config.people || !Array.isArray(config.people)) return res.json({ error: 'Invalid config format' });
    // Ensure all people have accessToken
    config.people.forEach(function(p) {
      if (!p.accessToken) p.accessToken = crypto.randomBytes(16).toString('hex');
      if (!p.roadmap) p.roadmap = [];
      if (!p.sections) p.sections = [];
    });
    if (!config.generalUrls) config.generalUrls = {};
    Object.keys(DEFAULT_URLS).forEach(function(k) {
      if (config.generalUrls[k] === undefined) config.generalUrls[k] = '';
    });
    saveConfig(config);
    res.json({ success: true, msg: 'Config restored with ' + config.people.length + ' people' });
  } catch (e) {
    res.json({ error: 'Failed to restore config: ' + e.message });
  }
});

app.get('/admin', requireAuth, (req, res) => {
  const config = loadConfig();
  const publicUrl = process.env.PUBLIC_URL || (req.headers['x-forwarded-proto'] || req.protocol) + '://' + (req.headers['x-forwarded-host'] || req.get('host'));
  res.render('admin', { people: config.people, generalUrls: config.generalUrls, req, publicUrl });
});

app.post('/api/person', requireAuth, (req, res) => {
  const config = loadConfig();
  const id = req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) return res.json({ error: 'Invalid name' });
  if (config.people.find(p => p.id === id)) return res.json({ error: 'Person already exists' });
  config.people.push({ id, name: req.body.name, accessToken: crypto.randomBytes(16).toString('hex'), roadmap: [], sections: [] });
  saveConfig(config);
  var saved = loadConfig();
  var p = saved.people.find(function(p) { return p.id === id; });
  res.json({ success: true, person: { id, name: req.body.name, accessToken: p ? p.accessToken : '' } });
});

app.post('/api/person/:id/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const idx = config.people.findIndex(p => p.id === req.params.id);
  if (idx !== -1) {
    const dir = path.join(UPLOADS_ROOT, req.params.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    config.people.splice(idx, 1);
    saveConfig(config);
  }
  res.json({ success: true });
});

app.post('/api/person/:id/section', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person) {
    const id = req.body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (id && !person.sections.find(s => s.id === id)) {
      person.sections.push({ id, title: req.body.title, type: req.body.type || 'other', items: [] });
      saveConfig(config);
      return res.json({ success: true, section: { id, title: req.body.title, type: req.body.type || 'other' } });
    }
    if (!id) return res.json({ error: 'Invalid section title' });
    return res.json({ error: 'Section already exists' });
  }
  res.json({ error: 'Person not found' });
});

app.post('/api/person/:id/section/:sectionId/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person) {
    const idx = person.sections.findIndex(s => s.id === req.params.sectionId);
    if (idx !== -1) {
      const dir = path.join(UPLOADS_ROOT, req.params.id, req.params.sectionId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      person.sections.splice(idx, 1);
      saveConfig(config);
    }
  }
  res.json({ success: true });
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.body.personId);
  if (!person) return res.json({ error: 'Person not found' });
  if (!req.file) return res.json({ error: 'No file uploaded' });
  const section = person.sections.find(s => s.id === req.body.sectionId);
  if (!section) return res.json({ error: 'Section not found' });
  section.items.push({
    filename: req.file.filename,
    originalName: req.file.originalname,
    title: req.body.title || req.file.originalname.replace(/\.[^/.]+$/, ''),
    releaseDate: req.body.releaseDate || new Date().toISOString().split('T')[0],
    uploadedAt: new Date().toISOString()
  });
  saveConfig(config);
  res.json({ success: true, filename: req.file.filename });
});

app.post('/api/person/:id/section/:sectionId/item/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person) {
    const section = person.sections.find(s => s.id === req.params.sectionId);
    if (section) {
      const idx = section.items.findIndex(i => i.filename === req.body.filename);
      if (idx !== -1) {
        const filePath = path.join(UPLOADS_ROOT, person.id, section.id, section.items[idx].filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        section.items.splice(idx, 1);
        saveConfig(config);
      }
    }
  }
  res.json({ success: true });
});

app.post('/api/person/:id/section/:sectionId/item/date', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person) {
    const section = person.sections.find(s => s.id === req.params.sectionId);
    if (section) {
      const item = section.items.find(i => i.filename === req.body.filename);
      if (item && req.body.releaseDate) {
        item.releaseDate = req.body.releaseDate;
        saveConfig(config);
        return res.json({ success: true });
      }
    }
  }
  res.json({ success: true });
});

app.post('/api/person/:id/roadmap/add', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.json({ error: 'Person not found' });
  if (!req.body.title) return res.json({ error: 'Title required' });
  if (!person.roadmap) person.roadmap = [];
  person.roadmap.push({ date: req.body.date || '', title: req.body.title, description: req.body.description || '' });
  saveConfig(config);
  res.json({ success: true, milestone: { title: req.body.title, date: req.body.date || '', description: req.body.description || '' } });
});

app.post('/api/person/:id/roadmap/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && person.roadmap) {
    person.roadmap.splice(parseInt(req.body.index), 1);
    saveConfig(config);
  }
  res.json({ success: true });
});

// ─── PLAYLIST ───
app.post('/api/person/:id/playlist/add', requireAuth, uploadMusic.single('file'), (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.json({ error: 'Person not found' });
  if (!person.playlist) person.playlist = [];
  if (!req.body.title) return res.json({ error: 'Title required' });
  if (req.file) {
    person.playlist.push({ title: req.body.title, filename: req.file.filename });
    saveConfig(config);
    res.json({ success: true, song: { title: req.body.title, filename: req.file.filename } });
  } else if (req.body.url) {
    person.playlist.push({ title: req.body.title, url: req.body.url });
    saveConfig(config);
    res.json({ success: true, song: { title: req.body.title, url: req.body.url } });
  } else {
    res.json({ error: 'Upload a file or provide a URL' });
  }
});

app.post('/api/person/:id/playlist/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && person.playlist) {
    person.playlist.splice(parseInt(req.body.index), 1);
    saveConfig(config);
  }
  res.json({ success: true });
});

app.post('/api/person/:id/playlist/rename', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && person.playlist && req.body.title) {
    var idx = parseInt(req.body.index);
    if (idx >= 0 && idx < person.playlist.length) {
      person.playlist[idx].title = req.body.title;
      saveConfig(config);
    }
  }
  res.json({ success: true });
});

app.post('/api/person/:id/theme', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person) {
    if (req.body.theme) person.theme = req.body.theme;
    else delete person.theme;
    person.badge = req.body.badge || '';
    person.customMessage = req.body.customMessage || '';
    saveConfig(config);
  }
  res.json({ success: true });
});

app.post('/admin/change-password', requireAuth, (req, res) => {
  if (req.body.currentPassword === getAdminPassword() && req.body.newPassword) {
    persist.savePassword(req.body.newPassword);
    res.json({ success: true, msg: 'Password changed' });
  } else {
    res.json({ error: 'Wrong current password' });
  }
});

app.post('/api/person/:id/rename', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && req.body.name) {
    person.name = req.body.name;
    saveConfig(config);
    return res.json({ success: true, name: req.body.name });
  }
  res.json({ error: 'Person not found or name empty' });
});

app.post('/api/person/:id/reason/add', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.json({ error: 'Person not found' });
  if (!req.body.reason) return res.json({ error: 'Reason required' });
  if (!person.reasons) person.reasons = [];
  person.reasons.push(req.body.reason);
  saveConfig(config);
  res.json({ success: true, reason: req.body.reason });
});

app.post('/api/person/:id/reason/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && person.reasons) {
    person.reasons.splice(parseInt(req.body.index), 1);
    saveConfig(config);
  }
  res.json({ success: true });
});

app.post('/api/person/:id/compliment/add', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.json({ error: 'Person not found' });
  if (!req.body.compliment) return res.json({ error: 'Compliment required' });
  if (!person.compliments) person.compliments = [];
  person.compliments.push(req.body.compliment);
  saveConfig(config);
  res.json({ success: true, compliment: req.body.compliment });
});

app.post('/api/person/:id/compliment/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && person.compliments) {
    person.compliments.splice(parseInt(req.body.index), 1);
    saveConfig(config);
  }
  res.json({ success: true });
});

// ─── MET DATE ───
app.post('/api/person/:id/metdate', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && req.body.metDate) {
    person.metDate = req.body.metDate;
    saveConfig(config);
    return res.json({ success: true, metDate: req.body.metDate });
  }
  res.json({ error: 'Invalid date' });
});

// ─── QUIZ ───
app.post('/api/person/:id/quiz/add', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.json({ error: 'Person not found' });
  if (!req.body.question || !req.body.options || !req.body.answer) return res.json({ error: 'Question, options, and answer required' });
  if (!person.quiz) person.quiz = [];
  person.quiz.push({ question: req.body.question, options: JSON.parse(req.body.options), answer: parseInt(req.body.answer) });
  saveConfig(config);
  res.json({ success: true, question: { question: req.body.question, options: JSON.parse(req.body.options), answer: parseInt(req.body.answer) } });
});

app.post('/api/person/:id/quiz/delete', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (person && person.quiz) {
    person.quiz.splice(parseInt(req.body.index), 1);
    saveConfig(config);
  }
  res.json({ success: true });
});

app.post('/api/general-urls', requireAuth, (req, res) => {
  const config = loadConfig();
  Object.keys(DEFAULT_URLS).forEach(function(k) {
    if (req.body[k] !== undefined) config.generalUrls[k] = req.body[k];
  });
  // Also save to persistent /data/urls.json (no git dependency)
  try { fs.writeFileSync(URLS_PATH, JSON.stringify(config.generalUrls, null, 2)); } catch (e) {}
  saveConfig(config);
  res.json({ success: true, msg: 'URLs updated' });
});

app.get('/uploads/:person/:section/:file', (req, res) => {
  const filePath = path.join(UPLOADS_ROOT, req.params.person, req.params.section, req.params.file);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send('File not found');
});

// ─── ZIP DOWNLOAD ───
app.get('/api/person/:id/download', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.status(404).send('Person not found');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=' + person.id + '-memories.zip');

  const archive = new archiver.ZipArchive();
  archive.on('error', function(err) { if (!res.headersSent) res.status(500).send('Archive error: ' + err.message); });

  const personDir = path.join(UPLOADS_ROOT, person.id);
  if (fs.existsSync(personDir)) {
    archive.directory(personDir, person.id);
  }

  // Add a manifest with all items (including external URL items)
  var manifest = 'Memories for ' + person.name + '\n';
  manifest += 'Generated: ' + new Date().toISOString().split('T')[0] + '\n\n';
  person.sections.forEach(function(s) {
    if (s.items.length === 0) return;
    manifest += '\n--- ' + s.title + ' (' + s.type + ') ---\n';
    s.items.forEach(function(item) {
      var isExternal = item.filename.indexOf('http') === 0;
      manifest += '  - ' + item.title + '\n';
      manifest += '    URL: ' + (isExternal ? item.filename : '/uploads/' + person.id + '/' + s.id + '/' + item.filename) + '\n';
    });
  });
  archive.append(manifest, { name: person.id + '/MEMORIES_MANIFEST.txt' });

  archive.pipe(res);
  archive.finalize().catch(function(err) { if (!res.headersSent) res.status(500).send('Finalize error: ' + err.message); });
});

// ─── AUDIO RECORDING UPLOAD ───
app.post('/api/person/:id/record-voice', requireAuth, (req, res) => {
  const config = loadConfig();
  const person = config.people.find(p => p.id === req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });

  const vmSection = person.sections.find(s => s.type === 'voice');
  if (!vmSection) return res.status(400).json({ error: 'No voice section found; create one first' });

  const audioBuffer = Buffer.from(req.body.audio, 'base64');
  const filename = 'recording-' + Date.now() + '.wav';
  const dir = path.join(UPLOADS_ROOT, person.id, vmSection.id);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, filename), audioBuffer);

  vmSection.items.push({
    filename: filename,
    originalName: filename,
    title: req.body.title || 'Voice recording',
    releaseDate: req.body.releaseDate || new Date().toISOString().split('T')[0],
    uploadedAt: new Date().toISOString()
  });
  saveConfig(config);
  res.json({ success: true, filename: filename });
});

// ─── EESHAH FEATURES CRUD ───
// Helper for simple array features
function addArrayItem(person, field, value) {
  if (!person[field]) person[field] = [];
  person[field].push(value);
}
function deleteArrayItem(person, field, index) {
  if (person[field] && person[field][index]) {
    person[field].splice(parseInt(index), 1);
  }
}

// checkIns
app.post('/api/person/:id/checkin/add', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.text) return res.json({ error: 'Text required' });
  addArrayItem(p, 'checkIns', req.body.text); saveConfig(cfg);
  res.json({ success: true });
});
app.post('/api/person/:id/checkin/delete', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  deleteArrayItem(p, 'checkIns', req.body.index); saveConfig(cfg);
  res.json({ success: true });
});

// unreadThoughts
app.post('/api/person/:id/unreadthought/add', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.text) return res.json({ error: 'Text required' });
  addArrayItem(p, 'unreadThoughts', req.body.text); saveConfig(cfg);
  res.json({ success: true });
});
app.post('/api/person/:id/unreadthought/delete', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  deleteArrayItem(p, 'unreadThoughts', req.body.index); saveConfig(cfg);
  res.json({ success: true });
});

// moodResponses (object: key -> value)
app.post('/api/person/:id/moodresponse/set', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.key || !req.body.text) return res.json({ error: 'Key and text required' });
  if (!p.moodResponses) p.moodResponses = {};
  p.moodResponses[req.body.key] = req.body.text; saveConfig(cfg);
  res.json({ success: true });
});

// ifTodayFeels (object: key -> value)
app.post('/api/person/:id/iftodayfeel/set', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.key || !req.body.text) return res.json({ error: 'Key and text required' });
  if (!p.ifTodayFeels) p.ifTodayFeels = {};
  p.ifTodayFeels[req.body.key] = req.body.text; saveConfig(cfg);
  res.json({ success: true });
});

// memories
app.post('/api/person/:id/memory/add', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.text) return res.json({ error: 'Text required' });
  addArrayItem(p, 'memories', req.body.text); saveConfig(cfg);
  res.json({ success: true });
});
app.post('/api/person/:id/memory/delete', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  deleteArrayItem(p, 'memories', req.body.index); saveConfig(cfg);
  res.json({ success: true });
});

// observations
app.post('/api/person/:id/observation/add', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.text) return res.json({ error: 'Text required' });
  addArrayItem(p, 'observations', req.body.text); saveConfig(cfg);
  res.json({ success: true });
});
app.post('/api/person/:id/observation/delete', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  deleteArrayItem(p, 'observations', req.body.index); saveConfig(cfg);
  res.json({ success: true });
});

// openWhen (object: key -> value)
app.post('/api/person/:id/openwhen/set', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.key || !req.body.text) return res.json({ error: 'Key and text required' });
  if (!p.openWhen) p.openWhen = {};
  p.openWhen[req.body.key] = req.body.text; saveConfig(cfg);
  res.json({ success: true });
});

// reminders
app.post('/api/person/:id/reminder/add', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.text) return res.json({ error: 'Text required' });
  addArrayItem(p, 'reminders', req.body.text); saveConfig(cfg);
  res.json({ success: true });
});
app.post('/api/person/:id/reminder/delete', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  deleteArrayItem(p, 'reminders', req.body.index); saveConfig(cfg);
  res.json({ success: true });
});

// proudMessages
app.post('/api/person/:id/proudmessage/add', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!req.body.text) return res.json({ error: 'Text required' });
  addArrayItem(p, 'proudMessages', req.body.text); saveConfig(cfg);
  res.json({ success: true });
});
app.post('/api/person/:id/proudmessage/delete', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  deleteArrayItem(p, 'proudMessages', req.body.index); saveConfig(cfg);
  res.json({ success: true });
});

// safeSpace (object: question, gentle, responses.key -> value)
app.post('/api/person/:id/safespace/set', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!p.safeSpace) p.safeSpace = { question: '', gentle: '', responses: {} };
  if (req.body.question !== undefined) p.safeSpace.question = req.body.question;
  if (req.body.gentle !== undefined) p.safeSpace.gentle = req.body.gentle;
  if (req.body.responseKey && req.body.responseText !== undefined) {
    if (!p.safeSpace.responses) p.safeSpace.responses = {};
    p.safeSpace.responses[req.body.responseKey] = req.body.responseText;
  }
  saveConfig(cfg);
  res.json({ success: true });
});

// ─── FEATURE LOCK DATES ───
app.post('/api/person/:id/feature-lock-dates', requireAuth, (req, res) => {
  const cfg = loadConfig(); const p = cfg.people.find(x => x.id === req.params.id);
  if (!p) return res.json({ error: 'Not found' });
  if (!p.featureReleaseDates) p.featureReleaseDates = {};
  Object.keys(req.body).forEach(function(k) {
    p.featureReleaseDates[k] = req.body[k] || '';
  });
  saveConfig(cfg);
  res.json({ success: true, msg: 'Lock dates saved' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.json({ error: 'File too large (max 100MB)' });
  }
  if (err.message === 'File type not allowed') {
    return res.json({ error: 'File type not allowed. Use mp3, wav, ogg, m4a, flac, mp4, or webm.' });
  }
  if (req.xhr || req.headers.accept && req.headers.accept.indexOf('json') > -1) {
    return res.json({ error: err.message || 'Something went wrong' });
  }
  res.status(500).send('Something went wrong');
});

app.listen(PORT, () => {
  console.log(`Class Memories running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
});
