import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import bcrypt from 'bcryptjs';
import db from './db/index.js';
import { z } from 'zod';

const app = express();
const __dirname = process.cwd();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false
}));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

const setFlash = (req, type, message) => {
  req.session.flash = { type, message };
};

const requireAuth = (req, res, next) => req.session.user ? next() : res.redirect('/login');
const requireRole = (role) => (req, res, next) => req.session.user?.role === role ? next() : res.redirect('/');
const requireAdmin = (req, res, next) => req.session.user?.role === 'admin' ? next() : res.redirect('/login');
const requireGuest = (req, res, next) => req.session.user ? redirectDashboard(res, req.session.user) : next();

function getWorkerByUser(userId) {
  return db.prepare('SELECT * FROM workers WHERE user_id=?').get(userId);
}

function getCompanyByUser(userId) {
  return db.prepare('SELECT * FROM companies WHERE user_id=?').get(userId);
}

function updateRating(userId, role) {
  const row = db.prepare('SELECT AVG(stars) avg_rating, COUNT(*) review_count FROM reviews WHERE to_user_id=?').get(userId);
  const table = role === 'worker' ? 'workers' : 'companies';
  db.prepare(`UPDATE ${table} SET avg_rating=?, review_count=? WHERE user_id=?`)
    .run(Number(row.avg_rating || 0).toFixed(2), row.review_count || 0, userId);
}

function redirectDashboard(res, user) {
  if (user.role === 'admin') return res.redirect('/admin/leads');
  if (user.role === 'worker') return res.redirect('/worker/dashboard');
  if (user.role === 'company') return res.redirect('/company/dashboard');
  return res.redirect('/register');
}

function upsertWorkerLeadForSignup({ userId, email }) {
  const baseName = email.split('@')[0];
  const existing = db.prepare('SELECT id FROM worker_leads WHERE email=?').get(email);

  if (existing) {
    db.prepare(`
      UPDATE worker_leads
      SET user_id=COALESCE(user_id, ?), source='signup_worker'
      WHERE id=?
    `).run(userId, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO worker_leads(user_id, full_name, phone, email, age, city_area, transport_method, roles, years_experience, notes, source)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(userId, baseName, '', email, '', '', '', '', '', '', 'signup_worker');
}

function upsertCompanyLeadForSignup({ userId, email }) {
  const baseName = email.split('@')[0];
  const existing = db.prepare('SELECT id FROM company_leads WHERE email=?').get(email);

  if (existing) {
    db.prepare(`
      UPDATE company_leads
      SET user_id=COALESCE(user_id, ?), source='signup_company'
      WHERE id=?
    `).run(userId, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO company_leads(user_id, business_name, contact_name, phone, email, city_area, business_type, roles_needed, urgency_frequency, notes, source)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(userId, '', baseName, '', email, '', '', '', '', '', 'signup_company');
}

app.get('/', (req, res) => res.render('home'));

// compatibilità con vecchi link pubblici
app.get('/worker-apply', (req, res) => res.redirect('/register/worker'));
app.get('/company-apply', (req, res) => res.redirect('/register/company'));

// auth pubblica
app.get('/register', requireGuest, (req, res) => res.render('auth/register-choice'));
app.get('/signup', (req, res) => res.redirect('/register'));

app.get('/register/worker', requireGuest, (req, res) => res.render('auth/signup-worker'));
app.get('/register/company', requireGuest, (req, res) => res.render('auth/signup-company'));

app.post('/register/worker', requireGuest, async (req, res) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8)
    });

    const { email, password } = schema.parse(req.body);
    const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);

    if (exists) {
      setFlash(req, 'error', 'Email già registrata');
      return res.redirect('/register/worker');
    }

    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users(email, password_hash, role) VALUES(?,?,?)')
      .run(email, hash, 'worker');

    upsertWorkerLeadForSignup({ userId: result.lastInsertRowid, email });

    req.session.user = {
      id: result.lastInsertRowid,
      email,
      role: 'worker'
    };

    res.redirect('/onboarding/worker');
  } catch (e) {
    setFlash(req, 'error', 'Registrazione worker non riuscita');
    res.redirect('/register/worker');
  }
});

app.post('/register/company', requireGuest, async (req, res) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8)
    });

    const { email, password } = schema.parse(req.body);
    const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);

    if (exists) {
      setFlash(req, 'error', 'Email già registrata');
      return res.redirect('/register/company');
    }

    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users(email, password_hash, role) VALUES(?,?,?)')
      .run(email, hash, 'company');

    upsertCompanyLeadForSignup({ userId: result.lastInsertRowid, email });

    req.session.user = {
      id: result.lastInsertRowid,
      email,
      role: 'company'
    };

    res.redirect('/onboarding/company');
  } catch (e) {
    setFlash(req, 'error', 'Registrazione azienda non riuscita');
    res.redirect('/register/company');
  }
});

app.get('/login', requireGuest, (req, res) => res.render('auth/login'));

