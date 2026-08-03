import { fail } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import { getLedger, getPortfolio } from '$lib/server/ledger';
import { getLivePrice } from '$lib/server/rates';
import type { LivePricePayload, WalletKind } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

const KINDS: WalletKind[] = ['hot', 'cold', 'exchange'];
const nowSec = () => Math.floor(Date.now() / 1000);

// Basic shape check only (spec §5): bech32 (bc1…) or legacy base58 (1…/3…).
const BECH32_RE = /^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,87}$/;
const BASE58_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/;
function looksLikeBtcAddress(a: string): boolean {
	return BECH32_RE.test(a.toLowerCase()) || BASE58_RE.test(a);
}

export const load: PageServerLoad = async () => {
	const portfolio = getPortfolio();
	const ledger = getLedger();

	// Price is decoration here — never block the wallets screen on a fetch.
	let price: LivePricePayload | null = null;
	try {
		price = await getLivePrice();
	} catch {
		price = null;
	}

	const walletRows = db
		.select()
		.from(schema.wallets)
		.all()
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
	const names = new Map(walletRows.map((w) => [w.id, w.name]));

	const lastActivity = new Map<number, number>();
	for (const t of ledger) {
		for (const wid of [t.walletId, t.fromWalletId, t.toWalletId]) {
			if (wid != null) lastActivity.set(wid, Math.max(lastActivity.get(wid) ?? 0, t.ts));
		}
	}

	const wallets = walletRows
		.filter((w) => w.archivedAt == null)
		.map((w) => ({
			id: w.id,
			name: w.name,
			kind: w.kind,
			sats: portfolio.walletBalancesSats[w.id] ?? 0,
			lastTs: lastActivity.get(w.id) ?? null
		}));

	const transfers = ledger
		.filter((t) => t.type === 'TRANSFER')
		.reverse()
		.map((t) => ({
			id: t.id,
			ts: t.ts,
			amountSats: t.amountSats,
			feeSats: t.feeSats,
			txid: t.txid,
			fromName: t.fromWalletId != null ? (names.get(t.fromWalletId) ?? '?') : '?',
			toName: t.toWalletId != null ? (names.get(t.toWalletId) ?? '?') : '?'
		}));

	const addresses = db
		.select()
		.from(schema.walletAddresses)
		.all()
		.map((a) => ({ id: a.id, walletId: a.walletId, label: a.label, address: a.address }));

	return {
		wallets,
		holdingsSats: portfolio.holdingsSats,
		price,
		transfers,
		addresses,
		now: nowSec()
	};
};

export const actions: Actions = {
	createWallet: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const kind = String(form.get('kind') ?? '');
		if (name.length === 0 || name.length > 40)
			return fail(400, { createError: 'name must be 1–40 characters' });
		if (!KINDS.includes(kind as WalletKind))
			return fail(400, { createError: 'kind must be hot, cold or exchange' });
		const clash = db.select().from(schema.wallets).where(eq(schema.wallets.name, name)).get();
		if (clash) return fail(400, { createError: `a wallet named "${name}" already exists` });
		const maxSort = db
			.select()
			.from(schema.wallets)
			.all()
			.reduce((m, w) => Math.max(m, w.sortOrder), 0);
		db.insert(schema.wallets)
			.values({ name, kind: kind as WalletKind, sortOrder: maxSort + 1, createdAt: nowSec() })
			.run();
		return { created: true };
	},

	renameWallet: async ({ request }) => {
		const form = await request.formData();
		const id = toId(form.get('id'));
		const name = String(form.get('name') ?? '').trim();
		if (id == null) return fail(400, { renameId: id, renameError: 'invalid wallet id' });
		if (name.length === 0 || name.length > 40)
			return fail(400, { renameId: id, renameError: 'name must be 1–40 characters' });
		const existing = db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).get();
		if (!existing) return fail(404, { renameId: id, renameError: 'wallet not found' });
		const clash = db
			.select()
			.from(schema.wallets)
			.where(and(eq(schema.wallets.name, name), ne(schema.wallets.id, id)))
			.get();
		if (clash) return fail(400, { renameId: id, renameError: `"${name}" is already taken` });
		db.update(schema.wallets).set({ name }).where(eq(schema.wallets.id, id)).run();
		return { renamed: true };
	},

	archiveWallet: async ({ request }) => {
		const form = await request.formData();
		const id = toId(form.get('id'));
		if (id == null) return fail(400, { archiveId: id, archiveError: 'invalid wallet id' });
		const existing = db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).get();
		if (!existing) return fail(404, { archiveId: id, archiveError: 'wallet not found' });
		if (existing.archivedAt != null)
			return fail(400, { archiveId: id, archiveError: 'wallet is already archived' });
		const balance = getPortfolio().walletBalancesSats[id] ?? 0;
		if (balance !== 0)
			return fail(400, {
				archiveId: id,
				archiveError: `"${existing.name}" still holds ${balance} sats — only zero-balance wallets can be archived`
			});
		db.update(schema.wallets).set({ archivedAt: nowSec() }).where(eq(schema.wallets.id, id)).run();
		return { archived: true };
	},

	addAddress: async ({ request }) => {
		const form = await request.formData();
		const walletId = toId(form.get('walletId'));
		const label = String(form.get('label') ?? '').trim();
		const address = String(form.get('address') ?? '').trim();
		if (walletId == null) return fail(400, { addressError: 'pick a wallet' });
		const wallet = db.select().from(schema.wallets).where(eq(schema.wallets.id, walletId)).get();
		if (!wallet || wallet.archivedAt != null)
			return fail(400, { addressError: 'wallet not found or archived' });
		if (!looksLikeBtcAddress(address))
			return fail(400, {
				addressError: 'that does not look like a bitcoin address (bc1…, 1… or 3…)'
			});
		const clash = db
			.select()
			.from(schema.walletAddresses)
			.where(eq(schema.walletAddresses.address, address))
			.get();
		if (clash) return fail(400, { addressError: 'this address is already saved' });
		db.insert(schema.walletAddresses)
			.values({ walletId, label: label === '' ? null : label, address })
			.run();
		return { addressAdded: true };
	},

	deleteAddress: async ({ request }) => {
		const form = await request.formData();
		const id = toId(form.get('id'));
		if (id == null) return fail(400, { addressDeleteError: 'invalid address id' });
		db.delete(schema.walletAddresses).where(eq(schema.walletAddresses.id, id)).run();
		return { addressDeleted: true };
	}
};

function toId(v: FormDataEntryValue | null): number | null {
	const s = String(v ?? '');
	return /^\d+$/.test(s) ? +s : null;
}
