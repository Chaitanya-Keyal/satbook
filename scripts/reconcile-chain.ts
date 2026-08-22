// Chain reconciliation: separate network fees out of SELL/SPEND rows, verify
// recorded TRANSFER fees, and correct timestamps against the on-chain
// transaction (sheet time columns can carry a uniform offset error that the
// importer's IST-vs-UTC cross-check cannot see).
//   bun scripts/reconcile-chain.ts [--commit]
//
// For each SELL/SPEND with a txid whose wallet is self-custody (the user paid
// the miner fee; exchange-hosted wallets absorb their own fees):
//   - chain fee F comes from the explorer's top-level `fee`
//   - if some output == recorded amountSats − F → the recorded amount had the
//     fee folded in: amount := amount − F, feeSats := F (holdings unchanged)
//   - else if some output == recorded amountSats → the fee was never recorded:
//     feeSats := F, amount unchanged (holdings drop by F — the sats were
//     already gone on-chain; the ledger just didn't know)
//   - else: ambiguous — reported for manual review, never guessed.
// The INR consideration is what the counterparty actually paid — unchanged in
// both cases. feeInrValueMinor is backfilled pro-rata as informational FMV.

import { eq } from 'drizzle-orm';
import { mulDivRound, SATS_PER_BTC } from '../src/lib/utils/money';

const COMMIT = process.argv.includes('--commit');

