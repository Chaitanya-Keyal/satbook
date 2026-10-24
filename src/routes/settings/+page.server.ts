import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { changePassword, verifyPassword } from '$lib/server/auth';
import { db, schema } from '$lib/server/db';
import { getLedger } from '$lib/server/ledger';
import { displayOrigin, lightningConfigState } from '$lib/server/lightning/config';
import { describeError } from '$lib/server/lightning/http';
import { lnbitsFor } from '$lib/server/lightning/lnbits';
import { lightningWallet, setLightningWallet } from '$lib/server/lightning/node';
import { phoenixd } from '$lib/server/lightning/phoenixd';
import { lastSync } from '$lib/server/lightning/sync';
import { getUnit } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

const MIN_PASSWORD_LEN = 8;

export const load: PageServerLoad = () => {
	const wallets = db.select().from(schema.wallets).all();
	return {
		unit: getUnit(),
		txCount: getLedger().length,
		walletCount: wallets.filter((w) => w.archivedAt == null).length,
		dbPath: process.env.DATABASE_PATH ?? 'data/btc.db',
		lightning: lightningSettings(wallets)
	};
};

function lightningSettings(wallets: (typeof schema.wallets.$inferSelect)[]) {
	const st = lightningConfigState();
	if (st.state === 'off') return null;
	if (st.state === 'invalid') return { configured: false as const, problem: st.problem };
	const cfg = st.config;
	return {
		configured: true as const,
		phoenixd: displayOrigin(cfg.phoenixdUrl),
		lnbits: cfg.lnbitsUrl ? displayOrigin(cfg.lnbitsUrl) : null,
		proxy: cfg.proxy ? displayOrigin(cfg.proxy) : null,
		address: cfg.lightningAddress,
		walletId: lightningWallet()?.id ?? null,
		wallets: wallets
			.filter((w) => w.archivedAt == null && w.layer === 'lightning')
			.map((w) => ({ id: w.id, name: w.name, custodial: w.custodial })),
		lastSync: lastSync()
	};
}

export const actions: Actions = {
	/** Choose the wallet that stands for the node, or create one for it. */
	lnWallet: async ({ request }) => {
		if (lightningConfigState().state !== 'on')
			return fail(400, { lnError: 'Lightning is not configured' });
		const form = await request.formData();
		if (form.get('create') === '1') {
			const name = String(form.get('name') ?? '').trim();
			if (name.length === 0 || name.length > 40)
				return fail(400, { lnError: 'name must be 1–40 characters' });
			const clash = db.select().from(schema.wallets).where(eq(schema.wallets.name, name)).get();
			if (clash) return fail(400, { lnError: `a wallet named "${name}" already exists` });
			const maxSort = db
				.select()
				.from(schema.wallets)
				.all()
				.reduce((m, w) => Math.max(m, w.sortOrder), 0);
			const row = db
				.insert(schema.wallets)
				.values({
					name,
					kind: 'hot',
					layer: 'lightning',
					custodial: false, // phoenixd: the keys are on your server
					sortOrder: maxSort + 1,
					createdAt: Math.floor(Date.now() / 1000)
				})
				.returning({ id: schema.wallets.id })
				.get();
			setLightningWallet(row.id);
			return { lnSaved: true };
		}
		const raw = String(form.get('walletId') ?? '');
		const id = /^\d+$/.test(raw) ? Number(raw) : null;
		const w =
			id == null ? null : db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).get();
		if (!w || w.archivedAt != null || w.layer !== 'lightning')
			return fail(400, { lnError: 'pick a live Lightning wallet' });
		setLightningWallet(w.id);
		return { lnSaved: true };
	},

	/** Reach the node (and LNbits) and report which phoenixd password satbook holds. */
	lnTest: async () => {
		const st = lightningConfigState();
		if (st.state !== 'on') return fail(400, { lnError: 'Lightning is not configured' });
		const node = phoenixd(st.config);
		const [info, scope] = await Promise.all([node.getInfo(), node.passwordScope()]);
		const lb = lnbitsFor(st.config);
		const wallet = lb ? await lb.getWallet() : null;
		return {
			lnTest: {
				node: info.ok
					? {
							ok: true as const,
							chain: info.data.chain,
							version: info.data.version,
							nodeId: info.data.nodeId
						}
					: { ok: false as const, error: `phoenixd ${describeError(info)}` },
				scope,
				lnbits:
					wallet == null
						? null
						: wallet.ok
							? { ok: true as const, name: wallet.data.name }
							: { ok: false as const, error: `LNbits ${describeError(wallet)}` }
			}
		};
	},

	changePassword: async ({ request }) => {
		const form = await request.formData();
		const current = form.get('current');
		const next = form.get('new');
		const confirm = form.get('confirm');
		if (typeof current !== 'string' || typeof next !== 'string' || typeof confirm !== 'string')
			return fail(400, { passwordError: 'all three fields are required' });
		if (next.length < MIN_PASSWORD_LEN)
			return fail(400, {
				passwordError: `new password must be at least ${MIN_PASSWORD_LEN} characters`
			});
		if (next !== confirm)
			return fail(400, { passwordError: 'new password and confirmation do not match' });
		if (!(await verifyPassword(current)))
			return fail(400, { passwordError: 'current password is incorrect' });
		await changePassword(next); // destroys every session, including this one
		redirect(303, '/login');
	}
};
