import { json, redirect, type Handle } from '@sveltejs/kit';
import {
  bootstrapPasswordFromEnv,
  SESSION_COOKIE,
  validateAndExtendSession
} from '$lib/server/auth';

bootstrapPasswordFromEnv();

const PUBLIC_PATHS = new Set(['/login', '/healthz']);

export const handle: Handle = async ({ event, resolve }) => {
  // Validate on every request (allowlisted paths too) so /login can bounce
  // already-authed users back to /.
  const token = event.cookies.get(SESSION_COOKIE);
  event.locals.authed = token ? validateAndExtendSession(token) : false;

  const { pathname } = event.url;
  if (!event.locals.authed && !PUBLIC_PATHS.has(pathname)) {
    if (pathname === '/api' || pathname.startsWith('/api/'))
      return json({ error: 'unauthorized' }, { status: 401 });
    redirect(303, '/login');
  }
  const response = await resolve(event);
  // Never framed (no clickjacking from a sibling host), no type sniffing, and
  // no URLs leaking to other sites.
  response.headers.set('content-security-policy', "frame-ancestors 'none'");
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'same-origin');
  return response;
};
