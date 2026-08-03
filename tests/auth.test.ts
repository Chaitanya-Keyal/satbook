// Auth smoke tests. DATABASE_PATH must be set BEFORE the db module initializes,
// so everything that touches ../src/lib/server/db is imported dynamically after
// the env assignment (static imports would hoist above it).
import { describe, expect, test } from 'bun:test';

process.env.DATABASE_PATH = ':memory:';
delete process.env.ADMIN_PASSWORD;

const {
	bootstrapPasswordFromEnv,
	changePassword,
	createSession,
	destroyAllSessions,
	destroySession,
	recordLoginSuccess,
	reserveLoginAttempt,
	validateAndExtendSession,
	verifyPassword
} = await import('../src/lib/server/auth');
const { db, schema } = await import('../src/lib/server/db');
const { getPasswordHash } = await import('../src/lib/server/settings');
const { eq } = await import('drizzle-orm');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const sha256 = (t: string) => new Bun.CryptoHasher('sha256').update(t).digest('hex');
const sessionRow = (token: string) =>
	db
		.select()
		.from(schema.sessions)
		.where(eq(schema.sessions.tokenHash, sha256(token)))
		.get();
const limiterRow = () =>
	db.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.key, 'global')).get();

describe('bootstrapPasswordFromEnv', () => {
	test('no hash and no env → nothing stored', () => {
		bootstrapPasswordFromEnv();
		expect(getPasswordHash()).toBeNull();
	});

	test('sets hash from env on first boot', async () => {
		process.env.ADMIN_PASSWORD = 'first-password';
		bootstrapPasswordFromEnv();
		expect(getPasswordHash()).not.toBeNull();
		expect(await verifyPassword('first-password')).toBe(true);
	});

	test('env is ignored once a hash exists', async () => {
		process.env.ADMIN_PASSWORD = 'second-password';
		bootstrapPasswordFromEnv();
		expect(await verifyPassword('second-password')).toBe(false);
		expect(await verifyPassword('first-password')).toBe(true);
		delete process.env.ADMIN_PASSWORD;
	});
});

describe('verifyPassword', () => {
	test('rejects a wrong password', async () => {
		expect(await verifyPassword('not-the-password')).toBe(false);
	});
});

describe('sessions', () => {
	test('create → validate; garbage token rejected', () => {
		const token = createSession();
		expect(validateAndExtendSession(token)).toBe(true);
		expect(validateAndExtendSession('garbage-token')).toBe(false);
	});

	test('expired session is deleted and rejected', () => {
		const token = createSession();
		db.update(schema.sessions)
			.set({ expiresAt: now() - 10 })
			.where(eq(schema.sessions.tokenHash, sha256(token)))
			.run();
		expect(validateAndExtendSession(token)).toBe(false);
		expect(sessionRow(token)).toBeFalsy();
	});

	test('sliding extension, throttled to one write per hour', () => {
		const token = createSession();
		const created = sessionRow(token)!.createdAt;
		db.update(schema.sessions)
			.set({ expiresAt: created + 7200 })
			.where(eq(schema.sessions.tokenHash, sha256(token)))
			.run();
		expect(validateAndExtendSession(token)).toBe(true);
		const extended = sessionRow(token)!.expiresAt;
		expect(extended).toBeGreaterThanOrEqual(now() + 30 * DAY - 5);
		expect(extended).toBeLessThanOrEqual(now() + 30 * DAY);
		// Immediate revalidation must not move expiry again (<1 h delta).
		expect(validateAndExtendSession(token)).toBe(true);
		expect(sessionRow(token)!.expiresAt).toBe(extended);
	});

	test('sliding extension never passes the 90 d absolute cap', () => {
		const token = createSession();
		const created = now() - 86 * DAY;
		db.update(schema.sessions)
			.set({ createdAt: created, expiresAt: now() + 1000 })
			.where(eq(schema.sessions.tokenHash, sha256(token)))
			.run();
		expect(validateAndExtendSession(token)).toBe(true);
		expect(sessionRow(token)!.expiresAt).toBe(created + 90 * DAY);
	});

	test('destroySession and destroyAllSessions', () => {
		const a = createSession();
		const b = createSession();
		destroySession(a);
		expect(validateAndExtendSession(a)).toBe(false);
		expect(validateAndExtendSession(b)).toBe(true);
		destroyAllSessions();
		expect(validateAndExtendSession(b)).toBe(false);
	});
});

describe('login limiter', () => {
	test('reservation charges up-front: 5 slots then locked', () => {
		recordLoginSuccess();
		for (let i = 0; i < 5; i++) expect(reserveLoginAttempt().allowed).toBe(true);
		const gate = reserveLoginAttempt();
		expect(gate.allowed).toBe(false);
		expect(gate.retryAfterSec).toBeGreaterThan(0);
		expect(gate.retryAfterSec).toBeLessThanOrEqual(15 * 60);
	});

	test('a burst has no free rides — every reservation consumes a slot (TOCTOU fix)', () => {
		recordLoginSuccess();
		const results = Array.from({ length: 20 }, () => reserveLoginAttempt().allowed);
		expect(results.filter(Boolean)).toHaveLength(5);
		expect(limiterRow()!.failCount).toBe(5);
	});

	test('unlocks once the lock window has passed', () => {
		db.update(schema.loginAttempts)
			.set({ lockedUntil: now() - 1 })
			.where(eq(schema.loginAttempts.key, 'global'))
			.run();
		expect(reserveLoginAttempt().allowed).toBe(true);
	});

	test('attempts outside the 15 min window reset the count', () => {
		recordLoginSuccess();
		db.insert(schema.loginAttempts)
			.values({ key: 'global', failCount: 4, firstFailAt: now() - 16 * 60, lockedUntil: null })
			.run();
		expect(reserveLoginAttempt().allowed).toBe(true);
		expect(limiterRow()!.failCount).toBe(1);
	});

	test('success resets the limiter even when locked', () => {
		recordLoginSuccess();
		for (let i = 0; i < 6; i++) reserveLoginAttempt();
		expect(reserveLoginAttempt().allowed).toBe(false);
		recordLoginSuccess();
		expect(reserveLoginAttempt().allowed).toBe(true);
		expect(limiterRow()).toBeTruthy();
	});
});

describe('changePassword', () => {
	test('rehashes and destroys every session', async () => {
		const a = createSession();
		const b = createSession();
		await changePassword('third-password');
		expect(await verifyPassword('first-password')).toBe(false);
		expect(await verifyPassword('third-password')).toBe(true);
		expect(validateAndExtendSession(a)).toBe(false);
		expect(validateAndExtendSession(b)).toBe(false);
	});
});
