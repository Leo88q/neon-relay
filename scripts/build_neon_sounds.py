#!/usr/bin/env python3
"""Neon Relay original SFX synthesizer (BL-18).

Replaces every upstream WavPack sample in data/audio with a procedurally
synthesised original (22050 Hz, 16-bit mono WAV; the engine gained a WAV
decoder in src/engine/client/sound.cpp for this). Each base name has a
recipe; numbered variants get deterministic pitch/length jitter. Looping
sounds (hook_loop, music_menu) are built seam-free: tones are quantised to
whole cycles over the loop length and tails are crossfaded into heads.

No upstream audio is used or referenced - everything is generated from
sine/noise primitives in the Neon Relay sound language: cyan = UI/pickups,
magenta = weapons/danger, indigo = lasers, warm pads = menu.
"""
import math
import pathlib
import random
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "audio"
SR = 22050


# ---------------------------------------------------------------- primitives
def sine(n, f0, f1=None, phase=0.0):
	out = []
	f1 = f0 if f1 is None else f1
	ph = phase
	for i in range(n):
		f = f0 + (f1 - f0) * (i / max(1, n - 1))
		ph += 2 * math.pi * f / SR
		out.append(math.sin(ph))
	return out


def noise(n, seed):
	rng = random.Random(seed)
	return [rng.uniform(-1, 1) for _ in range(n)]


def lp(x, cutoff):
	a = math.exp(-2 * math.pi * cutoff / SR)
	a = 1 - a
	y = []
	prev = 0.0
	for v in x:
		prev += a * (v - prev)
		y.append(prev)
	return y


def hp(x, cutoff):
	l = lp(x, cutoff)
	return [v - w for v, w in zip(x, l)]


def env(n, attack=0.001, decay=0.1, sustain=0.0, release=0.05, total=None):
	"""Simple ADSR-ish envelope over n samples."""
	out = []
	na, nr = int(attack * SR), int(release * SR)
	nd = int(decay * SR)
	for i in range(n):
		if i < na:
			v = i / max(1, na)
		elif i < na + nd:
			t = (i - na) / max(1, nd)
			v = 1 - t * (1 - sustain)
		elif i >= n - nr:
			v = sustain * max(0.0, (n - i) / max(1, nr))
		else:
			v = sustain
		out.append(v)
	return out


def expd(n, tau):
	return [math.exp(-i / (SR * tau)) for i in range(n)]


def scale(x, k):
	return [v * k for v in x]


def mix(*tracks):
	n = max(len(t) for t in tracks)
	out = [0.0] * n
	for t in tracks:
		for i, v in enumerate(t):
			out[i] += v
	return out


def pad_to(x, n):
	return x + [0.0] * (n - len(x))


def crossfade_loop(x, xf):
	"""Fade the tail into the head so the sample loops seamlessly."""
	n = len(x)
	k = int(xf * SR)
	for i in range(k):
		t = i / k
		x[i] = x[i] * t + x[n - k + i] * (1 - t)
	return x[:n - k]


def write_wav(name, x, loop=False):
	peak = max(1e-9, max(abs(v) for v in x))
	k = 0.89 / peak
	path = OUT / f"{name}.wav"
	with wave.open(str(path), "wb") as w:
		w.setnchannels(1)
		w.setsampwidth(2)
		w.setframerate(SR)
		w.writeframes(b"".join(
			int(max(-32767, min(32767, v * k * 32767))).to_bytes(2, "little", signed=True)
			for v in x))
	return path


def dur(seconds):
	return int(seconds * SR)


# ---------------------------------------------------------------- recipes
def r_pain_short(v):
	n = dur(0.16 + 0.01 * v)
	return mix(scale(sine(n, 430 * (1 + 0.03 * v), 250), 0.7),
		scale(sine(n, 860, 500), 0.25), scale(lp(noise(n, 7 + v), 900), 0.2)) * env(n, 0.002, 0.1, 0.2, 0.04) if False else \
		mix(scale([a * b for a, b in zip(sine(n, 430 * (1 + 0.03 * v), 250), env(n, 0.002, 0.1, 0.2, 0.04))], 0.7),
			scale([a * b for a, b in zip(sine(n, 860, 500), env(n, 0.002, 0.1, 0.1, 0.04))], 0.25))


def r_pain_long(v):
	n = dur(0.45)
	e = env(n, 0.01, 0.2, 0.4, 0.12)
	vib = [math.sin(2 * math.pi * 9 * i / SR) * 12 for i in range(n)]
	base = [math.sin(2 * math.pi * (380 - 160 * i / n + vib[i]) / SR) for i in range(n)]
	return scale([a * b for a, b in zip(base, e)], 0.8)