app.post('/login', requireGuest, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email);

  if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) {
    setFlash(req, 'error', 'Credenziali non valide');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    email: user.email,
    role: user.role
  };

  redirectDashboard(res, req.session.user);
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// onboarding worker
app.get('/onboarding/worker', requireAuth, requireRole('worker'), (req, res) => res.render('worker/onboarding'));

app.post('/onboarding/worker', requireAuth, requireRole('worker'), (req, res) => {
  const u = req.session.user;
  const b = req.body;

  const rolesValue = Array.isArray(b.roles)
    ? b.roles.join(',')
    : (b.roles || b.role || 'worker');

  db.prepare(`
    INSERT OR REPLACE INTO workers(
      user_id, full_name, phone, city_area, transport_method, roles, years_experience, bio
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run(
    u.id,
    b.full_name || '',
    b.phone || '',
    b.city_area || '',
    b.transport_method || '',
    rolesValue,
    b.years_experience || '',
    b.bio || ''
  );

  db.prepare('UPDATE users SET onboarding_complete=1 WHERE id=?').run(u.id);

  db.prepare(`
    UPDATE worker_leads
    SET full_name=?, phone=?, city_area=?, transport_method=?, roles=?, years_experience=?, notes=?, source='signup_worker'
    WHERE email=?
  `).run(
    b.full_name || '',
    b.phone || '',
    b.city_area || '',
    b.transport_method || '',
    rolesValue,
    b.years_experience || '',
    b.bio || '',
    u.email
  );

  res.redirect('/worker/dashboard');
});

// onboarding company
app.get('/onboarding/company', requireAuth, requireRole('company'), (req, res) => res.render('company/onboarding'));

app.post('/onboarding/company', requireAuth, requireRole('company'), (req, res) => {
  const u = req.session.user;
  const b = req.body;

  db.prepare(`
    INSERT OR REPLACE INTO companies(
      user_id, business_name, contact_name, phone, city_area, business_type, description
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    u.id,
    b.business_name || '',
    b.contact_name || '',
    b.phone || '',
    b.city_area || '',
    b.business_type || '',
    b.description || ''
  );

  db.prepare('UPDATE users SET onboarding_complete=1 WHERE id=?').run(u.id);

  db.prepare(`
    UPDATE company_leads
    SET business_name=?, contact_name=?, phone=?, city_area=?, business_type=?, notes=?, source='signup_company'
    WHERE email=?
  `).run(
    b.business_name || '',
    b.contact_name || '',
    b.phone || '',
    b.city_area || '',
    b.business_type || '',
    b.description || '',
    u.email
  );

  res.redirect('/company/dashboard');
});

// worker area
app.get('/worker/dashboard', requireAuth, requireRole('worker'), (req, res) => {
  const worker = getWorkerByUser(req.session.user.id);
  if (!worker) return res.redirect('/onboarding/worker');

  const openShifts = db.prepare(`
    SELECT s.*, c.business_name,
      (SELECT COUNT(*) FROM applications a WHERE a.shift_id=s.id AND a.worker_id=?) as already_applied
    FROM shifts s
    JOIN companies c ON s.company_id=c.id
    WHERE s.status='open'
    ORDER BY s.shift_date, start_time
  `).all(worker.id);

  const myApplications = db.prepare(`
    SELECT a.*, s.title, s.shift_date, s.start_time, s.end_time, s.location, c.business_name, c.user_id as company_user_id
    FROM applications a
    JOIN shifts s ON a.shift_id=s.id
    JOIN companies c ON s.company_id=c.id
    WHERE a.worker_id=?
    ORDER BY a.created_at DESC
  `).all(worker.id);

  const reviews = db.prepare(`
    SELECT r.*, u.email as reviewer_email
    FROM reviews r
    JOIN users u ON r.from_user_id=u.id
    WHERE r.to_user_id=?
    ORDER BY r.created_at DESC
  `).all(req.session.user.id);

  res.render('worker/dashboard', { worker, openShifts, myApplications, reviews });
});

app.post('/worker/apply/:shiftId', requireAuth, requireRole('worker'), (req, res) => {
  const worker = getWorkerByUser(req.session.user.id);

  try {
    db.prepare('INSERT INTO applications(shift_id, worker_id) VALUES(?,?)').run(req.params.shiftId, worker.id);
    setFlash(req, 'success', 'Candidatura inviata');
  } catch {
    setFlash(req, 'error', 'Hai già candidarti a questo turno');
  }

  res.redirect('/worker/dashboard');
});

// company area
app.get('/company/dashboard', requireAuth, requireRole('company'), (req, res) => {
  const company = getCompanyByUser(req.session.user.id);
  if (!company) return res.redirect('/onboarding/company');

  const shifts = db.prepare(`
    SELECT * FROM shifts
    WHERE company_id=?
    ORDER BY shift_date, start_time
  `).all(company.id);

  const applications = db.prepare(`
    SELECT a.*, w.full_name, w.roles, w.user_id as worker_user_id, s.title, s.shift_date
    FROM applications a
    JOIN workers w ON a.worker_id=w.id
    JOIN shifts s ON a.shift_id=s.id
    WHERE s.company_id=?
    ORDER BY a.created_at DESC
  `).all(company.id);

  const reviews = db.prepare(`
    SELECT r.*, u.email as reviewer_email
    FROM reviews r
    JOIN users u ON r.from_user_id=u.id
    WHERE r.to_user_id=?
    ORDER BY r.created_at DESC
  `).all(req.session.user.id);

  res.render('company/dashboard', { company, shifts, applications, reviews });
});

app.get('/company/shifts/new', requireAuth, requireRole('company'), (req, res) => res.render('company/new-shift'));

app.post('/company/shifts/new', requireAuth, requireRole('company'), (req, res) => {
  const company = getCompanyByUser(req.session.user.id);
  const b = req.body;

  db.prepare(`
    INSERT INTO shifts(company_id, title, role_needed, location, shift_date, start_time, end_time, pay_eur, notes)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    company.id,
    b.title,
    b.role_needed,
    b.location,
    b.shift_date,
    b.start_time,
    b.end_time,
    b.pay_eur,
    b.notes || ''
  );

  res.redirect('/company/dashboard');
});

app.post('/company/applications/:id/status', requireAuth, requireRole('company'), (req, res) => {
  const appRow = db.prepare(`
    SELECT a.*, s.company_id, s.id shift_id
    FROM applications a
    JOIN shifts s ON a.shift_id=s.id
    WHERE a.id=?
  `).get(req.params.id);

  const company = getCompanyByUser(req.session.user.id);
  if (!appRow || appRow.company_id !== company.id) return res.redirect('/company/dashboard');

  const status = req.body.status;
  db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, appRow.id);

  if (status === 'accepted') {
    db.prepare("UPDATE applications SET status='rejected' WHERE shift_id=? AND id<>?").run(appRow.shift_id, appRow.id);
    db.prepare("UPDATE shifts SET status='assigned' WHERE id=?").run(appRow.shift_id);
  }

  res.redirect('/company/dashboard');
});

app.post('/company/shifts/:id/complete', requireAuth, requireRole('company'), (req, res) => {
  const company = getCompanyByUser(req.session.user.id);
  const shift = db.prepare('SELECT * FROM shifts WHERE id=? AND company_id=?').get(req.params.id, company.id);

  if (shift) {
    db.prepare("UPDATE shifts SET status='completed' WHERE id=?").run(shift.id);
    db.prepare("UPDATE applications SET status='completed' WHERE shift_id=? AND status='accepted'").run(shift.id);
  }

  res.redirect('/company/dashboard');
});

// reviews
app.post('/reviews', requireAuth, (req, res) => {
  const b = req.body;

  try {
    db.prepare(`
      INSERT INTO reviews(shift_id, application_id, from_user_id, to_user_id, from_role, to_role, stars, comment)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      b.shift_id,
      b.application_id || null,
      req.session.user.id,
      b.to_user_id,
      req.session.user.role,
      b.to_role,
      b.stars,
      b.comment || ''
    );

    updateRating(b.to_user_id, b.to_role);
    setFlash(req, 'success', 'Recensione inviata');
  } catch {
    setFlash(req, 'error', 'Recensione già inviata o non valida');
  }

  res.redirect(req.session.user.role === 'worker' ? '/worker/dashboard' : '/company/dashboard');
});

