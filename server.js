const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(session({
    secret: 'cartivo_super_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 } // 1 hour
}));

// ---------- Database setup ----------
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT,
        user_agent TEXT,
        page TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        instagram_handle TEXT,
        contact_name TEXT,
        image_url TEXT,
        status TEXT DEFAULT 'open',
        earnings REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        description TEXT,
        date DATE DEFAULT CURRENT_DATE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        instagram_handle TEXT NOT NULL,
        email TEXT NOT NULL,
        special_request TEXT,
        image_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ---------- Admin login lockout (by IP) ----------
const loginAttempts = new Map(); // key: ip, value: { count, lockUntil }

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

function isLocked(ip) {
    const record = loginAttempts.get(ip);
    if (!record) return false;
    if (record.lockUntil && Date.now() < record.lockUntil) return true;
    if (record.lockUntil && Date.now() >= record.lockUntil) {
        loginAttempts.delete(ip);
        return false;
    }
    return false;
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    let record = loginAttempts.get(ip);
    if (!record) {
        record = { count: 1, lockUntil: null };
    } else {
        record.count += 1;
        if (record.count >= 5) {
            record.lockUntil = now + 60 * 60 * 1000; // 1 hour lock
        }
    }
    loginAttempts.set(ip, record);
    return record.count;
}

// Admin login endpoint (with 5s delay per failure & lockout)
app.post('/api/admin/login', async (req, res) => {
    const ip = getClientIp(req);
    const { password } = req.body;

    // Check lockout
    if (isLocked(ip)) {
        return res.status(403).json({ error: 'Too many failed attempts. Account locked for 1 hour.' });
    }

    // Simulate 5 sec delay for any failed attempt
    const correctPassword = 'cartivo2026'; // change this

    if (password !== correctPassword) {
        const count = recordFailedAttempt(ip);
        // Delay 5 seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
        return res.status(401).json({ error: `Invalid password. Attempt ${count}/5.` });
    }

    // Success: reset attempts for this IP
    loginAttempts.delete(ip);
    req.session.admin = true;
    res.json({ success: true });
});

// Check if admin is logged in (middleware)
function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// Logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ---------- Visitor Tracking ----------
app.post('/api/track', (req, res) => {
    const { page } = req.body;
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];
    db.run(`INSERT INTO visitors (ip, user_agent, page) VALUES (?, ?, ?)`, [ip, userAgent, page]);
    res.json({ success: true });
});

// ---------- Lead form submission (landing page) ----------
app.post('/api/leads', upload.single('image'), (req, res) => {
    const { business_name, instagram_handle, email, special_request } = req.body;
    const image_path = req.file ? `/uploads/${req.file.filename}` : null;
    if (!business_name || !email) {
        return res.status(400).json({ error: 'Business name and email are required' });
    }
    db.run(`INSERT INTO leads (business_name, instagram_handle, email, special_request, image_path) VALUES (?, ?, ?, ?, ?)`,
        [business_name, instagram_handle, email, special_request, image_path], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});

// ---------- Projects CRUD ----------
app.get('/api/projects', requireAdmin, (req, res) => {
    db.all(`SELECT * FROM projects ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/projects/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM projects WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Project not found' });
        res.json(row);
    });
});

app.post('/api/projects', requireAdmin, (req, res) => {
    const { business_name, instagram_handle, contact_name, image_url } = req.body;
    if (!business_name) return res.status(400).json({ error: 'Business name required' });
    db.run(`INSERT INTO projects (business_name, instagram_handle, contact_name, image_url) VALUES (?, ?, ?, ?)`,
        [business_name, instagram_handle || '', contact_name || '', image_url || ''], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, success: true });
        });
});

app.put('/api/projects/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { business_name, instagram_handle, contact_name, image_url } = req.body;
    db.run(`UPDATE projects SET business_name = ?, instagram_handle = ?, contact_name = ?, image_url = ? WHERE id = ?`,
        [business_name, instagram_handle, contact_name, image_url, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.put('/api/projects/:id/complete', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { earnings } = req.body;
    const completedAt = new Date().toISOString();
    let query = `UPDATE projects SET status = 'completed', completed_at = ?`;
    let params = [completedAt];
    if (earnings !== undefined) {
        query += `, earnings = ?`;
        params.push(earnings);
    }
    params.push(id);
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/projects/:id/earnings', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount required' });
    db.run(`UPDATE projects SET earnings = earnings + ? WHERE id = ?`, [amount, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ---------- Expenses ----------
app.post('/api/expenses', requireAdmin, (req, res) => {
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount required' });
    db.run(`INSERT INTO expenses (amount, description) VALUES (?, ?)`, [amount, description || ''], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ---------- Analytics ----------
app.get('/api/analytics', requireAdmin, (req, res) => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const monthStart = `${currentYear}-${currentMonth.toString().padStart(2,'0')}-01`;
    
    db.get(`SELECT SUM(earnings) as totalEarningsAll FROM projects WHERE status = 'completed'`, (err, allEarnings) => {
        db.get(`SELECT SUM(earnings) as monthlyEarnings FROM projects WHERE status = 'completed' AND completed_at >= ?`, [monthStart], (err, monthlyEarnings) => {
            db.get(`SELECT SUM(amount) as monthlySpent FROM expenses WHERE date >= ?`, [monthStart], (err, monthlySpent) => {
                db.get(`SELECT COUNT(*) as openProjects FROM projects WHERE status = 'open'`, (err, openCount) => {
                    db.get(`SELECT COUNT(*) as completedProjects FROM projects WHERE status = 'completed'`, (err, completedCount) => {
                        res.json({
                            totalEarningsAll: allEarnings?.totalEarningsAll || 0,
                            monthlyEarnings: monthlyEarnings?.monthlyEarnings || 0,
                            monthlySpent: monthlySpent?.monthlySpent || 0,
                            openProjects: openCount?.openProjects || 0,
                            completedProjects: completedCount?.completedProjects || 0
                        });
                    });
                });
            });
        });
    });
});

// ---------- Visitors ----------
app.get('/api/visitors', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    db.all(`SELECT * FROM visitors ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ---------- Leads ----------
app.get('/api/leads', requireAdmin, (req, res) => {
    db.all(`SELECT * FROM leads ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Serve static HTML pages
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/project/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'project-detail.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
});
