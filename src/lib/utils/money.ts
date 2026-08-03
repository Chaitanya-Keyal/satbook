// Integer money math + canonical formatting. All arithmetic on satoshis and
// minor units (paise/cents) stays in integers; pro-ration goes through BigInt
// because paise×sats products overflow Number.MAX_SAFE_INTEGER near 1 BTC lots.

const THIN = '\u2009'; // thin space for sats/BTC digit grouping
const MINUS = '\u2212'; // true minus

export const SATS_PER_BTC = 100_000_000;

/**
 * round(a * b / c) for non-negative integers, exact via BigInt.
 * Rounds half up. Throws on negative inputs or c === 0.
 */
export function mulDivRound(a: number, b: number, c: number): number {
	if (a < 0 || b < 0 || c <= 0) throw new Error(`mulDivRound: bad inputs ${a}, ${b}, ${c}`);
	if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c))
		throw new Error(`mulDivRound: non-integer inputs ${a}, ${b}, ${c}`);
	const C = BigInt(c);
	return Number((BigInt(a) * BigInt(b) + C / 2n) / C);
}

/** '1234567' → '1 234 567' (thin spaces, groups of 3 from the right). */
function thinGroupFromRight(digits: string): string {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

/** '01921337' → '019 213 37' (groups of 3 left-to-right, used after the decimal point). */
function thinGroupFromLeft(digits: string): string {
	return digits.replace(/(\d{3})(?=\d)/g, `$1${THIN}`);
}

/** 1921337 → '1 921 337' (no unit word; caller appends ' sats'). */
export function formatSats(sats: number): string {
	const sign = sats < 0 ? MINUS : '';
	return sign + thinGroupFromRight(Math.abs(sats).toString());
}

/** 1921337 → '0.019 213 37' (8 dp, thin-space grouped from the decimal point). */
export function formatBtc(sats: number): string {
	const sign = sats < 0 ? MINUS : '';
	const abs = Math.abs(sats);
	const whole = Math.floor(abs / SATS_PER_BTC);
	const frac = (abs % SATS_PER_BTC).toString().padStart(8, '0');
	return `${sign}${thinGroupFromRight(whole.toString())}.${thinGroupFromLeft(frac)}`;
}

/** Indian digit grouping: '12345678' → '1,23,45,678'. */
export function indianGroup(digits: string): string {
	if (digits.length <= 3) return digits;
	const last3 = digits.slice(-3);
	const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
	return `${rest},${last3}`;
}

export interface InrFormatOptions {
	/** 'never' (default: rupees only, rounded), 'always', or 'nonzero'. */
	paise?: 'never' | 'always' | 'nonzero';
	/** Prefix ₹ (default true). */
	symbol?: boolean;
	/** Explicit '+' on positive values (default false). */
	explicitPlus?: boolean;
}

/** Paise → '₹12,34,56,789' with Indian grouping. */
export function formatInr(paiseValue: number, opts: InrFormatOptions = {}): string {
	const { paise = 'never', symbol = true, explicitPlus = false } = opts;
	const sign = paiseValue < 0 ? MINUS : explicitPlus && paiseValue > 0 ? '+' : '';
	const abs = Math.abs(paiseValue);
	const rupees = paise === 'never' ? Math.round(abs / 100) : Math.floor(abs / 100);
	const rem = abs % 100;
	let out = indianGroup(rupees.toString());
	if (paise === 'always' || (paise === 'nonzero' && rem !== 0))
		out += `.${rem.toString().padStart(2, '0')}`;
	return `${sign}${symbol ? '₹' : ''}${out}`;
}

/** Compact: ₹4.8L, ₹1.2Cr — only for tile sublines and chart axis ticks. */
export function formatInrCompact(paiseValue: number): string {
	const sign = paiseValue < 0 ? MINUS : '';
	const rupees = Math.abs(paiseValue) / 100;
	let out: string;
	if (rupees >= 1_00_00_000) out = `${trimTo3Sig(rupees / 1_00_00_000)}Cr`;
	else if (rupees >= 1_00_000) out = `${trimTo3Sig(rupees / 1_00_000)}L`;
	else if (rupees >= 1_000) out = `${trimTo3Sig(rupees / 1_000)}k`;
	else out = Math.round(rupees).toString();
	return `${sign}₹${out}`;
}

function trimTo3Sig(n: number): string {
	const s = n >= 100 ? Math.round(n).toString() : n.toPrecision(3);
	return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** ₹/BTC rate (whole rupees, Indian grouping): 5123456 → '₹51,23,456'. */
export function formatRateInr(inrPerBtc: number): string {
	return `₹${indianGroup(Math.round(inrPerBtc).toString())}`;
}

/**
 * Fiat shorthand on blur: '1.2L' → 120000, '5k' → 5000, plain numbers pass
 * through (commas/spaces tolerated). Returns the value in MAJOR units, or null.
 */
export function parseFiatShorthand(input: string): number | null {
	const cleaned = input.trim().replace(/[,\s ]/g, '');
	const m = /^(\d+(?:\.\d+)?)(k|K|l|L|cr|Cr|CR)?$/.exec(cleaned);
	if (!m) return null;
	const n = parseFloat(m[1]);
	const suffix = (m[2] ?? '').toLowerCase();
	const mult =
		suffix === 'k' ? 1_000 : suffix === 'l' ? 1_00_000 : suffix === 'cr' ? 1_00_00_000 : 1;
	return n * mult;
}

/** Major-unit fiat number → integer minor units, guarding float error (119.999… → 12000). */
export function toMinor(major: number): number {
	return Math.round(major * 100);
}

/** BTC decimal string → integer sats (throws on >8 dp). */
export function btcToSats(btc: string | number): number {
	const s = typeof btc === 'number' ? btc.toFixed(8) : btc.trim();
	const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
	if (!m) throw new Error(`btcToSats: cannot parse '${btc}'`);
	return parseInt(m[1], 10) * SATS_PER_BTC + parseInt((m[2] ?? '').padEnd(8, '0') || '0', 10);
}
