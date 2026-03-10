import 'dotenv/config';
import { dbPath, upsertAdminUser } from '../db/index.js';

const args = process.argv.slice(2);
const email = readArg('--email') || process.env.ADMIN_EMAIL || 'admin@example.com';
const password = readArg('--password') || process.env.ADMIN_PASSWORD || 'ChangeMeNow123!';
const admin = upsertAdminUser({ email, password });

console.log(`Admin ready: ${admin.email}`);
console.log(`SQLite path: ${dbPath}`);

function readArg(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
