import { json } from '@sveltejs/kit';
import { getLedger } from '$lib/server/ledger';
import { ensureDailySeries, getDailyCloses } from '$lib/server/rates';
import { getLiveRow, nowSec } from '$lib/server/rates/cache';
import type { ChartPayload, ChartPoint } from '$lib/types';
import { mulDivRound, SATS_PER_BTC } from '$lib/utils/money';
import { utcDateString } from '$lib/utils/time';
import type { RequestHandler } from './$types';

const DAY = 86400;

export const GET: RequestHandler = async () => {
	const ledger = getLedger(); // (ts, seq, id) ascending — first row is the earliest
	if (ledger.length === 0) return json({ points: [], backfilling: false } satisfies ChartPayload);

	const firstTs = ledger[0].ts;
	const { backfilling } = await ensureDailySeries(firstTs);

	const now = nowSec();
	const closes = getDailyCloses(firstTs, now);
	// Today has no elapsed candle; use whatever live row exists without forcing
	// a refresh (a slightly stale close is fine for the chart's last point).
	const live = getLiveRow();
	if (live) closes.set(utcDateString(now), live.btcInr);

	const points: ChartPoint[] = [];
	const firstDay = Math.floor(firstTs / DAY) * DAY;
	const todayStart = Math.floor(now / DAY) * DAY;
	let i = 0;
	let sats = 0;
	let investedMinor = 0;
	for (let day = firstDay; day <= todayStart; day += DAY) {
		while (i < ledger.length && ledger[i].ts < day + DAY) {
			const tx = ledger[i++];
			switch (tx.type) {
				case 'INCOME':
				case 'BUY':
					sats += tx.amountSats;
					investedMinor += tx.inrValueMinor ?? 0;
					break;
				case 'SELL':
				case 'SPEND':
					sats -= tx.amountSats;
					investedMinor -= tx.inrValueMinor ?? 0;
					break;
				case 'TRANSFER':
					sats -= tx.feeSats; // moves are net-zero across wallets; only the fee leaves
					break;
			}
		}
		const date = utcDateString(day);
		const close = closes.get(date);
		const closePaise = close == null ? null : Math.round(close * 100);
		points.push({
			date,
			valueMinor:
				closePaise == null ? null : mulDivRound(Math.max(0, sats), closePaise, SATS_PER_BTC),
			investedMinor
		});
	}
	return json({ points, backfilling } satisfies ChartPayload);
};
