// GET /tax/[fy]/export — Schedule VDA CSV download for one FY. 400 on a
// malformed FY label, 404 when the FY has no disposal rows (the page's export
// button is disabled in that state; this guards direct navigation).

import { json } from '@sveltejs/kit';
import { buildVdaCsv } from '$lib/server/csv';
import { getLedger, getPortfolio } from '$lib/server/ledger';
import { fyStartYear } from '$lib/utils/fy';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	let startYear: number;
	try {
		startYear = fyStartYear(params.fy);
	} catch {
		return json({ error: `invalid FY label '${params.fy}'` }, { status: 400 });
	}

	const rows = getPortfolio().vdaRows.filter((r) => r.fy === params.fy);
	if (rows.length === 0) return json({ error: 'no disposals' }, { status: 404 });

	const txidByDisposal = new Map(getLedger().map((t) => [t.id, t.txid] as const));
	const csv = buildVdaCsv(rows, params.fy, txidByDisposal);

	const yy = ((startYear + 1) % 100).toString().padStart(2, '0');
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="schedule-vda-fy${startYear}-${yy}.csv"`
		}
	});
};
