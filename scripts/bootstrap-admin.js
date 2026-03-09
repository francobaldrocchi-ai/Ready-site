import 'dotenv/config';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
const args=process.argv.slice(2);
const email=args[args.indexOf('--email')+1] || 'admin@example.com';
const password=args[args.indexOf('--password')+1] || 'AdminPass123';
const hash=await bcrypt.hash(password,10);
const existing=db.prepare('SELECT id FROM users WHERE email=?').get(email);
if(existing){ db.prepare('UPDATE users SET password_hash=?, role=?, onboarding_complete=1 WHERE email=?').run(hash,'admin',email); }
else { db.prepare('INSERT INTO users(email,password_hash,role,onboarding_complete) VALUES(?,?,?,1)').run(email,hash,'admin'); }
console.log(`Admin ready: ${email}`);
