import { getUnit } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	authed: locals.authed,
	unit: getUnit()
});
