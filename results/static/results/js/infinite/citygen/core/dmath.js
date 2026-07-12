// dmath.js — engine-independent transcendental math for deterministic generation.
//
// The spec does NOT require Math.sin/cos/tan/atan2/acos/exp/pow/hypot to be
// correctly rounded, and implementations differ in the last ulp between engines
// (V8/SpiderMonkey use fdlibm ports; JavaScriptCore on Apple platforms uses
// Apple's libm). City generation feeds these results into hard threshold
// branches, so a 1-ulp difference can flip a branch, locally change a lot's
// shape AND desync the seeded Random draw count from that point on. Confirmed
// in the wild: ReportedInfinity #1 (seed 321144451, Safari/Mac) produced a
// locally different city than the same seed replayed on V8 — pinned to a single
// acos() call on a right-angle corner (acos(-2^-54): correctly rounded is
// 0x3FF921FB54442D18, fdlibm returns ...19).
//
// The functions below are faithful JS transcriptions of V8's fdlibm code
// (src/base/ieee754.cc, itself derived from Sun's fdlibm — SunSoft licence).
// They use only +, -, *, /, sqrt, floor and IEEE-754 bit manipulation, all of
// which ARE exactly specified by IEEE-754/ECMA-262, so every function returns
// bit-identical results on every engine. Each is fuzz-verified bit-identical
// to the corresponding Math.* on V8, so swapping them into the generator does
// not change existing Chrome/Node seed output.
//
// dhypot is sqrt(x*x + y*y) — NOT the multi-step Math.hypot algorithm. It is
// deterministic (single correctly-rounded sqrt over exact ops), faster than
// Math.hypot on V8, and safe for this codebase's coordinate ranges (|v| < 1e8:
// no overflow, and underflow only below 1e-154 which the generator never
// produces). It may differ from Math.hypot by 1 ulp — accepted, frozen here.

const _buf = new ArrayBuffer(8);
const _f64 = new Float64Array(_buf);
const _u32 = new Uint32Array(_buf);
// JS typed arrays use platform endianness; detect the word order once.
_f64[0] = 1;
const _HI = _u32[1] === 0x3ff00000 ? 1 : 0;
const _LO = 1 - _HI;

function _hi(x) { _f64[0] = x; return _u32[_HI] | 0; }
function _lo(x) { _f64[0] = x; return _u32[_LO]; }
function _fromWords(hi, lo) { _u32[_HI] = hi; _u32[_LO] = lo; return _f64[0]; }
function _setHi(x, hi) { _f64[0] = x; _u32[_HI] = hi; return _f64[0]; }
function _setLo(x, lo) { _f64[0] = x; _u32[_LO] = lo; return _f64[0]; }

// Exact scaling by 2^n (fdlibm scalbn semantics for the ranges used here).
function _scalbn(x, n) {
	if (x === 0 || !Number.isFinite(x)) return x;
	while (n > 1023) { x *= 8.98846567431158e307; n -= 1023; }
	while (n < -1022) { x *= 2.2250738585072014e-308; n += 1022; }
	if (n >= -1022) return x * _fromWords((1023 + n) << 20, 0);
	return x;
}

// ---------------------------------------------------------------- dhypot ----

export function dhypot(x, y) {
	return Math.sqrt(x * x + y * y);
}

// ----------------------------------------------------------------- dacos ----
// fdlibm e_acos.c

const _pi = 3.14159265358979311600e+00;
const _pio2_hi = 1.57079632679489655800e+00;
const _pio2_lo = 6.12323399573676603587e-17;
const _pS0 = 1.66666666666666657415e-01;
const _pS1 = -3.25565818622400915405e-01;
const _pS2 = 2.01212532134862925881e-01;
const _pS3 = -4.00555345006794114027e-02;
const _pS4 = 7.91534994289814532176e-04;
const _pS5 = 3.47933107596021167570e-05;
const _qS1 = -2.40339491173441421878e+00;
const _qS2 = 2.02094576023350569471e+00;
const _qS3 = -6.88283971605453293030e-01;
const _qS4 = 7.70381505559019352791e-02;

