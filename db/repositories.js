import db from './index.js';

const workerProfileViewSelect = `
  SELECT
    id,
    user_id,
    first_name,
    last_name,
    trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS full_name,
    phone,
    city,
    city AS city_area,
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
  FROM worker_profiles
`;

const companyProfileViewSelect = `
  SELECT
    id,
    user_id,
    company_name,
    company_name AS business_name,
    contact_name,
    phone,
    city,
    city AS city_area,
    business_type,
    description,
    onboarding_completed,
    avg_rating,
    review_count,
    created_at,
    updated_at
  FROM company_profiles
`;

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
}

export function getUserById(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export function getLeadById(leadId) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

export function getWorkerProfileByUserId(userId) {
  return db.prepare(`${workerProfileViewSelect} WHERE user_id = ?`).get(userId);
}

export function getCompanyProfileByUserId(userId) {
  return db.prepare(`${companyProfileViewSelect} WHERE user_id = ?`).get(userId);
}

export function getWorkerProfileByPublicUserId(userId) {
  return getWorkerProfileByUserId(userId);
}

export function getCompanyProfileByPublicUserId(userId) {
  return getCompanyProfileByUserId(userId);
}

export const registerWorkerAccount = db.transaction(({ email, passwordHash }) => {
  const normalizedEmail = normalizeEmail(email);

  if (getUserByEmail(normalizedEmail)) {
    const error = new Error('Email gia registrata');
    error.code = 'EMAIL_EXISTS';
    throw error;
  }

  const result = db.prepare(`
    INSERT INTO users(email, password_hash, role, status, onboarding_complete)
    VALUES (?, ?, 'worker', 'active', 0)
  `).run(normalizedEmail, passwordHash);

  const userId = Number(result.lastInsertRowid);
  ensureWorkerProfileRow(userId);
  upsertLead({
    userId,
    type: 'worker',
    source: 'signup_worker',
    status: 'new_lead',
    email: normalizedEmail,
    phone: '',
    notes: ''
  });

  return getUserById(userId);
});

export const registerCompanyAccount = db.transaction(({ email, passwordHash }) => {
  const normalizedEmail = normalizeEmail(email);

  if (getUserByEmail(normalizedEmail)) {
    const error = new Error('Email gia registrata');
    error.code = 'EMAIL_EXISTS';
    throw error;
  }

  const result = db.prepare(`
    INSERT INTO users(email, password_hash, role, status, onboarding_complete)
    VALUES (?, ?, 'company', 'active', 0)
  `).run(normalizedEmail, passwordHash);

  const userId = Number(result.lastInsertRowid);
  ensureCompanyProfileRow(userId);
  upsertLead({
    userId,
    type: 'company',
    source: 'signup_company',
    status: 'new_lead',
    email: normalizedEmail,
    phone: '',
    notes: ''
  });

  return getUserById(userId);
});

export const saveWorkerOnboarding = db.transaction(({ userId, profile }) => {
  const existing = ensureWorkerProfileRow(userId);
  const nameParts = splitFullName(profile.fullName);

  db.prepare(`
    UPDATE worker_profiles
    SET first_name = ?,
        last_name = ?,
        phone = ?,
        city = ?,
        availability = ?,
        transport_method = ?,
        roles = ?,
        years_experience = ?,
        bio = ?,
        onboarding_completed = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    nameParts.firstName,
    nameParts.lastName,
    cleanText(profile.phone),
    cleanText(profile.city),
    cleanText(profile.availability),
    cleanText(profile.transportMethod),
    cleanText(profile.roles),
    cleanText(profile.yearsExperience),
    cleanText(profile.bio),
    userId
  );

  db.prepare(`
    UPDATE users
    SET onboarding_complete = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId);

  const updatedProfile = getWorkerProfileRowByUserId(userId) || existing;
  syncLegacyWorkerProfile(updatedProfile);

  const user = getUserById(userId);
  upsertLead({
    userId,
    type: 'worker',
    source: 'signup_worker',
    status: 'pending_review',
    email: user.email,
    phone: updatedProfile.phone,
    notes: buildWorkerLeadNotes(updatedProfile)
  });

  return getWorkerProfileByUserId(userId);
});

export const saveCompanyOnboarding = db.transaction(({ userId, profile }) => {
  const existing = ensureCompanyProfileRow(userId);

  db.prepare(`
    UPDATE company_profiles
    SET company_name = ?,
        contact_name = ?,
        phone = ?,
        city = ?,
        business_type = ?,
        description = ?,
        onboarding_completed = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    cleanText(profile.companyName),
    cleanText(profile.contactName),
    cleanText(profile.phone),
    cleanText(profile.city),
    cleanText(profile.businessType),
    cleanText(profile.description),
    userId
  );

  db.prepare(`
    UPDATE users
    SET onboarding_complete = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId);

  const updatedProfile = getCompanyProfileRowByUserId(userId) || existing;
  syncLegacyCompanyProfile(updatedProfile);

  const user = getUserById(userId);
  upsertLead({
    userId,
    type: 'company',
    source: 'signup_company',
    status: 'pending_review',
    email: user.email,
    phone: updatedProfile.phone,
    notes: buildCompanyLeadNotes(updatedProfile)
  });

  return getCompanyProfileByUserId(userId);
});

export function listAdminUsers({ role } = {}) {
  const values = [];
  let sql = `
    SELECT
      u.id,
      u.email,
      u.role,
      u.status,
      u.created_at,
      u.updated_at,
      u.onboarding_complete,
      CASE
        WHEN u.role = 'worker' THEN NULLIF(trim(COALESCE(wp.first_name, '') || ' ' || COALESCE(wp.last_name, '')), '')
        WHEN u.role = 'company' THEN NULLIF(cp.company_name, '')
        ELSE 'Admin'
      END AS display_name,
      CASE
        WHEN u.role = 'worker' THEN wp.phone
        WHEN u.role = 'company' THEN cp.phone
        ELSE ''
      END AS phone,
      CASE
        WHEN u.role = 'worker' THEN wp.city
        WHEN u.role = 'company' THEN cp.city
        ELSE ''
      END AS city,
      CASE
        WHEN u.role = 'worker' THEN wp.roles
        WHEN u.role = 'company' THEN cp.contact_name
        ELSE ''
      END AS secondary_label,
      CASE
        WHEN u.role = 'worker' THEN wp.onboarding_completed
        WHEN u.role = 'company' THEN cp.onboarding_completed
        ELSE 1
      END AS profile_onboarding_completed
    FROM users u
    LEFT JOIN worker_profiles wp ON wp.user_id = u.id
    LEFT JOIN company_profiles cp ON cp.user_id = u.id
    WHERE 1 = 1
  `;

  if (role) {
    sql += ' AND u.role = ?';
    values.push(role);
  }

  sql += ' ORDER BY u.created_at DESC';
  return db.prepare(sql).all(...values);
}

export function listAdminLeads({ type } = {}) {
  const values = [];
  let sql = `
    SELECT
      l.*,
      CASE
        WHEN l.type = 'worker' THEN COALESCE(NULLIF(trim(COALESCE(wp.first_name, '') || ' ' || COALESCE(wp.last_name, '')), ''), l.email)
        WHEN l.type = 'company' THEN COALESCE(NULLIF(cp.company_name, ''), l.email)
        ELSE l.email
      END AS display_name,
      CASE
        WHEN l.type = 'company' THEN cp.contact_name
        ELSE ''
      END AS contact_name,
      CASE
        WHEN l.type = 'worker' THEN wp.city
        WHEN l.type = 'company' THEN cp.city
        ELSE ''
      END AS city
    FROM leads l
    LEFT JOIN worker_profiles wp ON wp.user_id = l.user_id AND l.type = 'worker'
    LEFT JOIN company_profiles cp ON cp.user_id = l.user_id AND l.type = 'company'
    WHERE 1 = 1
  `;

  if (type) {
    sql += ' AND l.type = ?';
    values.push(type);
  }

  sql += ' ORDER BY l.created_at DESC';
  return db.prepare(sql).all(...values);
}

export const updateLeadStatus = db.transaction(({ leadId, status, adminNotes }) => {
  db.prepare(`
    UPDATE leads
    SET status = ?, admin_notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(cleanText(status), cleanText(adminNotes), leadId);

  const lead = getLeadById(leadId);

  if (lead) {
    syncLegacyLead(lead);
  }

  return lead;
});

export function updateUserRating(userId, role) {
  const ratingRow = db.prepare(`
    SELECT COALESCE(AVG(stars), 0) AS avg_rating, COUNT(*) AS review_count
    FROM reviews
    WHERE to_user_id = ?
  `).get(userId);

  const avgRating = Number(Number(ratingRow.avg_rating || 0).toFixed(2));
  const reviewCount = Number(ratingRow.review_count || 0);

  if (role === 'worker') {
    db.prepare(`
      UPDATE worker_profiles
      SET avg_rating = ?, review_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(avgRating, reviewCount, userId);

    const profile = getWorkerProfileRowByUserId(userId);
    if (profile) {
      syncLegacyWorkerProfile(profile);
    }
  }

  if (role === 'company') {
    db.prepare(`
      UPDATE company_profiles
      SET avg_rating = ?, review_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(avgRating, reviewCount, userId);

    const profile = getCompanyProfileRowByUserId(userId);
    if (profile) {
      syncLegacyCompanyProfile(profile);
    }
  }
}

function cleanText(value) {
  return String(value || '').trim();
}

function splitFullName(fullName) {
  const normalized = cleanText(fullName).replace(/\s+/g, ' ');

  if (!normalized) {
    return { firstName: '', lastName: '' };
  }

  const parts = normalized.split(' ');
  return {
    firstName: parts.shift() || '',
    lastName: parts.join(' ')
  };
}

function buildFullName(firstName, lastName) {
  return cleanText(`${cleanText(firstName)} ${cleanText(lastName)}`);
}

function buildWorkerLeadNotes(profile) {
  return [
    profile.availability ? `Availability: ${profile.availability}` : '',
    profile.roles ? `Roles: ${profile.roles}` : '',
    profile.bio ? `Bio: ${profile.bio}` : ''
  ].filter(Boolean).join('\n');
}

function buildCompanyLeadNotes(profile) {
  return [
    profile.business_type ? `Business type: ${profile.business_type}` : '',
    profile.description ? `Description: ${profile.description}` : ''
  ].filter(Boolean).join('\n');
}

function getWorkerProfileRowByUserId(userId) {
  return db.prepare('SELECT * FROM worker_profiles WHERE user_id = ?').get(userId);
}

function getCompanyProfileRowByUserId(userId) {
  return db.prepare('SELECT * FROM company_profiles WHERE user_id = ?').get(userId);
}

function ensureWorkerProfileRow(userId) {
  const existing = getWorkerProfileRowByUserId(userId);

  if (existing) {
    return existing;
  }

  db.prepare('INSERT INTO worker_profiles(user_id) VALUES (?)').run(userId);
  const created = getWorkerProfileRowByUserId(userId);
  syncLegacyWorkerProfile(created);
  return created;
}

function ensureCompanyProfileRow(userId) {
  const existing = getCompanyProfileRowByUserId(userId);

  if (existing) {
    return existing;
  }

  db.prepare('INSERT INTO company_profiles(user_id) VALUES (?)').run(userId);
  const created = getCompanyProfileRowByUserId(userId);
  syncLegacyCompanyProfile(created);
  return created;
}

function syncLegacyWorkerProfile(profile) {
  if (!profile) {
    return;
  }

  db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      full_name = excluded.full_name,
      phone = excluded.phone,
      city_area = excluded.city_area,
      transport_method = excluded.transport_method,
      roles = excluded.roles,
      years_experience = excluded.years_experience,
      bio = excluded.bio,
      avg_rating = excluded.avg_rating,
      review_count = excluded.review_count
  `).run(
    profile.id,
    profile.user_id,
    buildFullName(profile.first_name, profile.last_name),
    cleanText(profile.phone),
    cleanText(profile.city),
    cleanText(profile.transport_method),
    cleanText(profile.roles),
    cleanText(profile.years_experience),
    cleanText(profile.bio),
    Number(profile.avg_rating || 0),
    Number(profile.review_count || 0),
    profile.created_at || null
  );
}

function syncLegacyCompanyProfile(profile) {
  if (!profile) {
    return;
  }

  db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      business_name = excluded.business_name,
      contact_name = excluded.contact_name,
      phone = excluded.phone,
      city_area = excluded.city_area,
      business_type = excluded.business_type,
      description = excluded.description,
      avg_rating = excluded.avg_rating,
      review_count = excluded.review_count
  `).run(
    profile.id,
    profile.user_id,
    cleanText(profile.company_name),
    cleanText(profile.contact_name),
    cleanText(profile.phone),
    cleanText(profile.city),
    cleanText(profile.business_type),
    cleanText(profile.description),
    Number(profile.avg_rating || 0),
    Number(profile.review_count || 0),
    profile.created_at || null
  );
}

function upsertLead({ userId, type, source, status, email, phone, notes }) {
  const normalizedEmail = normalizeEmail(email);

  db.prepare(`
    INSERT INTO leads (user_id, type, source, status, email, phone, notes, admin_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, '')
    ON CONFLICT(type, email) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, leads.user_id),
      source = excluded.source,
      status = excluded.status,
      phone = excluded.phone,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId || null,
    type,
    cleanText(source),
    cleanText(status),
    normalizedEmail,
    cleanText(phone),
    cleanText(notes)
  );

  const lead = db.prepare('SELECT * FROM leads WHERE type = ? AND email = ?').get(type, normalizedEmail);
  syncLegacyLead(lead);
  return lead;
}

function syncLegacyLead(lead) {
  if (!lead) {
    return;
  }

  if (lead.type === 'worker') {
    const profile = lead.user_id ? getWorkerProfileRowByUserId(lead.user_id) : null;

    db.prepare(`
      INSERT INTO worker_leads (
        user_id,
        full_name,
        phone,
        email,
        city_area,
        transport_method,
        roles,
        years_experience,
        notes,
        status,
        admin_notes,
        source,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        user_id = excluded.user_id,
        full_name = excluded.full_name,
        phone = excluded.phone,
        city_area = excluded.city_area,
        transport_method = excluded.transport_method,
        roles = excluded.roles,
        years_experience = excluded.years_experience,
        notes = excluded.notes,
        status = excluded.status,
        admin_notes = excluded.admin_notes,
        source = excluded.source
    `).run(
      lead.user_id || null,
      profile ? buildFullName(profile.first_name, profile.last_name) : '',
      profile ? cleanText(profile.phone) : cleanText(lead.phone),
      lead.email,
      profile ? cleanText(profile.city) : '',
      profile ? cleanText(profile.transport_method) : '',
      profile ? cleanText(profile.roles) : '',
      profile ? cleanText(profile.years_experience) : '',
      cleanText(lead.notes),
      cleanText(lead.status),
      cleanText(lead.admin_notes),
      cleanText(lead.source),
      lead.created_at || null
    );
  }

  if (lead.type === 'company') {
    const profile = lead.user_id ? getCompanyProfileRowByUserId(lead.user_id) : null;

    db.prepare(`
      INSERT INTO company_leads (
        user_id,
        business_name,
        contact_name,
        phone,
        email,
        city_area,
        business_type,
        notes,
        status,
        admin_notes,
        source,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        user_id = excluded.user_id,
        business_name = excluded.business_name,
        contact_name = excluded.contact_name,
        phone = excluded.phone,
        city_area = excluded.city_area,
        business_type = excluded.business_type,
        notes = excluded.notes,
        status = excluded.status,
        admin_notes = excluded.admin_notes,
        source = excluded.source
    `).run(
      lead.user_id || null,
      profile ? cleanText(profile.company_name) : '',
      profile ? cleanText(profile.contact_name) : '',
      profile ? cleanText(profile.phone) : cleanText(lead.phone),
      lead.email,
      profile ? cleanText(profile.city) : '',
      profile ? cleanText(profile.business_type) : '',
      cleanText(lead.notes),
      cleanText(lead.status),
      cleanText(lead.admin_notes),
      cleanText(lead.source),
      lead.created_at || null
    );
  }
}
