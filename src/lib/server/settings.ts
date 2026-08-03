import { eq } from 'drizzle-orm';
import { db, schema } from './db';

export function getSetting(key: string): string | null {
	const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
	return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
	db.insert(schema.settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: schema.settings.key, set: { value } })
		.run();
}

export function deleteSetting(key: string): void {
	db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
}

// Typed accessors --------------------------------------------------------

export function getUnit(): 'sats' | 'btc' {
	return getSetting('unit') === 'btc' ? 'btc' : 'sats';
}

export function setUnit(unit: 'sats' | 'btc'): void {
	setSetting('unit', unit);
}

export function getPasswordHash(): string | null {
	return getSetting('password_hash');
}

export function setPasswordHash(hash: string): void {
	setSetting('password_hash', hash);
}
