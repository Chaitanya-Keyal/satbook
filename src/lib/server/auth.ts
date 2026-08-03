// Single-password auth: argon2id hash lives in the settings KV, sessions are
// opaque 32-byte tokens (only the sha256 is stored), sliding 30 d expiry with a
// hard 90 d cap from creation, and a login limiter persisted in SQLite so it
// survives restarts.

import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { getPasswordHash, setPasswordHash } from './settings';

const SESSION_TTL_SEC = 30 * 86400;
const SESSION_ABS_CAP_SEC = 90 * 86400;
// Sliding-extend writes are throttled: skip the UPDATE unless it moves expiry ≥1 h.
const EXTEND_MIN_DELTA_SEC = 3600;

const MAX_FAILS = 5;
const FAIL_WINDOW_SEC = 15 * 60;
const LOCK_SEC = 15 * 60;
const LIMITER_KEY = 'global';

const nowSec = () => Math.floor(Date.now() / 1000);

function sha256Hex(input: string): string {
	return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

export function bootstrapPasswordFromEnv(): void {
	// Once a hash exists the env var is ignored forever; changes go through /settings.
	if (getPasswordHash() !== null) return;
	const pw = process.env.ADMIN_PASSWORD;
	if (!pw) {
		console.error(
			'satbook: no password configured. Set ADMIN_PASSWORD in the environment for ' +
				'first boot; it is hashed and stored on startup, after which you must remove it ' +
				'from the env file. Until then, login is impossible.'
		);
		return;
	}
	setPasswordHash(Bun.password.hashSync(pw, { algorithm: 'argon2id' }));
	console.warn(
		'satbook: admin password hash stored from ADMIN_PASSWORD. REMOVE ADMIN_PASSWORD ' +
			'from your env file now — it is ignored from here on; change the password via /settings.'
	);
}

export async function verifyPassword(pw: string): Promise<boolean> {
	const hash = getPasswordHash();
	if (hash === null) return false;
	return Bun.password.verify(pw, hash);
}

/** Creates a session row and returns the raw base64url token (never stored). */
export function createSession(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const token = Buffer.from(bytes).toString('base64url');
	const now = nowSec();
	db.insert(schema.sessions)
		.values({ tokenHash: sha256Hex(token), createdAt: now, expiresAt: now + SESSION_TTL_SEC })
		.run();
	return token;
}

export function validateAndExtendSession(token: string): boolean {
	const tokenHash = sha256Hex(token);
	const row = db
		.select()
		.from(schema.sessions)
		.where(eq(schema.sessions.tokenHash, tokenHash))
		.get();
	if (!row) return false;
	const now = nowSec();
	if (row.expiresAt <= now) {
		db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash)).run();
		return false;
	}
	const extended = Math.min(now + SESSION_TTL_SEC, row.createdAt + SESSION_ABS_CAP_SEC);
	if (extended - row.expiresAt >= EXTEND_MIN_DELTA_SEC) {
		db.update(schema.sessions)
			.set({ expiresAt: extended })
			.where(eq(schema.sessions.tokenHash, tokenHash))
			.run();
	}
	return true;
}

export function destroySession(token: string): void {
	db.delete(schema.sessions)
		.where(eq(schema.sessions.tokenHash, sha256Hex(token)))
		.run();
}

export function destroyAllSessions(): void {
	db.delete(schema.sessions).run();
}

export async function changePassword(newPw: string): Promise<void> {
	setPasswordHash(await Bun.password.hash(newPw, { algorithm: 'argon2id' }));
	destroyAllSessions();
}

export function reserveLoginAttempt(): { allowed: boolean; retryAfterSec: number } {
	// Charge the attempt BEFORE any async work (formData/sleep/argon2id). All
	// bun:sqlite calls here are synchronous with no awaits between read and
	// write, so concurrent requests cannot interleave inside the reservation —
	// a burst of N parallel attempts consumes N slots, not 1 (TOCTOU fix).
	const now = nowSec();
	const row = db
		.select()
		.from(schema.loginAttempts)
		.where(eq(schema.loginAttempts.key, LIMITER_KEY))
		.get();
	if (row?.lockedUntil != null && row.lockedUntil > now)
		return { allowed: false, retryAfterSec: row.lockedUntil - now };

	let failCount = 1;
	let firstFailAt = now;
	if (row && row.firstFailAt !== null && now - row.firstFailAt <= FAIL_WINDOW_SEC) {
		failCount = row.failCount + 1;
		firstFailAt = row.firstFailAt;
	}
	// Reaching MAX_FAILS arms a 15-min lock for SUBSEQUENT attempts; this one
	// still runs (a correct password on the last slot must succeed and refund).
	const lockedUntil = failCount >= MAX_FAILS ? now + LOCK_SEC : null;
	db.insert(schema.loginAttempts)
		.values({ key: LIMITER_KEY, failCount, firstFailAt, lockedUntil })
		.onConflictDoUpdate({
			target: schema.loginAttempts.key,
			set: { failCount, firstFailAt, lockedUntil }
		})
		.run();
	return { allowed: true, retryAfterSec: 0 };
}

export function recordLoginSuccess(): void {
	db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.key, LIMITER_KEY)).run();
}
