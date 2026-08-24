<script lang="ts">
	// One control, two renderings: a native <select> on touch devices (the OS
	// picker beats anything we can draw, and it is what SSR emits so the control
	// works before hydration) and a custom listbox on pointer-fine devices, where
	// the browser's white popup clashed with everything around it.
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	export interface SelectOption {
		value: string;
		label: string;
	}

	let {
		value,
		options,
		onchange,
		onblur,
		name = undefined,
		id = undefined,
		ariaLabel = undefined,
		placeholder = '—',
		triggerClass = '',
		align = 'left'
	}: {
		value: string;
		options: SelectOption[];
		onchange: (value: string) => void;
		onblur?: () => void;
		name?: string;
		id?: string;
		ariaLabel?: string;
		placeholder?: string;
		triggerClass?: string;
		align?: 'left' | 'right';
	} = $props();

	let custom = $state(false);
	$effect(() => {
		const mq = window.matchMedia('(pointer: fine)');
		custom = mq.matches;
		const sync = () => (custom = mq.matches);
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	let open = $state(false);
	let activeIndex = $state(-1);
	let trigger = $state<HTMLButtonElement | null>(null);
	let panel = $state<HTMLDivElement | null>(null);

	const selected = $derived(options.find((o) => o.value === value) ?? null);
	const shown = $derived(selected?.label ?? placeholder);
	const listId = $derived(id ? `${id}-listbox` : undefined);

	function openList() {
		activeIndex = Math.max(
			0,
			options.findIndex((o) => o.value === value)
		);
		open = true;
	}

	function close(focusTrigger = true) {
		if (!open) return;
		open = false;
		if (focusTrigger) trigger?.focus();
	}

	function pick(index: number) {
		const opt = options[index];
		if (!opt) return;
		if (opt.value !== value) onchange(opt.value);
		close();
	}

	function onTriggerKeydown(e: KeyboardEvent) {
		if (!open) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openList();
			}
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % options.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = (activeIndex - 1 + options.length) % options.length;
		} else if (e.key === 'Home') {
			e.preventDefault();
			activeIndex = 0;
		} else if (e.key === 'End') {
			e.preventDefault();
			activeIndex = options.length - 1;
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			pick(activeIndex);
		} else if (e.key === 'Tab') {
			close(false);
		} else if (e.key.length === 1) {
			// type-ahead, same as a native select
			const from = activeIndex + 1;
			const hit = options.findIndex(
				(o, i) => i >= from && o.label.toLowerCase().startsWith(e.key.toLowerCase())
			);
			const wrapped =
				hit >= 0
					? hit
					: options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
			if (wrapped >= 0) activeIndex = wrapped;
		}
	}

	// Keep the active option in view while arrowing through a long list.
	$effect(() => {
		if (!open || !panel) return;
		panel.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({
			block: 'nearest'
		});
	});

	$effect(() => {
		if (!open) return;
		const onDocPointer = (e: PointerEvent) => {
			const t = e.target as Node;
			if (!trigger?.contains(t) && !panel?.contains(t)) close(false);
		};
		document.addEventListener('pointerdown', onDocPointer);
		return () => document.removeEventListener('pointerdown', onDocPointer);
	});
</script>

<!-- data-select marks the subtree so global hotkeys stay out of it -->
<div class="relative" data-select>
	{#if custom}
		{#if name}<input type="hidden" {name} {value} />{/if}
		<button
			bind:this={trigger}
			{id}
			type="button"
			role="combobox"
			aria-haspopup="listbox"
			aria-expanded={open}
			aria-controls={listId}
			aria-label={ariaLabel}
			class="{triggerClass} relative w-full cursor-pointer text-left"
			onclick={() => (open ? close() : openList())}
			onkeydown={onTriggerKeydown}
			onblur={() => {
				if (!open) onblur?.();
			}}
		>
			<span class="block truncate pr-5">{shown}</span>
			<ChevronDown
				size={14}
				strokeWidth={2}
				class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted"
				aria-hidden="true"
			/>
		</button>

		{#if open}
			<div
				bind:this={panel}
				id={listId}
				role="listbox"
				aria-label={ariaLabel}
				tabindex="-1"
				class="absolute z-50 mt-1 max-h-64 min-w-full overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg shadow-black/40 {align ===
				'right'
					? 'right-0'
					: 'left-0'}"
			>
				{#each options as opt, i (opt.value)}
					{@const isSelected = opt.value === value}
					<div
						role="option"
						aria-selected={isSelected}
						data-index={i}
						tabindex="-1"
						class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px] whitespace-nowrap transition-colors duration-75 {i ===
						activeIndex
							? 'bg-surface-2 text-text'
							: 'text-muted'}"
						onpointerenter={() => (activeIndex = i)}
						onclick={() => pick(i)}
						onkeydown={() => {}}
					>
						<Check
							size={12}
							strokeWidth={2}
							class="shrink-0 {isSelected ? 'text-accent' : 'invisible'}"
							aria-hidden="true"
						/>
						<span class="truncate">{opt.label}</span>
					</div>
				{/each}
			</div>
		{/if}
	{:else}
		<select
			{id}
			{name}
			{value}
			aria-label={ariaLabel}
			class="select-field {triggerClass} w-full"
			onchange={(e) => onchange(e.currentTarget.value)}
			onblur={() => onblur?.()}
		>
			{#if selected == null}<option value="" disabled selected>{placeholder}</option>{/if}
			{#each options as opt (opt.value)}
				<option value={opt.value}>{opt.label}</option>
			{/each}
		</select>
	{/if}
</div>