// profiles
app.get('/profile/worker/:userId', requireAuth, (req, res) => {
  const worker = db.prepare('SELECT * FROM workers WHERE user_id=?').get(req.params.userId);
  const reviews = db.prepare(`
    SELECT r.*, u.email reviewer_email
    FROM reviews r
    JOIN users u ON u.id=r.from_user_id
    WHERE r.to_user_id=?
  `).all(req.params.userId);

  res.render('worker/profile', { worker, reviews });
});

app.get('/profile/company/:userId', requireAuth, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE user_id=?').get(req.params.userId);
  const reviews = db.prepare(`
    SELECT r.*, u.email reviewer_email
    FROM reviews r
    JOIN users u ON u.id=r.from_user_id
    WHERE r.to_user_id=?
  `).all(req.params.userId);

  res.render('company/profile', { company, reviews });
});

// admin
app.get('/admin/leads', requireAdmin, (req, res) => {
  const workerLeads = db.prepare('SELECT * FROM worker_leads ORDER BY created_at DESC').all();
  const companyLeads = db.prepare('SELECT * FROM company_leads ORDER BY created_at DESC').all();
  res.render('admin/leads', { workerLeads, companyLeads });
});

app.post('/admin/leads/:kind/:id/status', requireAdmin, (req, res) => {
  const table = req.params.kind === 'worker' ? 'worker_leads' : 'company_leads';
  db.prepare(`UPDATE ${table} SET status=?, admin_notes=? WHERE id=?`)
    .run(req.body.status, req.body.admin_notes || '', req.params.id);

  res.redirect('/admin/leads');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ready running on http://0.0.0.0:${PORT}`);
});