<script lang="ts" module>
  export type Action = 'income' | 'transfer' | 'spend';
  export interface ReviewItem {
    key: string;
    direction: 'in' | 'out';
    subType: string;
    completedAt: number;
    comment: string | null;
    memo: string | null;
    description: string | null;
    zap: { npub: string; verified: boolean; content: string | null } | null;
    inrMinor: number | null;
    candidates: {
      id: number;
      type: string;
      ts: number;
      amountSats: number;
      notes: string | null;
    }[];
    actions: Action[];
    action: Action | null;
    kind: 'donation' | 'grant' | 'income';
    counterparty: string;
    note: string;
    figures: { amountSats: number; feeSats: number; creditedSats: number; certain: boolean };
    manualReason: string | null;
  }
</script>

<script lang="ts">
  // One payment up for review: what it was, and the form that records it,
  // links it to a row entered by hand, or ignores it. Amounts are shown, never
  // posted — the server derives them from the stored payment.
  import { enhance } from '$app/forms';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Select from '$lib/components/Select.svelte';
  import { unit } from '$lib/stores/unit.svelte';
  import { formatAmount, INCOME_KIND_LABEL } from '$lib/utils/display';
  import { paymentLabel, shortNpub } from '$lib/utils/lightning';
  import { formatInr, formatSats } from '$lib/utils/money';
  import { formatIstDateShort, formatIstFull } from '$lib/utils/time';

  let {
    p,
    wallets,
    allowed,
    error = null,
    // No default: the page binds into a map whose keys start out undefined.
    selected = $bindable()
  }: {
    p: ReviewItem;
    wallets: { id: number; name: string; kind: string; layer: string }[];
    allowed: boolean;
    error?: string | null;
    selected?: boolean | undefined;
  } = $props();

  // svelte-ignore state_referenced_locally
  let action = $state<Action | null>(p.action);
  // svelte-ignore state_referenced_locally
  let kind = $state<string>(p.kind);
  // svelte-ignore state_referenced_locally
  let counterparty = $state(p.counterparty);
  // svelte-ignore state_referenced_locally
  let note = $state(p.note);
  // A sweep usually goes to cold storage; a top-up usually comes from a hot wallet.
  // svelte-ignore state_referenced_locally
  let otherWalletId = $state(
    String(
      (p.direction === 'out'
        ? wallets.find((w) => w.kind === 'cold')
        : wallets.find((w) => w.layer === 'lightning')
      )?.id ??
        wallets[0]?.id ??
        ''
    )
  );
  // svelte-ignore state_referenced_locally
  let linkTo = $state(String(p.candidates[0]?.id ?? ''));
  let busy = $state(false);

  const f = $derived(p.figures);
  const incoming = $derived(p.direction === 'in');
  const ACTION_LABEL: Record<Action, string> = {
    income: 'Income',
    transfer: 'Transfer',
    spend: 'Spend'
  };
  const inputCls =
    'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] transition-colors duration-100 placeholder:text-muted/70 hover:border-muted/60';
  const smallBtn =
    'rounded-md border border-border px-2.5 py-1 text-[11px] text-muted transition-colors duration-100 hover:text-text disabled:opacity-60';
  const submitting = () => {
    busy = true;
    return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false });
      busy = false;
    };
  };
</script>

