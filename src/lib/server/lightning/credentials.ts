// satbook must hold only credentials that read and receive: phoenixd's
// limited-access password and an LNbits invoice key. A full password or an
// admin key would work just as well for reading, silently, while turning a
// satbook leak into a spending one. So the node is asked which kind satbook
// holds, once per process (again while the answer is unknown), and the
// module refuses to run with the wrong kind.

import { type ConfigState, type LightningConfig, lightningConfigState } from './config';
import { lnbitsFor } from './lnbits';
import { phoenixd } from './phoenixd';

/** While the node cannot say, ask again after this long. */
const RECHECK_UNKNOWN_SEC = 600;

const checks = new Map<string, { at: number; problem: string | null; settled: boolean }>();
const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

/** Why satbook must not use these credentials, or null. */
export async function credentialProblem(cfg: LightningConfig): Promise<string | null> {
  const id = sha256(
    [cfg.phoenixdUrl, cfg.phoenixdPassword, cfg.lnbitsUrl ?? '', cfg.lnbitsInvoiceKey ?? ''].join(
      '\n'
    )
  );
  const seen = checks.get(id);
  if (seen && (seen.settled || nowSec() - seen.at < RECHECK_UNKNOWN_SEC)) return seen.problem;

  const lb = lnbitsFor(cfg);
  const [scope, keyType] = await Promise.all([
    phoenixd(cfg).passwordScope(),
    lb ? lb.keyType() : Promise.resolve(null)
  ]);
  const problem =
    scope === 'full'
      ? "PHOENIXD_PASSWORD is phoenixd's full-access password, which can spend. Give satbook http-password-limited-access from phoenix.conf instead"
      : keyType === 'admin'
        ? 'LNBITS_INVOICE_KEY is an LNbits admin key, which can spend. Give satbook the wallet’s invoice/read key instead'
        : null;
  const settled = problem != null || (scope !== 'unknown' && keyType !== 'unknown');
  checks.set(id, { at: nowSec(), problem, settled });
  return problem;
}

/** The module's state, refusing credentials that could spend. */
export async function lightningState(): Promise<ConfigState> {
  const st = lightningConfigState();
  if (st.state !== 'on') return st;
  const problem = await credentialProblem(st.config);
  return problem ? { state: 'invalid', problem } : st;
}
