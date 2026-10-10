// Usage: node scripts/hash-password.mjs
// Prompts for a password (input is hidden) and prints a hash in the format the platform verifies.
// Use it to set a staff/buyer password directly in D1 when email reset is not configured yet.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const ITERATIONS = 100_000;
const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
rl._writeToOutput = (text) => { if (text.includes('Password')) process.stderr.write(text); };
rl.question('Password (min 12 chars, letters + numbers): ', (password) => {
  rl.close();
  process.stderr.write('\n');
  if (password.length < 12 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    console.error('Password must be at least 12 characters with letters and numbers.');
    process.exit(1);
  }
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password.normalize('NFKC'), salt, ITERATIONS, 32, 'sha256');
  console.log(`pbkdf2-sha256$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`);
});
