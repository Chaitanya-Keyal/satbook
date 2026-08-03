// One-time data fix: separate network fees out of SELL/SPEND rows using the
// on-chain transaction, and verify recorded TRANSFER fees against the chain.
//   bun scripts/split-network-fees.ts [--commit]
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
import { mulDivRound } from '../src/lib/utils/money';

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
	const notes: string[] = [];

	for (const r of rows) {
		if (!r.txid) continue;

		if (r.type === 'SELL' || r.type === 'SPEND') {
			if (kindOf.get(r.walletId!) === 'exchange') {
				notes.push(`#${r.id} ${r.type}: exchange wallet pays its own fee — skipped`);
				continue;
			}
			if (r.feeSats > 0) {
				notes.push(`#${r.id} ${r.type}: already has feeSats=${r.feeSats} — skipped`);
				continue;
			}
			const chain = await fetchTx(r.txid);
			if (!chain) {
				notes.push(`#${r.id} ${r.type}: txid ${r.txid.slice(0, 12)}… not fetchable — skipped`);
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
			const chain = await fetchTx(r.txid);
			if (!chain) {
				notes.push(`#${r.id} TRANSFER: txid not fetchable — skipped`);
				continue;
			}
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

	console.log(`\n${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${updates.length} row(s) to update\n`);
	for (const u of updates)
		console.log(`  #${u.id}: amount → ${u.amountSats}, fee → ${u.feeSats} (${u.why})`);
	console.log();
	for (const n of notes) console.log(`  ${n}`);

	const before = computePortfolio(getLedger());
	if (COMMIT) {
		db.transaction(() => {
			for (const u of updates)
				db.update(schema.transactions)
					.set({
						amountSats: u.amountSats,
						feeSats: u.feeSats,
						feeInrValueMinor: u.feeInrValueMinor,
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
