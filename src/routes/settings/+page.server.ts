import { fail, redirect } from '@sveltejs/kit';
import { changePassword, verifyPassword } from '$lib/server/auth';
import { db, schema } from '$lib/server/db';
import { getLedger } from '$lib/server/ledger';
import { getUnit } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

const MIN_PASSWORD_LEN = 8;

export const load: PageServerLoad = () => {
	const wallets = db.select().from(schema.wallets).all();
	return {
		unit: getUnit(),
		txCount: getLedger().length,
		walletCount: wallets.filter((w) => w.archivedAt == null).length
	};
};

export const actions: Actions = {
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
