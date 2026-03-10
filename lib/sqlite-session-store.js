import session from 'express-session';

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export default class SqliteSessionStore extends session.Store {
  constructor({ db, cleanupIntervalMs = 1000 * 60 * 15 } = {}) {
    super();

    if (!db) {
      throw new Error('SqliteSessionStore requires a db instance');
    }

    this.db = db;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.lastCleanupAt = 0;

    this.getStatement = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?');
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET
        sess = excluded.sess,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `);
    this.touchStatement = db.prepare(`
      UPDATE sessions
      SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE sid = ?
    `);
    this.destroyStatement = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.clearStatement = db.prepare('DELETE FROM sessions');
    this.cleanupStatement = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    this.lengthStatement = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?');
  }

  get(sid, callback = () => {}) {
    try {
      this.cleanupExpired();
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.cleanupExpired();
      this.setStatement.run(sid, JSON.stringify(sessionData), getExpirationTime(sessionData));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      this.cleanupExpired();
      this.touchStatement.run(getExpirationTime(sessionData), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.clearStatement.run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  length(callback = () => {}) {
    try {
      this.cleanupExpired();
      const row = this.lengthStatement.get(Date.now());
      callback(null, row.count);
    } catch (error) {
      callback(error);
    }
  }

  cleanupExpired() {
    const now = Date.now();

    if (now - this.lastCleanupAt < this.cleanupIntervalMs) {
      return;
    }

    this.cleanupStatement.run(now);
    this.lastCleanupAt = now;
  }
}

function getExpirationTime(sessionData) {
  const cookie = sessionData?.cookie || {};

  if (cookie.expires) {
    const explicitExpiry = new Date(cookie.expires).getTime();
    if (Number.isFinite(explicitExpiry)) {
      return explicitExpiry;
    }
  }

  if (typeof cookie.maxAge === 'number' && Number.isFinite(cookie.maxAge)) {
    return Date.now() + cookie.maxAge;
  }

  return Date.now() + DEFAULT_TTL_MS;
}
