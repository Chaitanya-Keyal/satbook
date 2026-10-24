import { dev } from '$app/environment';
import { error, fail, redirect } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db';
import type { Decision } from '$lib/server/lightning/classify';
import { lightningConfigState } from '$lib/server/lightning/config';
import { lightningWallet } from '$lib/server/lightning/node';
import {
	currentNode,
	ignoreBefore,
	ignoredPayments,
	linkPayment,
	pendingPayments,
	recordAsSuggested,
	recordPayment,
	setIgnored
} from '$lib/server/lightning/review';
import { syncLightning } from '$lib/server/lightning/sync';
import { npub } from '$lib/server/lightning/zap';
import type { IncomeKind } from '$lib/types';
import { istInputToUtcSec } from '$lib/utils/time';
import type { Actions, PageServerLoad } from './$types';

const KINDS: IncomeKind[] = ['donation', 'grant', 'income'];

function zapView(r: {
	zapPubkey: string | null;
	zapVerified: boolean | null;
	zapContent: string | null;
}) {
	return r.zapPubkey
		? { npub: npub(r.zapPubkey), verified: r.zapVerified === true, content: r.zapContent }
		: null;
}

export const load: PageServerLoad = async () => {
	const st = lightningConfigState();
	if (st.state === 'off') error(404, 'Lightning is not configured');
	if (st.state === 'invalid') redirect(303, '/lightning');
	await syncLightning();

	const node = currentNode();
	const wallet = lightningWallet();
	const pending = await pendingPayments();
	const wallets = db
		.select()
		.from(schema.wallets)
		.all()
		.filter((w) => w.archivedAt == null && w.id !== wallet?.id)
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
		.map((w) => ({ id: w.id, name: w.name, kind: w.kind, layer: w.layer }));

	return {
		wallet,
		testnet: node != null && !node.mainnet,
		recordingAllowed: node == null || node.mainnet || dev,
		wallets,
		pending: pending.map(({ row, suggestion, inrMinor, candidates }) => ({
			key: row.key,
			direction: row.direction,
			subType: row.subType,
			completedAt: row.completedAt,
			paymentHash: row.paymentHash,
			txId: row.txId,
			comment: row.comment,
			memo: row.memo,
			description: row.description ?? row.payerNote,
			zap: zapView(row),
			inrMinor,
			candidates,
			...suggestion
		})),
		ignored: ignoredPayments().map((r) => ({
			key: r.key,
			direction: r.direction,
			subType: r.subType,
			completedAt: r.completedAt,
			amountSat: r.amountSat,
			note: r.comment ?? r.zapContent ?? r.description
		}))
	};
};

const str = (f: FormData, k: string) => {
	const v = f.get(k);
	return typeof v === 'string' ? v : '';
};
const intOrNull = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);

export const actions: Actions = {
	record: async ({ request }) => {
		const f = await request.formData();
		const key = str(f, 'key');
		const action = str(f, 'action');
		if (action !== 'income' && action !== 'transfer' && action !== 'spend')
			return fail(400, { key, error: 'choose what this payment was' });
		const kind = str(f, 'kind') as IncomeKind;
		const decision: Decision = {
			action,
			kind: KINDS.includes(kind) ? kind : undefined,
			counterparty: str(f, 'counterparty'),
			note: str(f, 'note'),
			otherWalletId: intOrNull(str(f, 'otherWalletId')),
			senderFeeSats:
				str(f, 'senderFeeSats').trim() === ''
					? 0
					: (intOrNull(str(f, 'senderFeeSats').replace(/[\s,]/g, '')) ?? -1)
		};
		const res = await recordPayment(key, decision, { allowTestnet: dev });
		if (!res.ok) return fail(400, { key, error: res.error });
		return { recorded: res.id };
	},

	link: async ({ request }) => {
		const f = await request.formData();
		const key = str(f, 'key');
		const txId = intOrNull(str(f, 'txId'));
		if (txId == null) return fail(400, { key, error: 'choose the ledger row' });
		const res = linkPayment(key, txId);
		if (!res.ok) return fail(400, { key, error: res.error });
		return { linked: txId };
	},

	ignore: async ({ request }) => {
		const keys = (await request.formData()).getAll('key').filter((k) => typeof k === 'string');
		return { ignored: setIgnored(keys as string[], true) };
	},

	restore: async ({ request }) => {
		const keys = (await request.formData()).getAll('key').filter((k) => typeof k === 'string');
		return { restored: setIgnored(keys as string[], false) };
	},

	donations: async ({ request }) => {
		const keys = (await request.formData()).getAll('key').filter((k) => typeof k === 'string');
		const errors: string[] = [];
		let recorded = 0;
		for (const key of keys as string[]) {
			const res = await recordAsSuggested(key, 'donation', { allowTestnet: dev });
			if (res.ok) recorded++;
			else errors.push(res.error);
		}
		if (errors.length > 0)
			return fail(400, {
				bulkError: `${recorded} recorded; ${errors.length} refused: ${errors[0]}`
			});
		return { recordedMany: recorded };
	},

	ignoreBefore: async ({ request }) => {
		const date = str(await request.formData(), 'date');
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, { bulkError: 'pick a date' });
		return { ignored: ignoreBefore(istInputToUtcSec(`${date}T00:00`)) };
	}
};
