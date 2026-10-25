import { redirect } from '@sveltejs/kit';
import { destroySession, SESSION_COOKIE, sessionCookieOptions } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
  const token = cookies.get(SESSION_COOKIE);
  if (token) destroySession(token);
  cookies.delete(SESSION_COOKIE, { path: '/', secure: sessionCookieOptions.secure });
  redirect(303, '/login');
};