def r_spawn(v):
	n = dur(0.3)
	a = dur(0.14)
	t1 = mix(scale(sine(a, 392, 392), 0.6), scale(sine(a, 784, 784), 0.3))
	t2 = mix(scale(sine(n - a, 523, 523), 0.6), scale(sine(n - a, 1046, 1046), 0.3))
	return pad_to(scale(t1, 1.0), a) + [x * (1 - i / (n - a)) ** 0.3 for i, x in enumerate(t2)]


def r_ninja_voice(v):
	n = dur(0.35)
	return mix(scale([a * b for a, b in zip(sine(n, 900, 1800), env(n, 0.005, 0.15, 0.3, 0.08))], 0.5),
		scale([a * b for a, b in zip(hp(noise(n, 31 + v), 2500), env(n, 0.002, 0.1, 0.2, 0.06))], 0.4))


def r_cry(v):
	n = dur(0.6)
	seg = dur(0.2)
	out = []
	for k, f in enumerate((520, 430, 330)):
		s = [math.sin(2 * math.pi * f / SR * (1 - 0.1 * i / seg)) * math.sin(math.pi * i / seg)
			for i in range(seg)]
		out += s
	return scale(pad_to(out, n), 0.7)


def r_sledge(v):
	n = dur(0.25)
	sq = [math.copysign(1.0, math.sin(2 * math.pi * (140 - 60 * i / n) * i / SR)) for i in range(n)]
	return mix(scale([a * b for a, b in zip(sq, env(n, 0.004, 0.12, 0.3, 0.06))], 0.5),
		scale([a * b for a, b in zip(lp(noise(n, 55 + v), 500), expd(n, 0.08))], 0.5))


def r_noammo(v):
	n = dur(0.09)
	clk = [a * b for a, b in zip(hp(noise(n, 91 + v), 3000), expd(n, 0.012))]
	return clk + [0.0] * dur(0.05) + scale(clk, 0.7)


def r_ninja_attack(v):
	n = dur(0.3)
	sw = [math.sin(2 * math.pi * (300 + 1700 * i / n) / SR) for i in range(n)]
	return mix(scale([a * b for a, b in zip(sw, env(n, 0.01, 0.15, 0.4, 0.06))], 0.4),
		scale([a * b for a, b in zip(hp(noise(n, 12 + v), 1800), env(n, 0.01, 0.2, 0.5, 0.05))], 0.5))


def r_ninja_hit(v):
	n = dur(0.22)
	crack = hp(noise(n, 77 + v), 2600)
	return mix(scale([a * b for a, b in zip(crack, expd(n, 0.05))], 0.7),
		scale([a * b for a, b in zip(sine(n, 2400, 900), expd(n, 0.04))], 0.35))


def r_laser_fire(v):
	n = dur(0.32)
	return mix(scale([a * b for a, b in zip(sine(n, 1900 * (1 + 0.02 * v), 260), env(n, 0.002, 0.2, 0.25, 0.05))], 0.7),
		scale([a * b for a, b in zip(sine(n, 3800, 520), env(n, 0.002, 0.12, 0.1, 0.04))], 0.3))


def r_laser_bnce(v):
	n = dur(0.18)
	f = [500 + 900 * math.exp(-i / (SR * 0.03)) * abs(math.sin(i / (SR * 0.05))) for i in range(n)]
	return scale([math.sin(2 * math.pi * ff / SR) * e for ff, e in zip(f, expd(n, 0.06))], 0.7)


def r_hammer_swing(v):
	n = dur(0.22)
	return scale([a * b for a, b in zip(lp(noise(n, 21 + v), 700 + 900 * (1 - v * 0.1)), env(n, 0.02, 0.15, 0.4, 0.04))], 0.8)


def r_hammer_hit(v):
	n = dur(0.3)
	parts = [1.0, 2.76, 5.4, 8.9]
	clang = [sum(math.sin(2 * math.pi * 620 * p * (1 + 0.006 * v) * i / SR) / (k + 1)
		for k, p in enumerate(parts)) for i in range(n)]
	return mix(scale([a * b for a, b in zip(clang, expd(n, 0.09))], 0.5),
		scale([a * b for a, b in zip(lp(noise(n, 44 + v), 1200), expd(n, 0.02))], 0.6))


