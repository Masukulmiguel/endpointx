/**
 * Deterministic secrets for tests. MUST be the first import of every test
 * file: app modules read process.env.JWT_SECRET etc. at module load.
 *
 * Unconditional overwrite: ambient/.env values must never leak into a test run
 * (the local .env carries a 20-char AGENT_SECRET that would make
 * requireAgentSecret() throw mid-test).
 */
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = crypto.randomBytes(48).toString('hex');
process.env.AGENT_SECRET = crypto.randomBytes(32).toString('hex');
