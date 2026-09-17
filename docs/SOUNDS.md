# Neon Relay original sounds (BL-18)

Every sound shipped by Neon Relay is an **original, procedurally synthesised
sample**: `scripts/build_neon_sounds.py` generates all 131 files in
`data/audio/` from sine/noise primitives (22050 Hz, 16-bit mono WAV). No
upstream audio is used, sampled or referenced; the former
WavPack files were removed.

## Engine support

The client sound backend gained a plain-WAV decoder
(`CSound::DecodeWav` / `CSound::LoadWav` in `src/engine/client/sound.cpp`,
RIFF/PCM16 mono/stereo), and the game sound loader
(`src/game/client/components/sounds.cpp`) plus `datasrc/content.py` now use
`.wav`. Opus and WavPack decoders remain available for map sounds and
mod content.

## Sound language

Consistent with `docs/DESIGN_SYNTHWAVE.md`:

* cyan family (bright sines, soft noise) - UI, messages, pickups, hooks;
* magenta family (noise bursts, fast sweeps) - weapons, impacts, danger;
* indigo sweeps - laser fire/bounce;
* warm quantised pads - `music_menu`, an 8-second seam-free loop
  (Am-F-C-G pad with bass and ticks; tones are quantised to whole cycles
  over the loop length and tails crossfaded into heads);
* `hook_loop` is a 0.32 s seam-free tension hum.

## Regeneration

```sh
python3 scripts/build_neon_sounds.py   # rewrites data/audio/*.wav deterministically
python3 scripts/gen_asset_manifest.py  # refresh hashes (rows are action=ship)
bash scripts/check_assets.sh
```

Variant numbering (`-01`, `-02`, …) applies deterministic pitch/length
jitter per index, so repeated builds are byte-identical.
