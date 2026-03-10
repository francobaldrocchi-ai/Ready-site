import 'dotenv/config';
import bcrypt from 'bcryptjs';
import express from 'express';
import session from 'express-session';
import path from 'path';
import { z } from 'zod';
import db, { dbPath } from './db/index.js';
import {
  getCompanyProfileByPublicUserId,
  getCompanyProfileByUserId,
  getLeadById,
  getUserByEmail,
  getUserById,
  getWorkerProfileByPublicUserId,
  getWorkerProfileByUserId,
  listAdminLeads,
  listAdminUsers,
  registerCompanyAccount,
  registerWorkerAccount,
  saveCompanyOnboarding,
  saveWorkerOnboarding,
  updateLeadStatus,
  updateUserRating
} from './db/repositories.js';
import SqliteSessionStore from './lib/sqlite-session-store.js';

const app = express();
const __dirname = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionName = process.env.SESSION_NAME || 'ready.sid';
const sessionSecret = process.env.SESSION_SECRET || 'ready-local-session-secret';

const roleOptions = ['waiter', 'runner', 'bar', 'kitchen_helper', 'dishwasher'];
const leadStatusOptions = ['new_lead', 'pending_review', 'qualified', 'ready', 'inactive', 'rejected'];

const registerSchema = z.object({
  email: z.string().trim().email('Inserisci un indirizzo email valido'),
  password: z.string().min(8, 'La password deve avere almeno 8 caratteri').max(72, 'La password e troppo lunga')
});

const workerOnboardingSchema = z.object({
  full_name: z.string().trim().min(2, 'Inserisci nome e cognome').max(120, 'Nome troppo lungo'),
  phone: z.string().trim().min(6, 'Inserisci un numero di telefono valido').max(40, 'Telefono troppo lungo'),
  city_area: z.string().trim().min(2, 'Inserisci la tua zona').max(100, 'Zona troppo lunga'),
  availability: z.string().trim().max(120, 'Disponibilita troppo lunga').optional().default(''),
  transport_method: z.string().trim().max(80, 'Mezzo di trasporto troppo lungo').optional().default(''),
  roles: z.union([z.array(z.string()), z.string()]).optional().transform((value) => {
    if (!value) {
      return [];
    }

    return Array.isArray(value) ? value : [value];
  }),
  years_experience: z.string().trim().max(50, 'Esperienza troppo lunga').optional().default(''),
  bio: z.string().trim().max(1000, 'Bio troppo lunga').optional().default('')
});

const companyOnboardingSchema = z.object({
  business_name: z.string().trim().min(2, 'Inserisci il nome dell attivita').max(140, 'Nome attivita troppo lungo'),
  contact_name: z.string().trim().min(2, 'Inserisci il referente').max(120, 'Referente troppo lungo'),
  phone: z.string().trim().min(6, 'Inserisci un numero di telefono valido').max(40, 'Telefono troppo lungo'),
  city_area: z.string().trim().min(2, 'Inserisci la zona').max(100, 'Zona troppo lunga'),
  business_type: z.string().trim().min(2, 'Inserisci il tipo di attivita').max(80, 'Tipo attivita troppo lungo'),
  description: z.string().trim().max(1200, 'Descrizione troppo lunga').optional().default('')
});

const loginSchema = z.object({
  email: z.string().trim().email('Inserisci un indirizzo email valido'),
  password: z.string().min(1, 'Inserisci la password')
});

const shiftSchema = z.object({
  title: z.string().trim().min(2, 'Inserisci il titolo del turno').max(120, 'Titolo troppo lungo'),
  role_needed: z.string().trim().min(2, 'Inserisci il ruolo richiesto').max(80, 'Ruolo troppo lungo'),
  location: z.string().trim().min(2, 'Inserisci la location').max(160, 'Location troppo lunga'),
  shift_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data turno non valida'),
  start_time: z.string().trim().regex(/^\d{2}:\d{2}$/, 'Ora di inizio non valida'),
  end_time: z.string().trim().regex(/^\d{2}:\d{2}$/, 'Ora di fine non valida'),
  pay_eur: z.coerce.number().positive('Inserisci una paga valida').max(10000, 'Paga troppo alta'),
  notes: z.string().trim().max(1500, 'Note troppo lunghe').optional().default('')
});