export function dacos(x) {
	const hx = _hi(x);
	const ix = hx & 0x7fffffff;
	if (ix >= 0x3ff00000) { // |x| >= 1
		if (((ix - 0x3ff00000) | _lo(x)) === 0) {
			if (hx > 0) return 0.0; // acos(1) = 0
			return _pi + 2.0 * _pio2_lo; // acos(-1) = pi
		}
		return (x - x) / (x - x); // NaN for |x| > 1
	}
	if (ix < 0x3fe00000) { // |x| < 0.5
		if (ix <= 0x3c600000) return _pio2_hi + _pio2_lo; // |x| < 2^-57
		const z = x * x;
		const p = z * (_pS0 + z * (_pS1 + z * (_pS2 + z * (_pS3 + z * (_pS4 + z * _pS5)))));
		const q = 1.0 + z * (_qS1 + z * (_qS2 + z * (_qS3 + z * _qS4)));
		const r = p / q;
		return _pio2_hi - (x - (_pio2_lo - x * r));
	}
	if (hx < 0) { // x < -0.5
		const z = (1.0 + x) * 0.5;
		const p = z * (_pS0 + z * (_pS1 + z * (_pS2 + z * (_pS3 + z * (_pS4 + z * _pS5)))));
		const q = 1.0 + z * (_qS1 + z * (_qS2 + z * (_qS3 + z * _qS4)));
		const s = Math.sqrt(z);
		const r = p / q;
		const w = r * s - _pio2_lo;
		return _pi - 2.0 * (s + w);
	}
	// x > 0.5
	const z = (1.0 - x) * 0.5;
	const s = Math.sqrt(z);
	const df = _setLo(s, 0);
	const c = (z - df * df) / (s + df);
	const p = z * (_pS0 + z * (_pS1 + z * (_pS2 + z * (_pS3 + z * (_pS4 + z * _pS5)))));
	const q = 1.0 + z * (_qS1 + z * (_qS2 + z * (_qS3 + z * _qS4)));
	const r = p / q;
	const w = r * s + c;
	return 2.0 * (df + w);
}

// ------------------------------------------------------ trig kernels ----
// fdlibm k_sin.c / k_cos.c / k_tan.c + e_rem_pio2.c / k_rem_pio2.c

const _S1 = -1.66666666666666324348e-01;
const _S2 = 8.33333333332248946124e-03;
const _S3 = -1.98412698298579493134e-04;
const _S4 = 2.75573137070700676789e-06;
const _S5 = -2.50507602534068634195e-08;
const _S6 = 1.58969099521155010221e-10;

function _kernelSin(x, y, iy) {
	const ix = _hi(x) & 0x7fffffff;
	if (ix < 0x3e400000) return x; // |x| < 2^-27
	const z = x * x;
	const v = z * x;
	const r = _S2 + z * (_S3 + z * (_S4 + z * (_S5 + z * _S6)));
	if (iy === 0) return x + v * (_S1 + z * r);
	return x - ((z * (0.5 * y - v * r) - y) - v * _S1);
}

const _C1 = 4.16666666666666019037e-02;
const _C2 = -1.38888888888741095749e-03;
const _C3 = 2.48015872894767294178e-05;
const _C4 = -2.75573143513906633035e-07;
const _C5 = 2.08757232129817482790e-09;
const _C6 = -1.13596475577881948265e-11;

function _kernelCos(x, y) {
	const ix = _hi(x) & 0x7fffffff;
	if (ix < 0x3e400000) return 1.0; // |x| < 2^-27
	const z = x * x;
	const r = z * (_C1 + z * (_C2 + z * (_C3 + z * (_C4 + z * (_C5 + z * _C6)))));
	if (ix < 0x3fd33333) { // |x| < 0.3
		return 1.0 - (0.5 * z - (z * r - x * y));
	}
	const qx = ix > 0x3fe90000 ? 0.28125 : _fromWords(ix - 0x00200000, 0); // x > 0.78125 ? : x/4
	const iz = 0.5 * z - qx;
	const a = 1.0 - qx;
	return a - (iz - (z * r - x * y));
}

const _T = [
	3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02,
	2.18694882948595424599e-02, 8.86323982359930005737e-03, 3.59207910759131235356e-03,
	1.45620945432529025516e-03, 5.88041240820264096874e-04, 2.46463134818469906812e-04,
	7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
	2.59073051863633712884e-05,
];
const _tanPio4 = 7.85398163397448278999e-01;
const _tanPio4lo = 3.06161699786838301793e-17;