<li class="rounded-md border border-border bg-surface p-4">
  <div class="flex items-start gap-3">
    {#if incoming && p.actions.includes('income')}
      <input
        type="checkbox"
        bind:checked={selected}
        aria-label="select this payment"
        class="mt-1 size-3.5 shrink-0 accent-accent"
      />
    {/if}
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p class="text-[13px]">
          {paymentLabel(p.direction, p.subType)}
          <span class="num text-[11px] text-muted" title={formatIstFull(p.completedAt)}>
            · {formatIstDateShort(p.completedAt)}
          </span>
        </p>
        <p class="num text-[13px] {incoming ? 'text-gain' : 'text-loss'}">
          {incoming ? '+' : '−'}{formatAmount(f.amountSats, unit.value)}
        </p>
      </div>

      <p class="mt-1 text-xs break-words">
        {#if p.zap}
          <span
            title={p.zap.verified
              ? 'Zap request signature verified'
              : 'Unverified: anyone can claim a sender'}
          >
            {#if p.zap.verified}<ShieldCheck
                size={11}
                class="mr-0.5 inline-block align-[-1px] text-gain"
                aria-label="verified"
              />{/if}zap from
            <span class="num">{shortNpub(p.zap.npub)}</span>{#if !p.zap.verified}<span
                class="ml-1 text-muted">(unverified)</span
              >{/if}</span
          >{#if p.zap.content}<span class="mx-1.5 text-muted">·</span>“{p.zap.content}”{/if}
        {:else if p.comment}
          “{p.comment}”
        {:else if p.description}
          {p.description}
        {:else if p.memo}
          <span class="text-muted">{p.memo}</span>
        {:else}
          <span class="text-muted">no description</span>
        {/if}
      </p>

      <p class="mt-1 num text-[11px] text-muted">
        {#if incoming && f.feeSats > 0}
          payer sent {formatSats(f.amountSats)} · node kept {formatSats(f.feeSats)} for inbound liquidity
          · wallet {f.creditedSats >= 0 ? '+' : '−'}{formatSats(Math.abs(f.creditedSats))}
          {#if !f.certain}· <span class="text-loss">no invoice amount; check the figures</span>{/if}
        {:else if !incoming && f.feeSats > 0}
          {formatSats(f.amountSats)} + {formatSats(f.feeSats)} fee
        {/if}
        {#if p.inrMinor != null && action !== 'transfer'}
          {#if f.feeSats > 0}·{/if} ≈ {formatInr(p.inrMinor)} at the time
        {/if}
      </p>

      {#if p.manualReason}
        <p class="mt-3 text-xs text-muted">Can't be recorded here: {p.manualReason}.</p>
      {:else}
        <form method="POST" action="?/record" use:enhance={submitting} class="mt-3 space-y-2.5">
          <input type="hidden" name="key" value={p.key} />
          <input type="hidden" name="action" value={action ?? ''} />
          <div
            class="inline-flex rounded-md border border-border p-0.5"
            role="group"
            aria-label="record as"
          >
            {#each p.actions as a (a)}
              <button
                type="button"
                aria-pressed={action === a}
                onclick={() => (action = a)}
                class="rounded-[4px] px-2.5 py-0.5 text-[11px] transition-colors duration-100 {action ===
                a
                  ? 'bg-surface-2 text-text'
                  : 'text-muted hover:text-text'}"
              >
                {ACTION_LABEL[a]}
              </button>
            {/each}
          </div>

          {#if action === 'income'}
            <div class="grid gap-2 sm:grid-cols-3">
              <Select
                name="kind"
                ariaLabel="kind of income"
                value={kind}
                options={(['donation', 'grant', 'income'] as const).map((k) => ({
                  value: k,
                  label: INCOME_KIND_LABEL[k]
                }))}
                onchange={(v) => (kind = v)}
                triggerClass="w-full rounded-md border border-border bg-bg py-1.5 pr-7 pl-2.5 text-[13px] transition-colors duration-100 hover:border-muted/60"
              />
              <input
                name="counterparty"
                bind:value={counterparty}
                maxlength="100"
                placeholder="From (optional)"
                aria-label="from"
                class={inputCls}
              />
              <input
                name="note"
                bind:value={note}
                maxlength="500"
                placeholder="Note (optional)"
                aria-label="note"
                class={inputCls}
              />
            </div>
          {:else if action === 'transfer'}
            <div class="grid gap-2 sm:grid-cols-3">
              <Select
                name="otherWalletId"
                ariaLabel={incoming ? 'from wallet' : 'to wallet'}
                value={otherWalletId}
                options={wallets.map((w) => ({
                  value: String(w.id),
                  label: `${incoming ? 'From' : 'To'} ${w.name}`
                }))}
                onchange={(v) => (otherWalletId = v)}
                triggerClass="w-full rounded-md border border-border bg-bg py-1.5 pr-7 pl-2.5 text-[13px] transition-colors duration-100 hover:border-muted/60"
              />
              {#if incoming}
                <input
                  name="senderFeeSats"
                  inputmode="numeric"
                  placeholder="Sending wallet's fee, sats"
                  aria-label="sending wallet's fee in sats"
                  class="{inputCls} num"
                />
              {/if}
              <input
                name="note"
                bind:value={note}
                maxlength="500"
                placeholder="Note (optional)"
                aria-label="note"
                class={inputCls}
              />
            </div>
            <p class="text-[11px] text-muted">
              {#if incoming}
                Your own sats: credited {formatSats(f.creditedSats)}{f.feeSats > 0
                  ? `, fee ${formatSats(f.feeSats)} plus whatever the sending wallet charged`
                  : ''}. Not income, not taxed.
              {:else}
                To another wallet of yours: not a disposal, not taxed.
              {/if}
            </p>
          {:else if action === 'spend'}
            <div class="grid gap-2 sm:grid-cols-2">
              <input
                name="counterparty"
                bind:value={counterparty}
                maxlength="100"
                placeholder="Paid to (optional)"
                aria-label="paid to"
                class={inputCls}
              />
              <input
                name="note"
                bind:value={note}
                maxlength="500"
                placeholder="Note (optional)"
                aria-label="note"
                class={inputCls}
              />
            </div>
            <p class="text-[11px] text-muted">Paying with sats is a disposal, taxed like a sale.</p>
          {/if}

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || !allowed || action == null}
              class="rounded-md bg-accent px-3 py-1 text-[11px] font-medium text-bg transition-opacity duration-100 hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record'}
            </button>
            <button type="submit" formaction="?/ignore" disabled={busy} class={smallBtn}
              >Ignore</button
            >
          </div>
        </form>
      {/if}

      {#if p.candidates.length > 0}
        <form
          method="POST"
          action="?/link"
          use:enhance={submitting}
          class="mt-2 flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="key" value={p.key} />
          <span class="text-[11px] text-muted">Already entered by hand?</span>
          <div class="min-w-48">
            <Select
              name="txId"
              ariaLabel="ledger row"
              value={linkTo}
              options={p.candidates.map((c) => ({
                value: String(c.id),
                label: `#${c.id} · ${c.type} · ${formatSats(c.amountSats)} sats · ${formatIstDateShort(c.ts)}`
              }))}
              onchange={(v) => (linkTo = v)}
              triggerClass="w-full rounded-md border border-border bg-bg py-1 pr-7 pl-2.5 text-[11px] transition-colors duration-100 hover:border-muted/60"
            />
          </div>
          <button type="submit" disabled={busy} class={smallBtn}>Link</button>
        </form>
      {/if}

      {#if p.manualReason}
        <form method="POST" action="?/ignore" use:enhance={submitting} class="mt-2">
          <input type="hidden" name="key" value={p.key} />
          <button type="submit" disabled={busy} class={smallBtn}>Ignore</button>
        </form>
      {/if}

      {#if error}
        <p role="alert" class="mt-2 text-xs text-loss">{error}</p>
      {/if}
    </div>
  </div>
</li>