const reviewSchema = z.object({
  shift_id: z.coerce.number().int().positive(),
  application_id: z.coerce.number().int().positive(),
  to_user_id: z.coerce.number().int().positive(),
  to_role: z.enum(['worker', 'company']),
  stars: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000, 'Commento troppo lungo').optional().default('')
});

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: sessionName,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,
  store: new SqliteSessionStore({ db }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use((req, res, next) => {
  const sessionUserId = req.session?.userId;
  req.currentUser = null;

  if (sessionUserId) {
    const currentUser = getUserById(sessionUserId);

    if (currentUser && currentUser.status === 'active') {
      req.currentUser = currentUser;
    } else {
      delete req.session.userId;
    }
  }

  res.locals.currentUser = req.currentUser;
  res.locals.flash = req.session?.flash || null;
  delete req.session.flash;
  next();
});

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const setFlash = (req, type, message) => {
  req.session.flash = { type, message };
};

function getValidationMessage(error, fallbackMessage) {
  if (error?.issues?.length) {
    return error.issues[0].message;
  }

  if (error?.code === 'EMAIL_EXISTS') {
    return 'Questa email e gia registrata';
  }

  return fallbackMessage;
}

function resolveUserHome(user) {
  if (!user) {
    return '/login';
  }

  if (user.role === 'admin') {
    return '/admin/leads';
  }

  if (user.role === 'worker') {
    const profile = getWorkerProfileByUserId(user.id);
    return profile?.onboarding_completed ? '/worker/dashboard' : '/onboarding/worker';
  }

  if (user.role === 'company') {
    const profile = getCompanyProfileByUserId(user.id);
    return profile?.onboarding_completed ? '/company/dashboard' : '/onboarding/company';
  }

  return '/register';
}

function redirectDashboard(req, res, user = req.currentUser) {
  return res.redirect(resolveUserHome(user));
}

async function establishSession(req, user) {
  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      req.session.userId = user.id;
      req.session.save((saveError) => {
        if (saveError) {
          reject(saveError);
          return;
        }

        resolve();
      });
    });
  });
}

const requireAuth = (req, res, next) => {
  if (!req.currentUser) {
    return res.redirect('/login');
  }

  return next();
};

const requireGuest = (req, res, next) => {
  if (req.currentUser) {
    return redirectDashboard(req, res, req.currentUser);
  }

  return next();
};

const requireRole = (role) => (req, res, next) => {
  if (!req.currentUser) {
    return res.redirect('/login');
  }

  if (req.currentUser.role !== role) {
    return redirectDashboard(req, res, req.currentUser);
  }

  return next();
};

const requireAdmin = requireRole('admin');
const requireWorker = requireRole('worker');
const requireCompany = requireRole('company');

const requireCompletedOnboarding = (role) => (req, res, next) => {
  if (!req.currentUser) {
    return res.redirect('/login');
  }

  const profile = role === 'worker'
    ? getWorkerProfileByUserId(req.currentUser.id)
    : getCompanyProfileByUserId(req.currentUser.id);

  if (!profile || !profile.onboarding_completed) {
    return res.redirect(`/onboarding/${role}`);
  }

  req.profile = profile;
  return next();
};

app.get('/', (req, res) => res.render('home'));
app.get('/worker-apply', (req, res) => res.redirect('/register/worker'));
app.get('/company-apply', (req, res) => res.redirect('/register/company'));

app.get('/register', requireGuest, (req, res) => res.render('auth/register-choice'));
app.get('/signup', (req, res) => res.redirect('/register'));
app.get('/register/worker', requireGuest, (req, res) => res.render('auth/signup-worker'));
app.get('/register/company', requireGuest, (req, res) => res.render('auth/signup-company'));

app.post('/register/worker', requireGuest, asyncHandler(async (req, res) => {
  try {
    const parsed = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(parsed.password, 10);
    const user = registerWorkerAccount({ email: parsed.email, passwordHash });
    await establishSession(req, user);
    res.redirect('/onboarding/worker');
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Registrazione worker non riuscita'));
    res.redirect('/register/worker');
  }
}));

