import 'dotenv/config';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'ready.sqlite');
const LEGACY_DB_PATH = path.join(process.cwd(), 'db', 'ready.sqlite');

export const dbPath = resolveDatabasePath();
ensureDirectory(path.dirname(dbPath));

const db = new Database(dbPath);
configureDatabase(db);
createSchema(db);
runMigrations(db);
backfillCanonicalData(db);
syncLegacyMirrorTables(db);
seedDefaultAdmin(db);

export function upsertAdminUser({ email, password }) {
  const normalizedEmail = normalizeEmail(email || process.env.ADMIN_EMAIL || 'admin@example.com');
  const rawPassword = String(password || process.env.ADMIN_PASSWORD || 'ChangeMeNow123!').trim();
  const passwordHash = bcrypt.hashSync(rawPassword, 10);

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);

  if (existing) {
    db.prepare(`
      UPDATE users
      SET password_hash = ?, role = 'admin', status = 'active', onboarding_complete = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(passwordHash, existing.id);
  } else {
    db.prepare(`
      INSERT INTO users(email, password_hash, role, status, onboarding_complete)
      VALUES (?, ?, 'admin', 'active', 1)
    `).run(normalizedEmail, passwordHash);
  }

  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
}

export default db;

function resolveDatabasePath() {
  const configuredPath = (process.env.DB_PATH || process.env.SQLITE_PATH || '').trim();

  if (configuredPath) {
    return path.resolve(process.cwd(), configuredPath);
  }

  if (!fs.existsSync(DEFAULT_DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    ensureDirectory(path.dirname(DEFAULT_DB_PATH));
    fs.copyFileSync(LEGACY_DB_PATH, DEFAULT_DB_PATH);
  }

  return DEFAULT_DB_PATH;
}

function ensureDirectory(targetDirectory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function configureDatabase(database) {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('temp_store = MEMORY');
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'worker', 'company')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'blocked')),
      onboarding_complete INTEGER NOT NULL DEFAULT 0 CHECK(onboarding_complete IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS worker_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '',
      transport_method TEXT NOT NULL DEFAULT '',
      roles TEXT NOT NULL DEFAULT '',
      years_experience TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK(onboarding_completed IN (0, 1)),
      avg_rating REAL NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS company_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      company_name TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      business_type TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK(onboarding_completed IN (0, 1)),
      avg_rating REAL NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('worker', 'company')),
      source TEXT NOT NULL DEFAULT 'signup',
      status TEXT NOT NULL DEFAULT 'new_lead',
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      admin_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type, email),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      city_area TEXT NOT NULL DEFAULT '',
      transport_method TEXT NOT NULL DEFAULT '',
      roles TEXT NOT NULL DEFAULT '',
      years_experience TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      avg_rating REAL NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      business_name TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      city_area TEXT NOT NULL DEFAULT '',
      business_type TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      avg_rating REAL NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worker_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      full_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE,
      age TEXT NOT NULL DEFAULT '',
      city_area TEXT NOT NULL DEFAULT '',
      transport_method TEXT NOT NULL DEFAULT '',
      roles TEXT NOT NULL DEFAULT '',
      years_experience TEXT NOT NULL DEFAULT '',
      availability_lunch INTEGER NOT NULL DEFAULT 0,
      availability_dinner INTEGER NOT NULL DEFAULT 0,
      availability_weekends INTEGER NOT NULL DEFAULT 0,
      availability_last_minute INTEGER NOT NULL DEFAULT 0,
      currently_employed INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new_lead',
      admin_notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'signup_worker',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS company_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      business_name TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE,
      city_area TEXT NOT NULL DEFAULT '',
      business_type TEXT NOT NULL DEFAULT '',
      roles_needed TEXT NOT NULL DEFAULT '',
      urgency_frequency TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new_lead',
      admin_notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'signup_company',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      role_needed TEXT NOT NULL,
      location TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      pay_eur REAL NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'assigned', 'completed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL,
      worker_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'completed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shift_id, worker_id),
      FOREIGN KEY(shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
      FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL,
      application_id INTEGER,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      from_role TEXT NOT NULL CHECK(from_role IN ('worker', 'company')),
      to_role TEXT NOT NULL CHECK(to_role IN ('worker', 'company')),
      stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shift_id, from_user_id, to_user_id),
      FOREIGN KEY(shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
      FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE SET NULL,
      FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_worker_profiles_user_id ON worker_profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_company_profiles_user_id ON company_profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_leads_type_created_at ON leads(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_shifts_company_id ON shifts(company_id);
    CREATE INDEX IF NOT EXISTS idx_applications_shift_id ON applications(shift_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_to_user_id ON reviews(to_user_id);
  `);

  createUpdatedAtTrigger(database, 'users', 'id');
  createUpdatedAtTrigger(database, 'worker_profiles', 'id');
  createUpdatedAtTrigger(database, 'company_profiles', 'id');
  createUpdatedAtTrigger(database, 'leads', 'id');
  createUpdatedAtTrigger(database, 'sessions', 'sid');
}