async function main() {
	const { db, schema } = await import('../src/lib/server/db');
	const { fetchTx } = await import('../src/lib/server/esplora');
	const { computePortfolio } = await import('../src/lib/server/engine/fifo');
	const { getLedger } = await import('../src/lib/server/ledger');

	const wallets = db.select().from(schema.wallets).all();
	const kindOf = new Map(wallets.map((w) => [w.id, w.kind]));
	const rows = db.select().from(schema.transactions).all();

	const updates: {
		id: number;
		amountSats: number;
		feeSats: number;
		feeInrValueMinor: number | null;
		why: string;
	}[] = [];
	const tsFixes: { id: number; ts: number; why: string }[] = [];
	const fmvFixes: { id: number; feeInrValueMinor: number; why: string }[] = [];
	const notes: string[] = [];
	const TS_TOLERANCE_SEC = 120;

	const checkTs = (id: number, recorded: number, blockTime: number | null) => {
		if (blockTime == null) return;
		const drift = blockTime - recorded;
		if (Math.abs(drift) > TS_TOLERANCE_SEC)
			tsFixes.push({
				id,
				ts: blockTime,
				why: `recorded ts off chain block time by ${drift}s`
			});
	};

	for (const r of rows) {
		if (!r.txid) continue;

		// Every txid-bearing row gets the timestamp check, whatever its type —
		// sheet time columns have carried IST wall time in the UTC column.
		const chain = await fetchTx(r.txid);
		if (!chain) {
			notes.push(`#${r.id} ${r.type}: txid ${r.txid.slice(0, 12)}… not fetchable — skipped`);
			continue;
		}
		checkTs(r.id, r.ts, chain.blockTime);

		if (r.type === 'SELL' || r.type === 'SPEND') {
			if (kindOf.get(r.walletId!) === 'exchange') {
				notes.push(`#${r.id} ${r.type}: exchange wallet pays its own fee — fee split skipped`);
				continue;
			}
			if (r.feeSats > 0) {
				notes.push(`#${r.id} ${r.type}: already has feeSats=${r.feeSats} — fee split skipped`);
				continue;
			}
			const F = chain.feeSats;
			const outs = chain.outputs.map((o) => o.valueSats);
			if (F <= 0 || F >= r.amountSats) {
				notes.push(`#${r.id} ${r.type}: implausible chain fee ${F} — skipped`);
				continue;
			}
			if (outs.includes(r.amountSats - F)) {
				const amount = r.amountSats - F;
				updates.push({
					id: r.id,
					amountSats: amount,
					feeSats: F,
					feeInrValueMinor: mulDivRound(r.inrValueMinor!, F, amount),
					why: `fee was folded into the amount (output ${amount} found); holdings unchanged`
				});
			} else if (outs.includes(r.amountSats)) {
				updates.push({
					id: r.id,
					amountSats: r.amountSats,
					feeSats: F,
					feeInrValueMinor: mulDivRound(r.inrValueMinor!, F, r.amountSats),
					why: `fee was never recorded (output ${r.amountSats} found); holdings drop by ${F}`
				});
			} else {
				notes.push(
					`#${r.id} ${r.type}: AMBIGUOUS — recorded ${r.amountSats}, chain fee ${F}, outputs [${outs.join(', ')}] — review manually`
				);
			}
		}

		if (r.type === 'TRANSFER') {
			const src = kindOf.get(r.fromWalletId!);
			if (src === 'exchange') {
				notes.push(
					`#${r.id} TRANSFER: exchange-sourced, chain fee ${chain.feeSats} paid by the exchange — recorded feeSats=${r.feeSats} ✓ (verify: credited output ${chain.outputs.some((o) => o.valueSats === r.amountSats) ? 'matches' : 'MISSING'})`
				);
			} else if (r.feeSats === chain.feeSats) {
				notes.push(`#${r.id} TRANSFER: recorded fee ${r.feeSats} matches chain ✓`);
			} else {
				notes.push(
					`#${r.id} TRANSFER: MISMATCH — recorded fee ${r.feeSats}, chain fee ${chain.feeSats} — review manually`
				);
			}
		}
	}

	// Network-fee fair values are display-only, but they should still reflect the
	// app's current market convention — recompute any that drifted.
	const { getBtcInrAt } = await import('../src/lib/server/rates');
	for (const r of rows) {
		if (r.feeSats <= 0) continue;
		const ts = tsFixes.find((t) => t.id === r.id)?.ts ?? r.ts;
		const rate = await getBtcInrAt(ts).catch(() => null);
		if (rate == null) {
			notes.push(`#${r.id} ${r.type}: no rate for the fee FMV — left as is`);
			continue;
		}
		const fmv = mulDivRound(Math.round(rate.rate * 100), r.feeSats, SATS_PER_BTC);
		if (r.feeInrValueMinor == null || Math.abs(fmv - r.feeInrValueMinor) > 1) {
			fmvFixes.push({
				id: r.id,
				feeInrValueMinor: fmv,
				why: `fee FMV ${r.feeInrValueMinor ?? 'null'} to ${fmv} paise (${rate.source})`
			});
		}
	}

	console.log(
		`\n${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${updates.length} fee split(s), ${tsFixes.length} timestamp fix(es), ${fmvFixes.length} fee FMV refresh(es)\n`
	);
	for (const u of updates)
		console.log(`  #${u.id}: amount to ${u.amountSats}, fee to ${u.feeSats} (${u.why})`);
	for (const t of tsFixes) console.log(`  #${t.id}: ts to ${t.ts} (${t.why})`);
	for (const f of fmvFixes) console.log(`  #${f.id}: ${f.why}`);
	console.log();
	for (const n of notes) console.log(`  ${n}`);

	const before = computePortfolio(getLedger());
	if (COMMIT) {
		db.transaction(() => {
			for (const f of fmvFixes)
				db.update(schema.transactions)
					.set({ feeInrValueMinor: f.feeInrValueMinor, updatedAt: Math.floor(Date.now() / 1000) })
					.where(eq(schema.transactions.id, f.id))
					.run();
			for (const t of tsFixes)
				db.update(schema.transactions)
					.set({ ts: t.ts, updatedAt: Math.floor(Date.now() / 1000) })
					.where(eq(schema.transactions.id, t.id))
					.run();
			for (const u of updates)
				db.update(schema.transactions)
					.set({
						amountSats: u.amountSats,
						feeSats: u.feeSats,
						feeInrValueMinor: u.feeInrValueMinor,
						// The as-entered rate belonged to the pre-split amount; the stored
						// integers are now the only truth and the rate derives from them.
						enteredRate: null,
						rateSource: null,
						updatedAt: Math.floor(Date.now() / 1000)
					})
					.where(eq(schema.transactions.id, u.id))
					.run();
		});
	}
	const after = COMMIT ? computePortfolio(getLedger()) : null;

	console.log(`\nholdings before: ${before.holdingsSats} sats`);
	if (after) {
		console.log(
			`holdings after:  ${after.holdingsSats} sats (Δ ${after.holdingsSats - before.holdingsSats})`
		);
		if (after.issues.length) {
			console.error('ENGINE ISSUES AFTER FIX:', after.issues);
			process.exit(1);
		}
		const byFy = new Map<string, number>();
		for (const r of after.vdaRows) byFy.set(r.fy, (byFy.get(r.fy) ?? 0) + r.incomeMinor);
		for (const [fy, v] of byFy) console.log(`${fy} conservative: ₹${(v / 100).toFixed(2)}`);
	}
}

await main();
