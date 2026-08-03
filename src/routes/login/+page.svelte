<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head><title>satbook</title></svelte:head>

<main class="flex min-h-svh flex-col items-center justify-center px-4">
	<h1 class="num text-lg font-medium tracking-wide">satbook</h1>
	<form
		method="POST"
		class="mt-8 w-full max-w-[280px]"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
	>
		<label class="label-caps" for="password">password</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="password"
			name="password"
			type="password"
			required
			autofocus
			autocomplete="current-password"
			class="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 num text-sm transition-colors duration-100 hover:border-muted/60"
		/>
		{#if form?.incorrect}
			<p role="alert" class="mt-2 text-xs text-loss">Incorrect password.</p>
		{/if}
		{#if form?.retryAfterSec}
			<p role="alert" class="mt-2 text-xs text-loss">
				Too many failed attempts. Try again in {Math.ceil(form.retryAfterSec / 60)} min.
			</p>
		{/if}
		<button
			type="submit"
			disabled={submitting}
			class="mt-4 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity duration-100 hover:opacity-90 disabled:opacity-60"
		>
			{submitting ? 'checking…' : 'unlock'}
		</button>
	</form>
</main>