function createUpdatedAtTrigger(database, tableName, primaryKeyColumn) {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS ${tableName}_set_updated_at
    AFTER UPDATE ON ${tableName}
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE ${tableName}
      SET updated_at = CURRENT_TIMESTAMP
      WHERE ${primaryKeyColumn} = OLD.${primaryKeyColumn};
    END;
  `);
}

function runMigrations(database) {
  if (tableExists(database, 'users')) {
    ensureColumn(database, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
    ensureColumn(database, 'users', 'onboarding_complete', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'users', 'updated_at', 'TEXT');

    database.exec(`
      UPDATE users
      SET status = COALESCE(NULLIF(status, ''), 'active'),
          updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP),
          onboarding_complete = COALESCE(onboarding_complete, 0)
    `);
  }

  if (tableExists(database, 'worker_leads')) {
    ensureColumn(database, 'worker_leads', 'user_id', 'INTEGER');
    ensureColumn(database, 'worker_leads', 'source', "TEXT NOT NULL DEFAULT 'signup_worker'");
    ensureColumn(database, 'worker_leads', 'admin_notes', "TEXT NOT NULL DEFAULT ''");
  }

  if (tableExists(database, 'company_leads')) {
    ensureColumn(database, 'company_leads', 'user_id', 'INTEGER');
    ensureColumn(database, 'company_leads', 'source', "TEXT NOT NULL DEFAULT 'signup_company'");
    ensureColumn(database, 'company_leads', 'admin_notes', "TEXT NOT NULL DEFAULT ''");
  }

  database.exec(`
    UPDATE users
    SET role = 'worker'
    WHERE role IS NULL AND EXISTS (SELECT 1 FROM workers w WHERE w.user_id = users.id);

    UPDATE users
    SET role = 'company'
    WHERE role IS NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.user_id = users.id);
  `);
}

function backfillCanonicalData(database) {
  if (tableExists(database, 'workers')) {
    database.exec(`
      INSERT INTO worker_profiles (
        id,
        user_id,
        first_name,
        last_name,
        phone,
        city,
        availability,
        transport_method,
        roles,
        years_experience,
        bio,
        onboarding_completed,
        avg_rating,
        review_count,
        created_at,
        updated_at
      )
      SELECT
        w.id,
        w.user_id,
        CASE
          WHEN instr(trim(w.full_name), ' ') > 0 THEN substr(trim(w.full_name), 1, instr(trim(w.full_name), ' ') - 1)
          ELSE trim(w.full_name)
        END,
        CASE
          WHEN instr(trim(w.full_name), ' ') > 0 THEN substr(trim(w.full_name), instr(trim(w.full_name), ' ') + 1)
          ELSE ''
        END,
        COALESCE(w.phone, ''),
        COALESCE(w.city_area, ''),
        '',
        COALESCE(w.transport_method, ''),
        COALESCE(w.roles, ''),
        COALESCE(w.years_experience, ''),
        COALESCE(w.bio, ''),
        COALESCE((SELECT onboarding_complete FROM users WHERE id = w.user_id), 0),
        COALESCE(w.avg_rating, 0),
        COALESCE(w.review_count, 0),
        COALESCE(w.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM workers w
      WHERE NOT EXISTS (
        SELECT 1 FROM worker_profiles wp WHERE wp.user_id = w.user_id
      );
    `);
  }

  if (tableExists(database, 'companies')) {
    database.exec(`
      INSERT INTO company_profiles (
        id,
        user_id,
        company_name,
        contact_name,
        phone,
        city,
        business_type,
        description,
        onboarding_completed,
        avg_rating,
        review_count,
        created_at,
        updated_at
      )
      SELECT
        c.id,
        c.user_id,
        COALESCE(c.business_name, ''),
        COALESCE(c.contact_name, ''),
        COALESCE(c.phone, ''),
        COALESCE(c.city_area, ''),
        COALESCE(c.business_type, ''),
        COALESCE(c.description, ''),
        COALESCE((SELECT onboarding_complete FROM users WHERE id = c.user_id), 0),
        COALESCE(c.avg_rating, 0),
        COALESCE(c.review_count, 0),
        COALESCE(c.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM company_profiles cp WHERE cp.user_id = c.user_id
      );
    `);
  }

  database.exec(`
    INSERT INTO worker_profiles (user_id, onboarding_completed)
    SELECT u.id, COALESCE(u.onboarding_complete, 0)
    FROM users u
    WHERE u.role = 'worker'
      AND NOT EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.user_id = u.id);

    INSERT INTO company_profiles (user_id, onboarding_completed)
    SELECT u.id, COALESCE(u.onboarding_complete, 0)
    FROM users u
    WHERE u.role = 'company'
      AND NOT EXISTS (SELECT 1 FROM company_profiles cp WHERE cp.user_id = u.id);
  `);

  if (tableExists(database, 'worker_leads')) {
    database.exec(`
      INSERT INTO leads (user_id, type, source, status, email, phone, notes, admin_notes, created_at, updated_at)
      SELECT
        wl.user_id,
        'worker',
        COALESCE(NULLIF(wl.source, ''), 'signup_worker'),
        COALESCE(NULLIF(wl.status, ''), 'new_lead'),
        lower(wl.email),
        COALESCE(wl.phone, ''),
        COALESCE(wl.notes, ''),
        COALESCE(wl.admin_notes, ''),
        COALESCE(wl.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM worker_leads wl
      WHERE wl.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM leads l WHERE l.type = 'worker' AND l.email = lower(wl.email)
        );
    `);
  }

  if (tableExists(database, 'company_leads')) {
    database.exec(`
      INSERT INTO leads (user_id, type, source, status, email, phone, notes, admin_notes, created_at, updated_at)
      SELECT
        cl.user_id,
        'company',
        COALESCE(NULLIF(cl.source, ''), 'signup_company'),
        COALESCE(NULLIF(cl.status, ''), 'new_lead'),
        lower(cl.email),
        COALESCE(cl.phone, ''),
        COALESCE(cl.notes, ''),
        COALESCE(cl.admin_notes, ''),
        COALESCE(cl.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM company_leads cl
      WHERE cl.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM leads l WHERE l.type = 'company' AND l.email = lower(cl.email)
        );
    `);
  }

  database.exec(`
    INSERT INTO leads (user_id, type, source, status, email, phone, notes)
    SELECT
      u.id,
      u.role,
      CASE WHEN u.role = 'worker' THEN 'signup_worker' ELSE 'signup_company' END,
      CASE WHEN COALESCE(u.onboarding_complete, 0) = 1 THEN 'pending_review' ELSE 'new_lead' END,
      lower(u.email),
      '',
      ''
    FROM users u
    WHERE u.role IN ('worker', 'company')
      AND NOT EXISTS (
        SELECT 1 FROM leads l WHERE l.user_id = u.id AND l.type = u.role
      );
  `);
}

function syncLegacyMirrorTables(database) {
  database.exec(`
    INSERT INTO workers (
      id,
      user_id,
      full_name,
      phone,
      city_area,
      transport_method,
      roles,
      years_experience,
      bio,
      avg_rating,
      review_count,
      created_at
    )
    SELECT
      wp.id,
      wp.user_id,
      trim(wp.first_name || ' ' || wp.last_name),
      wp.phone,
      wp.city,
      wp.transport_method,
      wp.roles,
      wp.years_experience,
      wp.bio,
      wp.avg_rating,
      wp.review_count,
      wp.created_at
    FROM worker_profiles wp
    WHERE NOT EXISTS (SELECT 1 FROM workers w WHERE w.user_id = wp.user_id);

    INSERT INTO companies (
      id,
      user_id,
      business_name,
      contact_name,
      phone,
      city_area,
      business_type,
      description,
      avg_rating,
      review_count,
      created_at
    )
    SELECT
      cp.id,
      cp.user_id,
      cp.company_name,
      cp.contact_name,
      cp.phone,
      cp.city,
      cp.business_type,
      cp.description,
      cp.avg_rating,
      cp.review_count,
      cp.created_at
    FROM company_profiles cp
    WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.user_id = cp.user_id);
  `);
}

function seedDefaultAdmin(database) {
  const existingAdmin = database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();

  if (existingAdmin) {
    return;
  }

  upsertAdminUser({
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'ChangeMeNow123!'
  });
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const alreadyPresent = columns.some((column) => column.name === columnName);

  if (!alreadyPresent) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function tableExists(database, tableName) {
  return Boolean(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  );
}