def r_gun_fire(v):
	n = dur(0.16)
	return mix(scale([a * b for a, b in zip(hp(noise(n, 5 + v), 1500), expd(n, 0.03))], 0.8),
		scale([a * b for a, b in zip(sine(n, 220, 90), expd(n, 0.05))], 0.6))


def r_shotty_fire(v):
	n = dur(0.28)
	return mix(scale([a * b for a, b in zip(hp(noise(n, 6 + v), 900), expd(n, 0.06))], 0.9),
		scale([a * b for a, b in zip(sine(n, 160, 60), expd(n, 0.09))], 0.7))


def r_flump_launch(v):
	n = dur(0.2)
	return mix(scale([a * b for a, b in zip(sine(n, 320, 90), env(n, 0.002, 0.1, 0.3, 0.04))], 0.8),
		scale([a * b for a, b in zip(lp(noise(n, 63 + v), 800), expd(n, 0.05))], 0.4))


def r_flump_explo(v):
	n = dur(0.7)
	boom = lp(noise(n, 88 + v), 400 + 500 * math.exp(-5 * 1.0))
	return mix(scale([a * b for a, b in zip(boom, expd(n, 0.25))], 0.9),
		scale([a * b for a, b in zip(sine(n, 90, 40), expd(n, 0.3))], 0.7),
		scale([a * b for a, b in zip(hp(noise(n, 89 + v), 2000), expd(n, 0.04))], 0.4))


def r_switch(v):
	n = dur(0.12)
	sq = [math.copysign(1.0, math.sin(2 * math.pi * 700 * i / SR)) for i in range(n)]
	return scale([a * b for a, b in zip(sq, env(n, 0.001, 0.05, 0.4, 0.03))], 0.4)


def r_skid(v):
	n = dur(0.3)
	lfo = [0.5 + 0.5 * math.sin(2 * math.pi * 23 * i / SR) for i in range(n)]
	base = lp(noise(n, 33 + v), 1400)
	return scale([a * b * c for a, b, c in zip(base, lfo, env(n, 0.01, 0.2, 0.5, 0.06))], 0.6)


def r_pickup_arm(v):
	n = dur(0.25)
	return mix(scale([a * b for a, b in zip(sine(n, 620, 930), env(n, 0.002, 0.12, 0.3, 0.06))], 0.6),
		scale([a * b for a, b in zip(sine(n, 1240, 1860), env(n, 0.004, 0.1, 0.15, 0.06))], 0.3))


def r_pickup_hrt(v):
	n = dur(0.3)
	a = dur(0.13)
	t1 = sine(a, 660, 660)
	t2 = sine(n - a, 880, 880)
	e1 = env(a, 0.002, 0.08, 0.2, 0.03)
	e2 = env(n - a, 0.002, 0.15, 0.2, 0.08)
	return mix(pad_to(scale([x * y for x, y in zip(t1, e1)], 0.7), n),
		pad_to(scale([x * y for x, y in zip(t2, e2)], 0.7), n))


def r_pickup_wpn(base):
	def f(v):
		n = dur(0.28)
		seq = (base, base * 1.26, base * 1.5)
		out = []
		seg = n // 3
		for k, fr in enumerate(seq):
			s = [math.sin(2 * math.pi * fr / SR) * math.sin(math.pi * i / seg) ** 0.5 for i in range(seg)]
			out += s
		return scale(pad_to(out, n), 0.65)
	return f


def r_msg(kind):
	freqs = {"server": (523, 659), "client": (440, 554), "highlight": (784, 988)}[kind]
	def f(v):
		n = dur(0.22)
		a = n // 2
		t = [math.sin(2 * math.pi * freqs[0] / SR)] * a if False else sine(a, freqs[0], freqs[0])
		t2 = sine(n - a, freqs[1], freqs[1])
		e = env(a, 0.002, 0.06, 0.3, 0.02)
		e2 = env(n - a, 0.002, 0.08, 0.3, 0.05)
		return scale(pad_to([x * y for x, y in zip(t, e)], n) and
			[p + q for p, q in zip(pad_to([x * y for x, y in zip(t, e)], n), pad_to([x * y for x, y in zip(t2, e2)], n))], 0.6)
	return f


def r_ctf_grab(player):
	def f(v):
		n = dur(0.35)
		f0, f1 = (659, 880) if player else (494, 622)
		a = n // 2
		one = [math.sin(2 * math.pi * f0 / SR) * math.sin(math.pi * i / a) for i in range(a)]
		two = [math.sin(2 * math.pi * f1 / SR) * math.sin(math.pi * i / (n - a)) for i in range(n - a)]
		return scale(pad_to(one + two, n), 0.7)
	return f