app.post('/register/company', requireGuest, asyncHandler(async (req, res) => {
  try {
    const parsed = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(parsed.password, 10);
    const user = registerCompanyAccount({ email: parsed.email, passwordHash });
    await establishSession(req, user);
    res.redirect('/onboarding/company');
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Registrazione azienda non riuscita'));
    res.redirect('/register/company');
  }
}));

app.get('/login', requireGuest, (req, res) => res.render('auth/login'));

app.post('/login', requireGuest, asyncHandler(async (req, res) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const user = getUserByEmail(parsed.email);

    if (!user || user.status !== 'active') {
      setFlash(req, 'error', 'Credenziali non valide');
      res.redirect('/login');
      return;
    }

    const passwordMatches = await bcrypt.compare(parsed.password, user.password_hash);

    if (!passwordMatches) {
      setFlash(req, 'error', 'Credenziali non valide');
      res.redirect('/login');
      return;
    }

    await establishSession(req, user);
    res.redirect(resolveUserHome(user));
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Login non riuscito'));
    res.redirect('/login');
  }
}));

app.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) {
      next(error);
      return;
    }

    res.clearCookie(sessionName);
    res.redirect('/');
  });
});

app.get('/onboarding/worker', requireWorker, (req, res) => {
  const profile = getWorkerProfileByUserId(req.currentUser.id);

  if (profile?.onboarding_completed) {
    redirectDashboard(req, res, req.currentUser);
    return;
  }

  const selectedRoles = profile?.roles ? profile.roles.split(',').map((role) => role.trim()).filter(Boolean) : [];
  res.render('worker/onboarding', { profile: profile || {}, selectedRoles, roleOptions });
});

app.post('/onboarding/worker', requireWorker, asyncHandler(async (req, res) => {
  try {
    const parsed = workerOnboardingSchema.parse(req.body);
    const roles = parsed.roles.filter((role) => roleOptions.includes(role));

    if (!roles.length) {
      setFlash(req, 'error', 'Seleziona almeno un ruolo');
      res.redirect('/onboarding/worker');
      return;
    }

    saveWorkerOnboarding({
      userId: req.currentUser.id,
      profile: {
        fullName: parsed.full_name,
        phone: parsed.phone,
        city: parsed.city_area,
        availability: parsed.availability,
        transportMethod: parsed.transport_method,
        roles: roles.join(','),
        yearsExperience: parsed.years_experience,
        bio: parsed.bio
      }
    });

    setFlash(req, 'success', 'Profilo worker completato');
    res.redirect('/worker/dashboard');
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Onboarding worker non riuscito'));
    res.redirect('/onboarding/worker');
  }
}));

app.get('/onboarding/company', requireCompany, (req, res) => {
  const profile = getCompanyProfileByUserId(req.currentUser.id);

  if (profile?.onboarding_completed) {
    redirectDashboard(req, res, req.currentUser);
    return;
  }

  res.render('company/onboarding', { profile: profile || {} });
});

app.post('/onboarding/company', requireCompany, asyncHandler(async (req, res) => {
  try {
    const parsed = companyOnboardingSchema.parse(req.body);

    saveCompanyOnboarding({
      userId: req.currentUser.id,
      profile: {
        companyName: parsed.business_name,
        contactName: parsed.contact_name,
        phone: parsed.phone,
        city: parsed.city_area,
        businessType: parsed.business_type,
        description: parsed.description
      }
    });

    setFlash(req, 'success', 'Profilo azienda completato');
    res.redirect('/company/dashboard');
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Onboarding azienda non riuscito'));
    res.redirect('/onboarding/company');
  }
}));

