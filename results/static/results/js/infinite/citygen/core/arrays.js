// arrays.js — the subset of com.watabou.utils.ArrayExtender used by the pipeline,
// as free functions. (Native Array.every/some/filter/map are used directly elsewhere.)
//
// All comparisons rely on reference equality (===), matching Haxe's Array.indexOf /
// remove on object instances — see the "Point identity" note in the plan.

import { Random } from './Random.js';

// Remove first occurrence of `x`; returns true if something was removed (Haxe Array.remove).
export function remove(arr, x) {
	const i = arr.indexOf(x);
	if (i === -1) return false;
	arr.splice(i, 1);
	return true;
}

export function last(arr) {
	return arr[arr.length - 1];
}

export function contains(arr, x) {
	return arr.indexOf(x) !== -1;
}

// element with the minimum f(element)
export function amin(arr, f) {
	let result = arr[0];
	let min = f(result);
	for (let i = 1; i < arr.length; i++) {
		const el = arr[i];
		const m = f(el);
		if (m < min) {
			result = el;
			min = m;
		}
	}
	return result;
}

// element with the maximum f(element)
export function amax(arr, f) {
	let result = arr[0];
	let max = f(result);
	for (let i = 1; i < arr.length; i++) {
		const el = arr[i];
		const m = f(el);
		if (m > max) {
			result = el;
			max = m;
		}
	}
	return result;
}

export function count(arr, test) {
	let c = 0;
	for (const e of arr) if (test(e)) c++;
	return c;
}

// [el of a if el not in b]
export function difference(a, b) {
	return a.filter((el) => b.indexOf(el) === -1);
}

// push only if not already present (Haxe ArrayExtender.add)
export function addUnique(arr, el) {
	if (arr.indexOf(el) === -1) arr.push(el);
}

// replace `el` with the elements of `newEls`, in place (Haxe ArrayExtender.replace)
export function replace(arr, el, newEls) {
	let index = arr.indexOf(el);
	arr[index++] = newEls[0];
	for (let i = 1; i < newEls.length; i++) arr.splice(index++, 0, newEls[i]);
}

export function random(arr) {
	return arr[Math.trunc(Random.float() * arr.length)];
}

// Haxe ArrayExtender.shuffle — order depends on Random, kept for fidelity
export function shuffle(arr) {
	const result = [];
	for (const e of arr) result.splice(Math.trunc(Random.float() * (result.length + 1)), 0, e);
	return result;
}