def r_ctf_rtn(v):
	n = dur(0.3)
	a = n // 2
	one = sine(a, 587, 587)
	two = sine(n - a, 392, 392)
	e = env(a, 0.002, 0.08, 0.3, 0.02)
	e2 = env(n - a, 0.002, 0.1, 0.3, 0.05)
	return scale([p + q for p, q in zip(pad_to([x * y for x, y in zip(one, e)], n),
		pad_to([x * y for x, y in zip(two, e2)], n))], 0.65)


def r_ctf_drop(v):
	n = dur(0.25)
	return mix(scale([a * b for a, b in zip(sine(n, 240, 110), expd(n, 0.08))], 0.7),
		scale([a * b for a, b in zip(lp(noise(n, 17), 600), expd(n, 0.04))], 0.4))


def r_ctf_cap(v):
	n = dur(0.9)
	seg = n // 4
	out = []
	for fr in (523, 659, 784, 1046):
		out += [math.sin(2 * math.pi * fr / SR) * math.sin(math.pi * min(1.0, i / seg) ** 0.4) ** 0.7
			for i in range(seg)]
	return scale(pad_to(out, n), 0.7)


def r_spawn_wpn(v):
	n = dur(0.4)
	return mix(scale([a * b for a, b in zip(sine(n, 880, 1760), env(n, 0.02, 0.2, 0.3, 0.1))], 0.4),
		scale([a * b for a, b in zip(sine(n, 1320, 2640), env(n, 0.03, 0.2, 0.2, 0.12))], 0.25))


def r_hit(strong):
	def f(v):
		n = dur(0.2 if not strong else 0.3)
		return mix(scale([a * b for a, b in zip(lp(noise(n, 3 + v), 900 if not strong else 500), expd(n, 0.05))], 0.8),
			scale([a * b for a, b in zip(sine(n, 180 if not strong else 120, 70), expd(n, 0.06))], 0.7))
	return f


def r_hook_attach(v):
	n = dur(0.1)
	return mix(scale([a * b for a, b in zip(hp(noise(n, 71 + v), 2500), expd(n, 0.015))], 0.7),
		scale([a * b for a, b in zip(sine(n, 1200, 700), expd(n, 0.02))], 0.4))


def r_hook_noattach(v):
	n = dur(0.12)
	return scale([a * b for a, b in zip(lp(noise(n, 72 + v), 500), expd(n, 0.03))], 0.6)


def r_hook_loop(v):
	n = dur(0.32)
	l = [math.sin(2 * math.pi * (round(86 * n / SR) * SR / n) * i / SR) for i in range(n)]
	nz = lp(noise(n, 99), 300)
	x = mix(scale(l, 0.6), scale(nz, 0.25))
	return crossfade_loop(x, 0.08)


def r_foot(side):
	def f(v):
		n = dur(0.07)
		f0 = 260 if side == "left" else 300
		return mix(scale([a * b for a, b in zip(lp(noise(n, 40 + v + (0 if side == "left" else 7)), f0), expd(n, 0.02))], 0.7),
			scale([a * b for a, b in zip(sine(n, f0 * 0.5, f0 * 0.3), expd(n, 0.02))], 0.35))
	return f


def r_land(v):
	n = dur(0.14)
	return mix(scale([a * b for a, b in zip(lp(noise(n, 51 + v), 350), expd(n, 0.04))], 0.8),
		scale([a * b for a, b in zip(sine(n, 130, 60), expd(n, 0.05))], 0.6))


def r_dbljump(v):
	n = dur(0.25)
	return scale([a * b for a, b in zip(hp(noise(n, 61 + v), 1200 + 2000 * (1 - 1)), env(n, 0.01, 0.18, 0.4, 0.05))], 0.6)


def r_body_impact(v):
	n = dur(0.18)
	return mix(scale([a * b for a, b in zip(lp(noise(n, 81 + v), 420), expd(n, 0.05))], 0.8),
		scale([a * b for a, b in zip(sine(n, 150, 60), expd(n, 0.06))], 0.6))


def r_body_splat(v):
	n = dur(0.22)
	wet = lp(noise(n, 91 + v), 800)
	wob = [0.6 + 0.4 * math.sin(2 * math.pi * 31 * i / SR) for i in range(n)]
	return scale([a * b * c for a, b, c in zip(wet, wob, expd(n, 0.07))], 0.75)