app.get('/worker/dashboard', requireWorker, requireCompletedOnboarding('worker'), (req, res) => {
  const worker = req.profile;

  const openShifts = db.prepare(`
    SELECT
      s.*,
      cp.company_name AS business_name,
      (
        SELECT COUNT(*)
        FROM applications a
        WHERE a.shift_id = s.id AND a.worker_id = ?
      ) AS already_applied
    FROM shifts s
    JOIN company_profiles cp ON cp.id = s.company_id
    WHERE s.status = 'open'
    ORDER BY s.shift_date, s.start_time
  `).all(worker.id);

  const myApplications = db.prepare(`
    SELECT
      a.*,
      s.title,
      s.shift_date,
      s.start_time,
      s.end_time,
      s.location,
      cp.company_name AS business_name,
      cp.user_id AS company_user_id
    FROM applications a
    JOIN shifts s ON s.id = a.shift_id
    JOIN company_profiles cp ON cp.id = s.company_id
    WHERE a.worker_id = ?
    ORDER BY a.created_at DESC
  `).all(worker.id);

  const reviews = db.prepare(`
    SELECT r.*, u.email AS reviewer_email
    FROM reviews r
    JOIN users u ON u.id = r.from_user_id
    WHERE r.to_user_id = ?
    ORDER BY r.created_at DESC
  `).all(req.currentUser.id);

  res.render('worker/dashboard', { worker, openShifts, myApplications, reviews });
});

app.post('/worker/apply/:shiftId', requireWorker, requireCompletedOnboarding('worker'), (req, res) => {
  const shiftId = Number.parseInt(req.params.shiftId, 10);

  if (!Number.isInteger(shiftId)) {
    setFlash(req, 'error', 'Turno non valido');
    res.redirect('/worker/dashboard');
    return;
  }

  const shift = db.prepare("SELECT id, status FROM shifts WHERE id = ?").get(shiftId);

  if (!shift || shift.status !== 'open') {
    setFlash(req, 'error', 'Turno non disponibile');
    res.redirect('/worker/dashboard');
    return;
  }

  try {
    db.prepare('INSERT INTO applications(shift_id, worker_id) VALUES(?, ?)').run(shiftId, req.profile.id);
    setFlash(req, 'success', 'Candidatura inviata');
  } catch {
    setFlash(req, 'error', 'Hai gia inviato una candidatura per questo turno');
  }

  res.redirect('/worker/dashboard');
});

app.get('/company/dashboard', requireCompany, requireCompletedOnboarding('company'), (req, res) => {
  const company = req.profile;

  const shifts = db.prepare(`
    SELECT *
    FROM shifts
    WHERE company_id = ?
    ORDER BY shift_date, start_time
  `).all(company.id);

  const applications = db.prepare(`
    SELECT
      a.*,
      trim(wp.first_name || ' ' || wp.last_name) AS full_name,
      wp.roles,
      wp.user_id AS worker_user_id,
      s.id AS shift_id,
      s.title,
      s.shift_date
    FROM applications a
    JOIN worker_profiles wp ON wp.id = a.worker_id
    JOIN shifts s ON s.id = a.shift_id
    WHERE s.company_id = ?
    ORDER BY a.created_at DESC
  `).all(company.id);

  const reviews = db.prepare(`
    SELECT r.*, u.email AS reviewer_email
    FROM reviews r
    JOIN users u ON u.id = r.from_user_id
    WHERE r.to_user_id = ?
    ORDER BY r.created_at DESC
  `).all(req.currentUser.id);

  res.render('company/dashboard', { company, shifts, applications, reviews });
});

app.get('/company/shifts/new', requireCompany, requireCompletedOnboarding('company'), (req, res) => {
  res.render('company/new-shift');
});