function _kernelTan(x, y, iy) {
	const hx = _hi(x);
	const ix = hx & 0x7fffffff;
	if (ix < 0x3e300000) { // |x| < 2^-28
		if (((ix | _lo(x)) | (iy + 1)) === 0) return 1.0 / Math.abs(x);
		if (iy === 1) return x;
		// compute -1 / (x+y) carefully
		let w0 = x + y;
		const z0 = _setLo(w0, 0);
		const v0 = y - (z0 - x);
		const a0 = -1.0 / w0;
		const t0 = _setLo(a0, 0);
		const s0 = 1.0 + t0 * z0;
		return t0 + a0 * (s0 + t0 * v0);
	}
	if (ix >= 0x3fe59428) { // |x| >= 0.6744
		if (hx < 0) { x = -x; y = -y; }
		const z1 = _tanPio4 - x;
		const w1 = _tanPio4lo - y;
		x = z1 + w1;
		y = 0.0;
	}
	const z = x * x;
	const w = z * z;
	let r = _T[1] + w * (_T[3] + w * (_T[5] + w * (_T[7] + w * (_T[9] + w * _T[11]))));
	const v = z * (_T[2] + w * (_T[4] + w * (_T[6] + w * (_T[8] + w * (_T[10] + w * _T[12])))));
	const s = z * x;
	r = y + z * (s * (r + v) + y);
	r += _T[0] * s;
	const w2 = x + r;
	if (ix >= 0x3fe59428) {
		const v2 = iy;
		return (1 - ((hx >> 30) & 2)) * (v2 - 2.0 * (x - (w2 * w2 / (w2 + v2) - r)));
	}
	if (iy === 1) return w2;
	// compute -1.0 / (x+r) accurately
	const z2 = _setLo(w2, 0);
	const v3 = r - (z2 - x);
	const a1 = -1.0 / w2;
	const t1 = _setLo(a1, 0);
	const s1 = 1.0 + t1 * z2;
	return t1 + a1 * (s1 + t1 * v3);
}

const _twoOverPi = [
	0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C,
	0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649,
	0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129, 0xA73EE8, 0x8235F5, 0x2EBB44,
	0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C, 0x845F8B,
	0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D,
	0x367ECF, 0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
	0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330,
	0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3, 0x91615E, 0xE61B08,
	0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
	0x73A8C9, 0x60E27B, 0xC08C6B,
];
const _npio2Hw = [
	0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C,
	0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
	0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
	0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
	0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB,
	0x404858EB, 0x404921FB,
];
const _two24 = 1.67772160000000000000e+07;
const _twon24 = 5.96046447753906250000e-08;
const _invpio2 = 6.36619772367581382433e-01;
const _pio2_1 = 1.57079632673412561417e+00;
const _pio2_1t = 6.07710050650619224932e-11;
const _pio2_2 = 6.07710050630396597660e-11;
const _pio2_2t = 2.02226624879595063154e-21;
const _pio2_3 = 2.02226624871116645580e-21;
const _pio2_3t = 8.47842766036889956997e-32;
const _PIo2 = [
	1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15,
	3.28200341580791294123e-22, 1.27065575308067607349e-29, 1.22933308981111328932e-36,
	2.73370053816464559624e-44, 2.16741683877804819444e-51,
];