def r_music_menu(v):
	L = dur(8.0)
	seg = L // 4
	chords = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63),
		(261.63, 329.63, 392.0), (196.0, 246.94, 293.66)]
	out = [0.0] * L
	def q(f):
		return round(f * L / SR) * SR / L  # whole cycles over the loop
	for c, (f1, f2, f3) in enumerate(chords):
		s0 = c * seg
		e = [math.sin(math.pi * min(1.0, min(i, seg - i) / (0.12 * SR))) ** 0.7 for i in range(seg)]
		for fi, amp in ((f1, 0.30), (f2, 0.22), (f3, 0.16), (f1 / 2, 0.22)):
			fq = q(fi)
			for i in range(seg):
				t = s0 + i
				out[t] += amp * e[i] * math.sin(2 * math.pi * fq * t / SR)
	# soft ticks (interior only, keep loop point clean)
	rng = random.Random(4242)
	for b in range(2, 30):
		s0 = int(b * L / 32)
		if s0 > L - dur(0.05):
			continue
		tick = [x * y for x, y in zip(hp(noise(dur(0.03), 500 + b), 5000), expd(dur(0.03), 0.006))]
		for i, val in enumerate(tick):
			out[s0 + i] += val * (0.12 if b % 4 else 0.2)
	return crossfade_loop(out, 0.05)


RECIPES = {
	"vo_teefault_pain_short": r_pain_short,
	"vo_teefault_pain_long": r_pain_long,
	"vo_teefault_spawn": r_spawn,
	"vo_teefault_ninja": r_ninja_voice,
	"vo_teefault_cry": r_cry,
	"vo_teefault_sledge": r_sledge,
	"wp_noammo": r_noammo,
	"wp_ninja_attack": r_ninja_attack,
	"wp_ninja_hit": r_ninja_hit,
	"wp_laser_fire": r_laser_fire,
	"wp_laser_bnce": r_laser_bnce,
	"wp_hammer_swing": r_hammer_swing,
	"wp_hammer_hit": r_hammer_hit,
	"wp_gun_fire": r_gun_fire,
	"wp_shotty_fire": r_shotty_fire,
	"wp_flump_launch": r_flump_launch,
	"wp_flump_explo": r_flump_explo,
	"wp_switch": r_switch,
	"sfx_skid": r_skid,
	"sfx_pickup_arm": r_pickup_arm,
	"sfx_pickup_hrt": r_pickup_hrt,
	"sfx_pickup_gun": r_pickup_wpn(520),
	"sfx_pickup_sg": r_pickup_wpn(440),
	"sfx_pickup_launcher": r_pickup_wpn(360),
	"sfx_pickup_ninja": r_pickup_wpn(620),
	"sfx_msg-server": r_msg("server"),
	"sfx_msg-client": r_msg("client"),
	"sfx_msg-highlight": r_msg("highlight"),
	"sfx_ctf_grab_pl": r_ctf_grab(True),
	"sfx_ctf_grab_en": r_ctf_grab(False),
	"sfx_ctf_rtn": r_ctf_rtn,
	"sfx_ctf_drop": r_ctf_drop,
	"sfx_ctf_cap_pl": r_ctf_cap,
	"sfx_spawn_wpn": r_spawn_wpn,
	"sfx_hit_weak": r_hit(False),
	"sfx_hit_strong": r_hit(True),
	"hook_attach": r_hook_attach,
	"hook_noattach": r_hook_noattach,
	"hook_loop": r_hook_loop,
	"foley_foot_left": r_foot("left"),
	"foley_foot_right": r_foot("right"),
	"foley_land": r_land,
	"foley_dbljump": r_dbljump,
	"foley_body_impact": r_body_impact,
	"foley_body_splat": r_body_splat,
	"music_menu": r_music_menu,
}


def main():
	OUT.mkdir(parents=True, exist_ok=True)
	written = 0
	targets = {p.stem: p for p in OUT.glob("*.wv")}
	for wav in OUT.glob("*.wav"):
		targets.setdefault(wav.stem, wav)
	for stem in sorted(targets):
		wv = targets[stem]
		base = wv.stem
		var = 0
		if "-" in base and base.rsplit("-", 1)[1].isdigit():
			base, var = base.rsplit("-", 1)
			var = int(var)
		recipe = RECIPES.get(base)
		if recipe is None:
			print(f"  !! no recipe for {base}")
			continue
		x = recipe(var)
		write_wav(wv.stem, x)
		if wv.suffix == ".wv":
			wv.unlink()
		written += 1
	print(f"synthesised {written} original WAV samples, upstream .wv removed")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
