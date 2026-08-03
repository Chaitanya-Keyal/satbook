import { fail, redirect } from '@sveltejs/kit';
import {
	createSession,
	recordLoginSuccess,
	reserveLoginAttempt,
	verifyPassword
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.authed) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		// Atomically consume a limiter slot before any await — see auth.ts.
		const gate = reserveLoginAttempt();
		if (!gate.allowed) return fail(429, { retryAfterSec: gate.retryAfterSec });

		const form = await request.formData();
		const password = form.get('password');

		// Constant delay on every attempt — keeps success/failure timing uniform.
		await Bun.sleep(300);

		if (typeof password !== 'string' || !(await verifyPassword(password))) {
			return fail(400, { incorrect: true }); // the slot was already charged
		}

		recordLoginSuccess();
		const token = createSession();
		cookies.set('session', token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 60 * 60 * 24 * 30
		});
		redirect(303, '/');
	}
};