// __kernel_rem_pio2 for prec=2 (jk=4), the only precision used here.
function _kernelRemPio2(x, y, e0, nx) {
	const jk = 4;
	const jp = jk;
	const iq = new Array(20).fill(0);
	const f = new Array(20).fill(0);
	const fq = new Array(20).fill(0);
	const q = new Array(20).fill(0);
	let z, fw, n, ih;
	let i, j, k, m;

	const jx = nx - 1;
	let jv = ((e0 - 3) / 24) | 0;
	if (jv < 0) jv = 0;
	let q0 = e0 - 24 * (jv + 1);

	j = jv - jx;
	m = jx + jk;
	for (i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0.0 : _twoOverPi[j];

	for (i = 0; i <= jk; i++) {
		for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
		q[i] = fw;
	}

	let jz = jk;
	for (;;) { // recompute:
		for (i = 0, j = jz, z = q[jz]; j > 0; i++, j--) {
			fw = Math.trunc(_twon24 * z);
			iq[i] = Math.trunc(z - _two24 * fw);
			z = q[j - 1] + fw;
		}

		z = _scalbn(z, q0);
		z -= 8.0 * Math.floor(z * 0.125);
		n = Math.trunc(z);
		z -= n;
		ih = 0;
		if (q0 > 0) {
			i = iq[jz - 1] >> (24 - q0);
			n += i;
			iq[jz - 1] -= i << (24 - q0);
			ih = iq[jz - 1] >> (23 - q0);
		} else if (q0 === 0) {
			ih = iq[jz - 1] >> 23;
		} else if (z >= 0.5) {
			ih = 2;
		}

		if (ih > 0) {
			n += 1;
			let carry = 0;
			for (i = 0; i < jz; i++) {
				j = iq[i];
				if (carry === 0) {
					if (j !== 0) { carry = 1; iq[i] = 0x1000000 - j; }
				} else {
					iq[i] = 0xFFFFFF - j;
				}
			}
			if (q0 > 0) {
				if (q0 === 1) iq[jz - 1] &= 0x7FFFFF;
				else if (q0 === 2) iq[jz - 1] &= 0x3FFFFF;
			}
			if (ih === 2) {
				z = 1.0 - z;
				if (carry !== 0) z -= _scalbn(1.0, q0);
			}
		}

		if (z === 0.0) {
			j = 0;
			for (i = jz - 1; i >= jk; i--) j |= iq[i];
			if (j === 0) { // need recomputation
				for (k = 1; jk >= k && iq[jk - k] === 0; k++) { /* k = terms needed */ }
				for (i = jz + 1; i <= jz + k; i++) {
					f[jx + i] = _twoOverPi[jv + i];
					for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
					q[i] = fw;
				}
				jz += k;
				continue; // goto recompute
			}
		}
		break;
	}

	if (z === 0.0) {
		jz -= 1;
		q0 -= 24;
		while (iq[jz] === 0) { jz--; q0 -= 24; }
	} else {
		z = _scalbn(z, -q0);
		if (z >= _two24) {
			fw = Math.trunc(_twon24 * z);
			iq[jz] = z - _two24 * fw;
			jz += 1;
			q0 += 24;
			iq[jz] = fw;
		} else {
			iq[jz] = z;
		}
	}

	fw = _scalbn(1.0, q0);
	for (i = jz; i >= 0; i--) { q[i] = fw * iq[i]; fw *= _twon24; }

	for (i = jz; i >= 0; i--) {
		for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += _PIo2[k] * q[i + k];
		fq[jz - i] = fw;
	}

	// compress fq[] into y[] (prec = 2)
	fw = 0.0;
	for (i = jz; i >= 0; i--) fw += fq[i];
	y[0] = ih === 0 ? fw : -fw;
	fw = fq[0] - fw;
	for (i = 1; i <= jz; i++) fw += fq[i];
	y[1] = ih === 0 ? fw : -fw;
	return n & 7;
}

const _remY = [0, 0];
const _remTx = [0, 0, 0];

function _remPio2(x, y) {
	const hx = _hi(x);
	const ix = hx & 0x7fffffff;
	if (ix <= 0x3fe921fb) { // |x| ~<= pi/4
		y[0] = x;
		y[1] = 0;
		return 0;
	}
	if (ix < 0x4002d97c) { // |x| < 3pi/4, special case with n=+-1
		let z;
		if (hx > 0) {
			z = x - _pio2_1;
			if (ix !== 0x3ff921fb) {
				y[0] = z - _pio2_1t;
				y[1] = (z - y[0]) - _pio2_1t;
			} else {
				z -= _pio2_2;
				y[0] = z - _pio2_2t;
				y[1] = (z - y[0]) - _pio2_2t;
			}
			return 1;
		}
		z = x + _pio2_1;
		if (ix !== 0x3ff921fb) {
			y[0] = z + _pio2_1t;
			y[1] = (z - y[0]) + _pio2_1t;
		} else {
			z += _pio2_2;
			y[0] = z + _pio2_2t;
			y[1] = (z - y[0]) + _pio2_2t;
		}
		return -1;
	}
	if (ix <= 0x413921fb) { // |x| ~<= 2^19*(pi/2), medium size
		let t = Math.abs(x);
		const n = Math.trunc(t * _invpio2 + 0.5);
		const fn = n;
		let r = t - fn * _pio2_1;
		let w = fn * _pio2_1t;
		if (n < 32 && ix !== _npio2Hw[n - 1]) {
			y[0] = r - w; // quick check no cancellation
		} else {
			const j = ix >> 20;
			y[0] = r - w;
			let high = _hi(y[0]);
			let i = j - ((high >> 20) & 0x7ff);
			if (i > 16) { // 2nd iteration
				t = r;
				w = fn * _pio2_2;
				r = t - w;
				w = fn * _pio2_2t - ((t - r) - w);
				y[0] = r - w;
				high = _hi(y[0]);
				i = j - ((high >> 20) & 0x7ff);
				if (i > 49) { // 3rd iteration
					t = r;
					w = fn * _pio2_3;
					r = t - w;
					w = fn * _pio2_3t - ((t - r) - w);
					y[0] = r - w;
				}
			}
		}
		y[1] = (r - y[0]) - w;
		if (hx < 0) {
			y[0] = -y[0];
			y[1] = -y[1];
			return -n;
		}
		return n;
	}
	if (ix >= 0x7ff00000) { // inf or NaN
		y[0] = y[1] = x - x;
		return 0;
	}
	// large: z = scalbn(|x|, ilogb(x)-23), break into 24-bit pieces
	let z = _setLo(0, _lo(x));
	const e0 = (ix >> 20) - 1046;
	z = _setHi(z, ix - ((e0 << 20) | 0));
	for (let i = 0; i < 2; i++) {
		_remTx[i] = Math.trunc(z);
		z = (z - _remTx[i]) * _two24;
	}
	_remTx[2] = z;
	let nx = 3;
	while (nx > 1 && _remTx[nx - 1] === 0) nx--;
	const n = _kernelRemPio2(_remTx, y, e0, nx);
	if (hx < 0) {
		y[0] = -y[0];
		y[1] = -y[1];
		return -n;
	}
	return n;
}

// ------------------------------------------------------------ dsin/dcos ----

export function dsin(x) {
	const ix = _hi(x) & 0x7fffffff;
	if (ix <= 0x3fe921fb) return _kernelSin(x, 0.0, 0);
	if (ix >= 0x7ff00000) return x - x;
	const n = _remPio2(x, _remY);
	switch (n & 3) {
		case 0: return _kernelSin(_remY[0], _remY[1], 1);
		case 1: return _kernelCos(_remY[0], _remY[1]);
		case 2: return -_kernelSin(_remY[0], _remY[1], 1);
		default: return -_kernelCos(_remY[0], _remY[1]);
	}
}

export function dcos(x) {
	const ix = _hi(x) & 0x7fffffff;
	if (ix <= 0x3fe921fb) return _kernelCos(x, 0.0);
	if (ix >= 0x7ff00000) return x - x;
	const n = _remPio2(x, _remY);
	switch (n & 3) {
		case 0: return _kernelCos(_remY[0], _remY[1]);
		case 1: return -_kernelSin(_remY[0], _remY[1], 1);
		case 2: return -_kernelCos(_remY[0], _remY[1]);
		default: return _kernelSin(_remY[0], _remY[1], 1);
	}
}

export function dtan(x) {
	const ix = _hi(x) & 0x7fffffff;
	if (ix <= 0x3fe921fb) return _kernelTan(x, 0.0, 1);
	if (ix >= 0x7ff00000) return x - x;
	const n = _remPio2(x, _remY);
	return _kernelTan(_remY[0], _remY[1], 1 - ((n & 1) << 1));
}

// ---------------------------------------------------------- datan/datan2 ----
// fdlibm s_atan.c / e_atan2.c

const _atanhi = [
	4.63647609000806093515e-01, 7.85398163397448278999e-01,
	9.82793723247329054082e-01, 1.57079632679489655800e+00,
];
const _atanlo = [
	2.26987774529616870924e-17, 3.06161699786838301793e-17,
	1.39033110312309984516e-17, 6.12323399573676603587e-17,
];
const _aT = [
	3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
	-1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
	6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
	-3.65315727442169155270e-02, 1.62858201153657823623e-02,
];

export function datan(x) {
	const hx = _hi(x);
	const ix = hx & 0x7fffffff;
	if (ix >= 0x44100000) { // |x| >= 2^66
		if (ix > 0x7ff00000 || (ix === 0x7ff00000 && _lo(x) !== 0)) return x + x; // NaN
		return hx > 0 ? _atanhi[3] + _atanlo[3] : -_atanhi[3] - _atanlo[3];
	}
	let id;
	if (ix < 0x3fdc0000) { // |x| < 0.4375
		if (ix < 0x3e400000) return x; // |x| < 2^-27
		id = -1;
	} else {
		x = Math.abs(x);
		if (ix < 0x3ff30000) { // |x| < 1.1875
			if (ix < 0x3fe60000) {
				id = 0;
				x = (2.0 * x - 1.0) / (2.0 + x);
			} else {
				id = 1;
				x = (x - 1.0) / (x + 1.0);
			}
		} else if (ix < 0x40038000) { // |x| < 2.4375
			id = 2;
			x = (x - 1.5) / (1.0 + 1.5 * x);
		} else {
			id = 3;
			x = -1.0 / x;
		}
	}
	const z = x * x;
	const w = z * z;
	const s1 = z * (_aT[0] + w * (_aT[2] + w * (_aT[4] + w * (_aT[6] + w * (_aT[8] + w * _aT[10])))));
	const s2 = w * (_aT[1] + w * (_aT[3] + w * (_aT[5] + w * (_aT[7] + w * _aT[9]))));
	if (id < 0) return x - x * (s1 + s2);
	const r = _atanhi[id] - ((x * (s1 + s2) - _atanlo[id]) - x);
	return hx < 0 ? -r : r;
}

const _pi_o_4 = 7.8539816339744827900e-01;
const _pi_o_2 = 1.5707963267948965580e+00;
const _pi_lo = 1.2246467991473531772e-16;

export function datan2(y, x) {
	const hx = _hi(x);
	const lx = _lo(x);
	const ix = hx & 0x7fffffff;
	const hy = _hi(y);
	const ly = _lo(y);
	const iy = hy & 0x7fffffff;
	if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) ||
		iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y; // NaN
	if (((hx - 0x3ff00000) | lx) === 0) return datan(y); // x = 1.0
	const m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2*sign(x)+sign(y)

	if ((iy | ly) === 0) { // y = 0
		switch (m) {
			case 0:
			case 1: return y;
			case 2: return _pi;
			default: return -_pi;
		}
	}
	if ((ix | lx) === 0) return hy < 0 ? -_pi_o_2 : _pi_o_2; // x = 0
	if (ix === 0x7ff00000) { // x inf
		if (iy === 0x7ff00000) {
			switch (m) {
				case 0: return _pi_o_4;
				case 1: return -_pi_o_4;
				case 2: return 3.0 * _pi_o_4;
				default: return -3.0 * _pi_o_4;
			}
		}
		switch (m) {
			case 0: return 0.0;
			case 1: return -0.0;
			case 2: return _pi;
			default: return -_pi;
		}
	}
	if (iy === 0x7ff00000) return hy < 0 ? -_pi_o_2 : _pi_o_2; // y inf

	let z;
	const k = (iy - ix) >> 20;
	if (k > 60) { // |y/x| > 2^60
		z = _pi_o_2 + 0.5 * _pi_lo;
		switch (m & 1) {
			case 0: return z;
			default: return -z;
		}
	} else if (hx < 0 && k < -60) {
		z = 0.0;
	} else {
		z = datan(Math.abs(y / x));
	}
	switch (m) {
		case 0: return z;
		case 1: return -z;
		case 2: return _pi - (z - _pi_lo);
		default: return (z - _pi_lo) - _pi;
	}
}

