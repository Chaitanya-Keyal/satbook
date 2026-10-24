import { lightningConfigState } from '$lib/server/lightning/config';
import { getUnit } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	authed: locals.authed,
	unit: getUnit(),
	// Shown when configured, and when misconfigured so the page can say why.
	lightning: lightningConfigState().state !== 'off'
});