app.post('/company/shifts/new', requireCompany, requireCompletedOnboarding('company'), asyncHandler(async (req, res) => {
  try {
    const parsed = shiftSchema.parse(req.body);

    db.prepare(`
      INSERT INTO shifts(company_id, title, role_needed, location, shift_date, start_time, end_time, pay_eur, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.profile.id,
      parsed.title,
      parsed.role_needed,
      parsed.location,
      parsed.shift_date,
      parsed.start_time,
      parsed.end_time,
      parsed.pay_eur,
      parsed.notes
    );

    setFlash(req, 'success', 'Turno creato');
    res.redirect('/company/dashboard');
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Creazione turno non riuscita'));
    res.redirect('/company/shifts/new');
  }
}));

app.post('/company/applications/:id/status', requireCompany, requireCompletedOnboarding('company'), (req, res) => {
  const applicationId = Number.parseInt(req.params.id, 10);
  const nextStatus = req.body.status;

  if (!Number.isInteger(applicationId) || !['accepted', 'rejected'].includes(nextStatus)) {
    setFlash(req, 'error', 'Operazione non valida');
    res.redirect('/company/dashboard');
    return;
  }

  const application = db.prepare(`
    SELECT a.id, a.shift_id, a.status, s.company_id
    FROM applications a
    JOIN shifts s ON s.id = a.shift_id
    WHERE a.id = ?
  `).get(applicationId);

  if (!application || application.company_id !== req.profile.id) {
    setFlash(req, 'error', 'Candidatura non trovata');
    res.redirect('/company/dashboard');
    return;
  }

  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(nextStatus, applicationId);

  if (nextStatus === 'accepted') {
    db.prepare("UPDATE applications SET status = 'rejected' WHERE shift_id = ? AND id <> ?").run(application.shift_id, applicationId);
    db.prepare("UPDATE shifts SET status = 'assigned' WHERE id = ?").run(application.shift_id);
  }

  if (nextStatus === 'rejected') {
    const acceptedRow = db.prepare("SELECT id FROM applications WHERE shift_id = ? AND status = 'accepted' LIMIT 1").get(application.shift_id);
    if (!acceptedRow) {
      db.prepare("UPDATE shifts SET status = 'open' WHERE id = ? AND status <> 'completed'").run(application.shift_id);
    }
  }

  setFlash(req, 'success', 'Stato candidatura aggiornato');
  res.redirect('/company/dashboard');
});

app.post('/company/shifts/:id/complete', requireCompany, requireCompletedOnboarding('company'), (req, res) => {
  const shiftId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(shiftId)) {
    setFlash(req, 'error', 'Turno non valido');
    res.redirect('/company/dashboard');
    return;
  }

  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND company_id = ?').get(shiftId, req.profile.id);

  if (!shift) {
    setFlash(req, 'error', 'Turno non trovato');
    res.redirect('/company/dashboard');
    return;
  }

  db.prepare("UPDATE shifts SET status = 'completed' WHERE id = ?").run(shift.id);
  db.prepare("UPDATE applications SET status = 'completed' WHERE shift_id = ? AND status = 'accepted'").run(shift.id);
  setFlash(req, 'success', 'Turno completato');
  res.redirect('/company/dashboard');
});

app.post('/reviews', requireAuth, asyncHandler(async (req, res) => {
  if (!['worker', 'company'].includes(req.currentUser.role)) {
    redirectDashboard(req, res, req.currentUser);
    return;
  }

  try {
    const parsed = reviewSchema.parse(req.body);

    if (req.currentUser.id === parsed.to_user_id) {
      setFlash(req, 'error', 'Non puoi recensire te stesso');
      res.redirect(resolveUserHome(req.currentUser));
      return;
    }

    if (req.currentUser.role === 'worker') {
      const workerProfile = getWorkerProfileByUserId(req.currentUser.id);
      const allowedReview = db.prepare(`
        SELECT a.id, cp.user_id AS company_user_id
        FROM applications a
        JOIN shifts s ON s.id = a.shift_id
        JOIN company_profiles cp ON cp.id = s.company_id
        WHERE a.id = ?
          AND a.shift_id = ?
          AND a.worker_id = ?
          AND a.status = 'completed'
      `).get(parsed.application_id, parsed.shift_id, workerProfile?.id || 0);

      if (!allowedReview || allowedReview.company_user_id !== parsed.to_user_id || parsed.to_role !== 'company') {
        setFlash(req, 'error', 'Recensione non valida');
        res.redirect('/worker/dashboard');
        return;
      }
    }

    if (req.currentUser.role === 'company') {
      const companyProfile = getCompanyProfileByUserId(req.currentUser.id);
      const allowedReview = db.prepare(`
        SELECT a.id, wp.user_id AS worker_user_id
        FROM applications a
        JOIN shifts s ON s.id = a.shift_id
        JOIN worker_profiles wp ON wp.id = a.worker_id
        WHERE a.id = ?
          AND a.shift_id = ?
          AND s.company_id = ?
          AND a.status = 'completed'
      `).get(parsed.application_id, parsed.shift_id, companyProfile?.id || 0);

      if (!allowedReview || allowedReview.worker_user_id !== parsed.to_user_id || parsed.to_role !== 'worker') {
        setFlash(req, 'error', 'Recensione non valida');
        res.redirect('/company/dashboard');
        return;
      }
    }

    db.prepare(`
      INSERT INTO reviews(shift_id, application_id, from_user_id, to_user_id, from_role, to_role, stars, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.shift_id,
      parsed.application_id,
      req.currentUser.id,
      parsed.to_user_id,
      req.currentUser.role,
      parsed.to_role,
      parsed.stars,
      parsed.comment
    );

    updateUserRating(parsed.to_user_id, parsed.to_role);
    setFlash(req, 'success', 'Recensione inviata');
  } catch (error) {
    setFlash(req, 'error', getValidationMessage(error, 'Recensione gia inviata o non valida'));
  }

  res.redirect(req.currentUser.role === 'worker' ? '/worker/dashboard' : '/company/dashboard');
}));

app.get('/profile/worker/:userId', requireAuth, (req, res) => {
  const userId = Number.parseInt(req.params.userId, 10);
  const worker = getWorkerProfileByPublicUserId(userId);

  if (!worker) {
    setFlash(req, 'error', 'Profilo worker non trovato');
    redirectDashboard(req, res, req.currentUser);
    return;
  }

  const reviews = db.prepare(`
    SELECT r.*, u.email AS reviewer_email
    FROM reviews r
    JOIN users u ON u.id = r.from_user_id
    WHERE r.to_user_id = ?
    ORDER BY r.created_at DESC
  `).all(userId);

  res.render('worker/profile', { worker, reviews });
});

app.get('/profile/company/:userId', requireAuth, (req, res) => {
  const userId = Number.parseInt(req.params.userId, 10);
  const company = getCompanyProfileByPublicUserId(userId);

  if (!company) {
    setFlash(req, 'error', 'Profilo azienda non trovato');
    redirectDashboard(req, res, req.currentUser);
    return;
  }

  const reviews = db.prepare(`
    SELECT r.*, u.email AS reviewer_email
    FROM reviews r
    JOIN users u ON u.id = r.from_user_id
    WHERE r.to_user_id = ?
    ORDER BY r.created_at DESC
  `).all(userId);

  res.render('company/profile', { company, reviews });
});

app.get('/admin/leads', requireAdmin, (req, res) => {
  const roleFilter = pickFilter(req.query.role, ['all', 'admin', 'worker', 'company']);
  const typeFilter = pickFilter(req.query.type, ['all', 'worker', 'company']);

  const users = listAdminUsers({ role: roleFilter === 'all' ? undefined : roleFilter });
  const leads = listAdminLeads({ type: typeFilter === 'all' ? undefined : typeFilter });

  res.render('admin/leads', {
    users,
    leads,
    roleFilter,
    typeFilter,
    leadStatusOptions
  });
});

app.post('/admin/leads/:kind/:id/status', requireAdmin, (req, res) => {
  const leadId = Number.parseInt(req.params.id, 10);
  const kind = req.params.kind;

  if (!Number.isInteger(leadId) || !['worker', 'company'].includes(kind)) {
    setFlash(req, 'error', 'Lead non valido');
    res.redirect('/admin/leads');
    return;
  }

  const lead = getLeadById(leadId);

  if (!lead || lead.type !== kind) {
    setFlash(req, 'error', 'Lead non trovato');
    res.redirect('/admin/leads');
    return;
  }

  const nextStatus = leadStatusOptions.includes(req.body.status) ? req.body.status : lead.status;
  updateLeadStatus({ leadId, status: nextStatus, adminNotes: req.body.admin_notes || '' });
  setFlash(req, 'success', 'Lead aggiornato');
  res.redirect('/admin/leads');
});

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    next(error);
    return;
  }

  if (req.session) {
    setFlash(req, 'error', 'Si e verificato un errore inatteso');
  }

  res.status(500).redirect(req.currentUser ? resolveUserHome(req.currentUser) : '/');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ready running on http://0.0.0.0:${PORT}`);
  console.log(`SQLite path: ${dbPath}`);
});

function pickFilter(value, allowedValues) {
  return allowedValues.includes(value) ? value : 'all';
}
