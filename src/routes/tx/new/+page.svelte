<script lang="ts">
	import TxForm from '$lib/components/tx-form/TxForm.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>new entry · satbook</title></svelte:head>

<div class="mx-auto max-w-2xl">
	<h1 class="label-caps">new entry</h1>
	<TxForm mode="create" wallets={data.wallets} live={data.live} {form} />
</div>
