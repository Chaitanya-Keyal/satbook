import { json, redirect, type Handle } from '@sveltejs/kit';
import { bootstrapPasswordFromEnv, validateAndExtendSession } from '$lib/server/auth';

bootstrapPasswordFromEnv();

const PUBLIC_PATHS = new Set(['/login', '/healthz']);

export const handle: Handle = async ({ event, resolve }) => {
	// Validate on every request (allowlisted paths too) so /login can bounce
	// already-authed users back to /.
	const token = event.cookies.get('session');
	event.locals.authed = token ? validateAndExtendSession(token) : false;

	const { pathname } = event.url;
	if (!event.locals.authed && !PUBLIC_PATHS.has(pathname)) {
		if (pathname === '/api' || pathname.startsWith('/api/'))
			return json({ error: 'unauthorized' }, { status: 401 });
		redirect(303, '/login');
	}
	return resolve(event);
};
