// Entry-form triad state machine (spec §3.2): two most-recently-edited fields
// are manual, the third derives; prefilled rate acts as a known value until
// touched or displaced.
import { describe, expect, test } from 'bun:test';
import {
	clearAmounts,
	derivedField,
	editField,
	formatFiatMinor,
	formatRateValue,
	initialTriad,
	parseBtcText,
	parseFiatText,
	parseRateText,
	parseSatsText,
	rateEdited,
	setPrefilledRate,
	type TriadState
} from '../src/lib/components/tx-form/triad';

const THIN = ' ';

describe('triad state machine', () => {
	test('initial state derives nothing', () => {
		const s = initialTriad();
		expect(derivedField(s)).toBeNull();
		expect(s.sats).toBeNull();
	});

	test('prefilled rate + typed BTC derives fiat with paise rounding', () => {
		const s = initialTriad();
		setPrefilledRate(s, 5_000_000); // ₹50,00,000 / BTC
		expect(s.ratePrefilled).toBe(true);
		editField(s, 'btc', 1_000_000); // 0.01 BTC
		expect(derivedField(s)).toBe('fiat');
		expect(s.fiatMinor).toBe(5_000_000); // ₹50,000.00
	});

	test('typed fiat + typed rate derives sats', () => {
		const s = initialTriad();
		editField(s, 'fiat', 12_000_000); // ₹1,20,000
		editField(s, 'rate', 6_000_000);
		expect(derivedField(s)).toBe('btc');
		expect(s.sats).toBe(2_000_000); // 0.02 BTC
	});

	test('derived sats rounds half-up', () => {
		const s = initialTriad();
		editField(s, 'fiat', 100); // ₹1.00
		editField(s, 'rate', 3);
		expect(s.sats).toBe(33_333_333);
	});

	test('typing into the derived field promotes it and demotes the oldest', () => {
		const s = initialTriad();
		editField(s, 'btc', 1_000_000);
		editField(s, 'fiat', 5_000_000);
		expect(derivedField(s)).toBe('rate');
		expect(s.rate).toBe(5_000_000);
		// now type into the derived rate → btc becomes derived
		editField(s, 'rate', 10_000_000);
		expect(s.manual).toEqual(['fiat', 'rate']);
		expect(derivedField(s)).toBe('btc');
		expect(s.sats).toBe(500_000);
	});

	test('re-editing a manual field only refreshes recency', () => {
		const s = initialTriad();
		editField(s, 'btc', 1_000_000);
		editField(s, 'fiat', 5_000_000);
		editField(s, 'btc', 2_000_000);
		expect(s.manual).toEqual(['fiat', 'btc']);
		expect(derivedField(s)).toBe('rate');
		expect(s.rate).toBe(2_500_000);
	});

	test('prefill is ignored once the rate is manual or derived', () => {
		const a = initialTriad();
		editField(a, 'rate', 100);
		setPrefilledRate(a, 200);
		expect(a.rate).toBe(100);
		expect(rateEdited(a)).toBe(true);

		const b = initialTriad();
		editField(b, 'btc', 1_000_000);
		editField(b, 'fiat', 5_000_000);
		const computed = b.rate;
		setPrefilledRate(b, 999);
		expect(b.rate).toBe(computed);
	});

	test('prefill null clears an untouched stale prefill', () => {
		const s = initialTriad();
		setPrefilledRate(s, 5_000_000);
		setPrefilledRate(s, null);
		expect(s.rate).toBeNull();
		expect(s.ratePrefilled).toBe(false);
	});

	test('backdated re-prefill recomputes the derived fiat', () => {
		const s = initialTriad();
		setPrefilledRate(s, 5_000_000);
		editField(s, 'btc', 1_000_000);
		setPrefilledRate(s, 2_400_000); // historical rate arrives
		expect(s.fiatMinor).toBe(2_400_000);
	});

	test('clearAmounts keeps the rate and its prefill provenance', () => {
		const s = initialTriad();
		setPrefilledRate(s, 5_000_000);
		editField(s, 'btc', 1_000_000);
		clearAmounts(s);
		expect(s.sats).toBeNull();
		expect(s.fiatMinor).toBeNull();
		expect(s.rate).toBe(5_000_000);
		expect(s.ratePrefilled).toBe(true);
		expect(s.manual).toEqual([]);
	});

	test('clearing a manual field nulls the derived member', () => {
		const s = initialTriad();
		editField(s, 'fiat', 12_000_000);
		editField(s, 'rate', 6_000_000);
		editField(s, 'fiat', null);
		expect(s.sats).toBeNull();
	});
});

describe('triad parsing', () => {
	test('parseSatsText tolerates grouping', () => {
		expect(parseSatsText(`1${THIN}921${THIN}337`)).toBe(1_921_337);
		expect(parseSatsText('1,921,337')).toBe(1_921_337);
		expect(parseSatsText('12x')).toBeNull();
		expect(parseSatsText('')).toBeNull();
	});

	test('parseBtcText handles grouped and partial decimals', () => {
		expect(parseBtcText(`0.019${THIN}213${THIN}37`)).toBe(1_921_337);
		expect(parseBtcText('0.5')).toBe(50_000_000);
		expect(parseBtcText('1.')).toBe(100_000_000);
		expect(parseBtcText('.5')).toBe(50_000_000);
		expect(parseBtcText('')).toBeNull();
		expect(parseBtcText('0.123456789')).toBeNull(); // >8 dp
	});

	test('parseRateText / parseFiatText', () => {
		expect(parseRateText('51,23,456')).toBe(5_123_456);
		expect(parseRateText('0')).toBeNull();
		expect(parseFiatText('1,20,000.50')).toBe(12_000_050);
		expect(parseFiatText('1.2L')).toBeNull(); // shorthand handled on blur only
	});
});

describe('triad display', () => {
	test('formatFiatMinor groups per currency and hides zero cents', () => {
		expect(formatFiatMinor(12_000_000, 'INR')).toBe('1,20,000');
		expect(formatFiatMinor(12_000_050, 'INR')).toBe('1,20,000.50');
		expect(formatFiatMinor(123_456_789, 'USD')).toBe('1,234,567.89');
		expect(formatFiatMinor(-5000, 'INR')).toBe('−50');
	});

	test('formatRateValue: 0dp for whole rates, 2dp otherwise', () => {
		expect(formatRateValue(5_123_456, 'INR')).toBe('51,23,456');
		expect(formatRateValue(61_240.5, 'USD')).toBe('61,240.50');
		expect(formatRateValue(5_123_456.4, 'INR')).toBe('51,23,456.40');
	});
});

// Guard: a TriadState round-trips through JSON (used by save & add another).
test('state is plain data', () => {
	const s: TriadState = initialTriad();
	editField(s, 'btc', 1);
	expect(JSON.parse(JSON.stringify(s))).toEqual(s);
});
