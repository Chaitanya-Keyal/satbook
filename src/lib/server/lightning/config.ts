// The optional Lightning module: satbook reads a phoenixd node (and, when it
// fronts the node, LNbits) and never spends from it. Off unless PHOENIXD_URL is
// set. Secrets are read here, per call, and never leave the server.

import { readFileSync } from 'node:fs';
import { parseNostrPubkey } from './zap';

export interface LightningConfig {
  /** phoenixd's HTTP API, no trailing slash. */
  phoenixdUrl: string;
  /** Use phoenixd's limited-access password: it cannot pay or send. */
  phoenixdPassword: string;
  lnbitsUrl: string | null;
  /** An LNbits invoice/read key for the wallet behind the Lightning Address. */
  lnbitsInvoiceKey: string | null;
  /** HTTP proxy for Lightning calls only, e.g. a userspace Tailscale sidecar's. */
  proxy: string | null;
  /** Shown, with a QR code, on the dashboard. */
  lightningAddress: string | null;
  /** Your nostr pubkey (hex): a zap's sender is verified only if the zap is addressed to it. */
  zapRecipient: string | null;
}

export type ConfigState =
  | { state: 'off' }
  | { state: 'invalid'; problem: string }
  | { state: 'on'; config: LightningConfig };

/** `NAME_FILE` (a mounted secret) wins over `NAME`. */
function secret(name: string): string | null {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  return process.env[name]?.trim() || null;
}

function httpUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function lightningConfigState(): ConfigState {
  if (!process.env.PHOENIXD_URL?.trim()) return { state: 'off' };
  const phoenixdUrl = httpUrl(process.env.PHOENIXD_URL);
  if (!phoenixdUrl) return { state: 'invalid', problem: 'PHOENIXD_URL is not an http(s) URL' };
  const phoenixdPassword = secret('PHOENIXD_PASSWORD');
  if (!phoenixdPassword)
    return {
      state: 'invalid',
      problem: 'PHOENIXD_PASSWORD (or PHOENIXD_PASSWORD_FILE) is not set'
    };

  const lnbitsRaw = process.env.LNBITS_URL?.trim();
  const lnbitsUrl = lnbitsRaw ? httpUrl(lnbitsRaw) : null;
  if (lnbitsRaw && !lnbitsUrl)
    return { state: 'invalid', problem: 'LNBITS_URL is not an http(s) URL' };
  const lnbitsInvoiceKey = lnbitsUrl ? secret('LNBITS_INVOICE_KEY') : null;
  if (lnbitsUrl && !lnbitsInvoiceKey)
    return { state: 'invalid', problem: 'LNBITS_URL is set but LNBITS_INVOICE_KEY is not' };

  const proxyRaw = process.env.LIGHTNING_PROXY?.trim();
  const proxy = proxyRaw ? httpUrl(proxyRaw) : null;
  if (proxyRaw && !proxy)
    return { state: 'invalid', problem: 'LIGHTNING_PROXY is not an http(s) URL' };

  const address = process.env.LIGHTNING_ADDRESS?.trim() || null;
  if (address && !/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address))
    return { state: 'invalid', problem: 'LIGHTNING_ADDRESS is not of the form name@domain' };

  const nostrRaw = process.env.NOSTR_PUBKEY?.trim();
  const zapRecipient = nostrRaw ? parseNostrPubkey(nostrRaw) : null;
  if (nostrRaw && !zapRecipient)
    return { state: 'invalid', problem: 'NOSTR_PUBKEY is not an npub or a 64-character hex key' };

  return {
    state: 'on',
    config: {
      phoenixdUrl,
      phoenixdPassword,
      lnbitsUrl,
      lnbitsInvoiceKey,
      proxy,
      lightningAddress: address,
      zapRecipient
    }
  };
}

export function lightningConfig(): LightningConfig | null {
  const s = lightningConfigState();
  return s.state === 'on' ? s.config : null;
}

/** For display: scheme, host and port only — never credentials or paths. */
export function displayOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
