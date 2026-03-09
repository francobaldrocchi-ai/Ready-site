import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(process.cwd(), 'db', 'ready.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK(role IN ('admin','worker','company')) NULL,
  onboarding_complete INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS worker_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  full_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT UNIQUE,
  age TEXT DEFAULT '',
  city_area TEXT DEFAULT '',
  transport_method TEXT DEFAULT '',
  roles TEXT DEFAULT '',
  years_experience TEXT DEFAULT '',
  availability_lunch INTEGER DEFAULT 0,
  availability_dinner INTEGER DEFAULT 0,
  availability_weekends INTEGER DEFAULT 0,
  availability_last_minute INTEGER DEFAULT 0,
  currently_employed INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'new_lead',
  admin_notes TEXT DEFAULT '',
  source TEXT DEFAULT 'signup_worker',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS company_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  business_name TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT UNIQUE,
  city_area TEXT DEFAULT '',
  business_type TEXT DEFAULT '',
  roles_needed TEXT DEFAULT '',
  urgency_frequency TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'new_lead',
  admin_notes TEXT DEFAULT '',
  source TEXT DEFAULT 'signup_company',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city_area TEXT NOT NULL,
  transport_method TEXT,
  roles TEXT NOT NULL,
  years_experience TEXT,
  bio TEXT,
  avg_rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city_area TEXT NOT NULL,
  business_type TEXT NOT NULL,
  description TEXT,
  avg_rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
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
  notes TEXT,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','assigned','completed','cancelled')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  worker_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','completed')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shift_id, worker_id),
  FOREIGN KEY(shift_id) REFERENCES shifts(id),
  FOREIGN KEY(worker_id) REFERENCES workers(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  application_id INTEGER,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shift_id, from_user_id, to_user_id),
  FOREIGN KEY(shift_id) REFERENCES shifts(id),
  FOREIGN KEY(application_id) REFERENCES applications(id),
  FOREIGN KEY(from_user_id) REFERENCES users(id),
  FOREIGN KEY(to_user_id) REFERENCES users(id)
);
`);

// lightweight migrations for older DBs
const migrationStatements = [
  "ALTER TABLE worker_leads ADD COLUMN user_id INTEGER",
  "ALTER TABLE worker_leads ADD COLUMN source TEXT DEFAULT 'signup_worker'",
  "ALTER TABLE company_leads ADD COLUMN user_id INTEGER",
  "ALTER TABLE company_leads ADD COLUMN source TEXT DEFAULT 'signup_company'"
];

for (const stmt of migrationStatements) {
  try {
    db.exec(stmt);
  } catch (err) {
    // Ignore errors when the column already exists
  }
}

export default db;