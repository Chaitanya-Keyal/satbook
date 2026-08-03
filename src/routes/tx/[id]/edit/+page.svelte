<script lang="ts">
	import TxForm from '$lib/components/tx-form/TxForm.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>edit entry #{data.tx.id} · satbook</title></svelte:head>

<div class="mx-auto max-w-2xl">
	<h1 class="label-caps">edit entry #{data.tx.id}</h1>
	{#key data.tx.id}
		<TxForm mode="edit" tx={data.tx} wallets={data.wallets} live={data.live} {form} />
	{/key}
</div>