// ------------------------------------------------------------------ dexp ----
// fdlibm e_exp.c (including V8's exp(1) special case)

const _o_threshold = 7.09782712893383973096e+02;
const _u_threshold = -7.45133219101941108420e+02;
const _ln2HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
const _ln2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const _invln2 = 1.44269504088896338700e+00;
const _eP1 = 1.66666666666666019037e-01;
const _eP2 = -2.77777777770155933842e-03;
const _eP3 = 6.61375632143793436117e-05;
const _eP4 = -1.65339022054652515390e-06;
const _eP5 = 4.13813679705723846039e-08;
const _E = 2.718281828459045;
const _twom1000 = 9.33263618503218878990e-302;
const _two1023 = 8.988465674311579539e307;

export function dexp(x) {
	let hx = _hi(x);
	const xsb = (hx >> 31) & 1;
	hx &= 0x7fffffff;

	if (hx >= 0x40862e42) { // |x| >= 709.78...
		if (hx >= 0x7ff00000) {
			if (((hx & 0xfffff) | _lo(x)) !== 0) return x + x; // NaN
			return xsb === 0 ? x : 0.0; // exp(+-inf) = {inf, 0}
		}
		if (x > _o_threshold) return 1.0e300 * 1.0e300; // overflow
		if (x < _u_threshold) return _twom1000 * _twom1000; // underflow
	}

	let hi = 0.0, lo = 0.0, k = 0;
	if (hx > 0x3fd62e42) { // |x| > 0.5 ln2
		if (hx < 0x3ff0a2b2) { // |x| < 1.5 ln2
			if (x === 1.0) return _E;
			hi = x - _ln2HI[xsb];
			lo = _ln2LO[xsb];
			k = 1 - xsb - xsb;
		} else {
			k = Math.trunc(_invln2 * x + (xsb === 0 ? 0.5 : -0.5));
			const t = k;
			hi = x - t * _ln2HI[0];
			lo = t * _ln2LO[0];
		}
		x = hi - lo;
	} else if (hx < 0x3e300000) { // |x| < 2^-28
		return 1.0 + x;
	}

	const t = x * x;
	const twopk = k >= -1021
		? _fromWords(0x3ff00000 + ((k << 20) | 0), 0)
		: _fromWords(0x3ff00000 + ((k + 1000) << 20), 0);
	const c = x - t * (_eP1 + t * (_eP2 + t * (_eP3 + t * (_eP4 + t * _eP5))));
	if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
	const y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
	if (k >= -1021) {
		if (k === 1024) return y * 2.0 * _two1023;
		return y * twopk;
	}
	return y * twopk * _twom1000;
}

// ------------------------------------------------------------------ dpow ----
// fdlibm e_pow.c

const _bp = [1.0, 1.5];
const _dp_h = [0.0, 5.84962487220764160156e-01];
const _dp_l = [0.0, 1.35003920212974897128e-08];
const _two53 = 9007199254740992.0;
const _L1 = 5.99999999999994648725e-01;
const _L2 = 4.28571428578550184252e-01;
const _L3 = 3.33333329818377432918e-01;
const _L4 = 2.72728123808534006489e-01;
const _L5 = 2.30660745775561754067e-01;
const _L6 = 2.06975017800338417784e-01;
const _lg2 = 6.93147180559945286227e-01;
const _lg2_h = 6.93147182464599609375e-01;
const _lg2_l = -1.90465429995776804525e-09;
const _ovt = 8.0085662595372944372e-17;
const _cp = 9.61796693925975554329e-01;
const _cp_h = 9.61796700954437255859e-01;
const _cp_l = -7.02846165095275826516e-09;
const _ivln2 = 1.44269504088896338700e+00;
const _ivln2_h = 1.44269502162933349609e+00;
const _ivln2_l = 1.92596299112661746887e-08;

export function dpow(x, y) {
	const hx = _hi(x), lx = _lo(x);
	const hy = _hi(y), ly = _lo(y);
	let ix = hx & 0x7fffffff;
	const iy = hy & 0x7fffffff;

	if ((iy | ly) === 0) return 1.0; // y == 0
	if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) ||
		iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y; // NaN

	// yisint: 0 not integer, 1 odd int, 2 even int (only needed for x < 0)
	let yisint = 0;
	let j, k;
	if (hx < 0) {
		if (iy >= 0x43400000) {
			yisint = 2;
		} else if (iy >= 0x3ff00000) {
			k = (iy >> 20) - 0x3ff;
			if (k > 20) {
				j = ly >>> (52 - k);
				if (((j << (52 - k)) >>> 0) === ly) yisint = 2 - (j & 1);
			} else if (ly === 0) {
				j = iy >> (20 - k);
				if ((j << (20 - k)) === iy) yisint = 2 - (j & 1);
			}
		}
	}

	if (ly === 0) { // special value of y
		if (iy === 0x7ff00000) { // y is +-inf
			if (((ix - 0x3ff00000) | lx) === 0) return y - y; // +-1**inf is NaN
			if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
			return hy < 0 ? -y : 0.0;
		}
		if (iy === 0x3ff00000) return hy < 0 ? 1.0 / x : x; // y is +-1
		if (hy === 0x40000000) return x * x; // y is 2
		if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x); // y is 0.5
	}

	let ax = Math.abs(x);
	if (lx === 0) { // special value of x: +-0, +-inf, +-1
		if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
			let z = ax;
			if (hy < 0) z = 1.0 / z;
			if (hx < 0) {
				if (((ix - 0x3ff00000) | yisint) === 0) z = NaN; // (-1)**non-int
				else if (yisint === 1) z = -z;
			}
			return z;
		}
	}

	let n = (hx >> 31) + 1;
	if ((n | yisint) === 0) return NaN; // (x<0)**(non-int)

	let s = 1.0;
	if ((n | (yisint - 1)) === 0) s = -1.0; // (-ve)**(odd int)

	let t1, t2;
	if (iy > 0x41e00000) { // |y| > 2^31
		if (iy > 0x43f00000) { // |y| > 2^64
			if (ix <= 0x3fefffff) return hy < 0 ? 1e300 * 1e300 : 1e-300 * 1e-300;
			if (ix >= 0x3ff00000) return hy > 0 ? 1e300 * 1e300 : 1e-300 * 1e-300;
		}
		if (ix < 0x3fefffff) return hy < 0 ? s * 1e300 * 1e300 : s * 1e-300 * 1e-300;
		if (ix > 0x3ff00000) return hy > 0 ? s * 1e300 * 1e300 : s * 1e-300 * 1e-300;
		// |1-x| is tiny: log(x) by x-x^2/2+x^3/3-x^4/4
		const t = ax - 1.0;
		const w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
		const u = _ivln2_h * t;
		const v = t * _ivln2_l - w * _ivln2;
		t1 = _setLo(u + v, 0);
		t2 = v - (t1 - u);
	} else {
		n = 0;
		if (ix < 0x00100000) { // subnormal x
			ax *= _two53;
			n -= 53;
			ix = _hi(ax);
		}
		n += (ix >> 20) - 0x3ff;
		j = ix & 0x000fffff;
		ix = j | 0x3ff00000;
		if (j <= 0x3988e) {
			k = 0; // |x| < sqrt(3/2)
		} else if (j < 0xbb67a) {
			k = 1; // |x| < sqrt(3)
		} else {
			k = 0;
			n += 1;
			ix -= 0x00100000;
		}
		ax = _setHi(ax, ix);

		// compute ss = s_h+s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
		const u = ax - _bp[k];
		const v = 1.0 / (ax + _bp[k]);
		const ss = u * v;
		const s_h = _setLo(ss, 0);
		let t_h = _fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
		let t_l = ax - (t_h - _bp[k]);
		const s_l = v * ((u - s_h * t_h) - s_h * t_l);
		// compute log(ax)
		let s2 = ss * ss;
		let r = s2 * s2 * (_L1 + s2 * (_L2 + s2 * (_L3 + s2 * (_L4 + s2 * (_L5 + s2 * _L6)))));
		r += s_l * (s_h + ss);
		s2 = s_h * s_h;
		t_h = _setLo(3.0 + s2 + r, 0);
		t_l = r - ((t_h - 3.0) - s2);
		const uu = s_h * t_h;
		const vv = s_l * t_h + t_l * ss;
		// 2/(3log2)*(ss+...)
		const p_h = _setLo(uu + vv, 0);
		const p_l = vv - (p_h - uu);
		const z_h = _cp_h * p_h;
		const z_l = _cp_l * p_h + p_l * _cp + _dp_l[k];
		const t = n;
		t1 = _setLo(((z_h + z_l) + _dp_h[k]) + t, 0);
		t2 = z_l - (((t1 - t) - _dp_h[k]) - z_h);
	}

	// split up y into y1+y2 and compute (y1+y2)*(t1+t2)
	const y1 = _setLo(y, 0);
	let p_l = (y - y1) * t1 + y * t2;
	let p_h = y1 * t1;
	let z = p_l + p_h;
	j = _hi(z);
	const i = _lo(z) | 0;
	if (j >= 0x40900000) { // z >= 1024
		if (((j - 0x40900000) | i) !== 0) return s * 1e300 * 1e300; // overflow
		if (p_l + _ovt > z - p_h) return s * 1e300 * 1e300;
	} else if ((j & 0x7fffffff) >= 0x4090cc00) { // z <= -1075
		if ((((j - 0xc090cc00) | 0) | i) !== 0) return s * 1e-300 * 1e-300; // underflow
		if (p_l <= z - p_h) return s * 1e-300 * 1e-300;
	}
	// compute 2**(p_h+p_l)
	const ii = j & 0x7fffffff;
	k = (ii >> 20) - 0x3ff;
	n = 0;
	if (ii > 0x3fe00000) { // |z| > 0.5, set n = [z + 0.5]
		n = j + (0x00100000 >> (k + 1));
		k = (((n & 0x7fffffff) | 0) >> 20) - 0x3ff;
		const t = _fromWords(n & ~(0x000fffff >> k), 0);
		n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
		if (j < 0) n = -n;
		p_h -= t;
	}
	let t = _setLo(p_l + p_h, 0);
	const u = t * _lg2_h;
	const v = (p_l - (t - p_h)) * _lg2 + t * _lg2_l;
	z = u + v;
	const w = v - (z - u);
	t = z * z;
	t1 = z - t * (_eP1 + t * (_eP2 + t * (_eP3 + t * (_eP4 + t * _eP5))));
	const r = (z * t1) / ((t1 - 2.0) - (w + z * w));
	z = 1.0 - (r - z);
	j = (_hi(z) + ((n << 20) | 0)) | 0;
	if ((j >> 20) <= 0) z = _scalbn(z, n); // subnormal output
	else z = _setHi(z, _hi(z) + ((n << 20) | 0));
	return s * z;
}
