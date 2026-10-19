# Validator Test Fixtures

These fixtures are committed to the repo for reproducible unit tests. All audio/image fixtures are generated with `ffmpeg` (already a runtime dependency). The PDF is generated via `generate-pdf.ts` using `pdf-lib`.

## Regeneration commands

### Audio fixtures
```bash
# 5 seconds of silence (zero amplitude — for RMS ~0 and duration checks)
ffmpeg -f lavfi -i anullsrc=channel_layout=mono:sample_rate=24000 -t 5 silence_5s.mp3

# 5 seconds of 440 Hz sine wave (low zero-crossing rate ~880/s)
ffmpeg -f lavfi -i "sine=frequency=440:duration=5:sample_rate=24000" -ac 1 sine_440hz_5s.mp3

# 5 seconds of white noise (high zero-crossing rate >5000/s — used as "bad" fixture for rejection tests)
ffmpeg -f lavfi -i "anoisesrc=duration=5:sample_rate=24000:amplitude=0.8" -ac 1 white_noise_5s.mp3
```

### Image fixture
```bash
# 64×32 red PNG (width=64, height=32)
ffmpeg -f lavfi -i "color=c=red:s=64x32" -frames:v 1 tiny_png_64x32.png
```

### PDF fixture
```bash
# Single-page A4 PDF
node --import=tsx generate-pdf.ts
```

### Markdown / JSON fixtures
Hand-written; no generation command needed. `tiny_markdown.md` contains exactly 50 words. `tiny_schema.json` is a JSON object + `schema.json` is the corresponding valid schema.

## Fixture inventory

| File | Purpose | Handler | Expected measurement |
|------|---------|---------|----------------------|
| `silence_5s.mp3` | Happy-path audio | `audio.duration_s` | ≈5.0 s |
| `silence_5s.mp3` | Zero-amplitude | `audio.rms` | < 0.01 |
| `sine_440hz_5s.mp3` | Pure tone | `audio.zc_rate_per_s` | ≈880 ± 200 |
| `white_noise_5s.mp3` | High-frequency content | `audio.zc_rate_per_s` | > 5000 |
| `tiny_markdown.md` | 50-word text | `markdown.word_count` | 50 |
| `tiny_png_64x32.png` | 64×32 image | `image.width_px` | 64 |
| `tiny_png_64x32.png` | 64×32 image | `image.height_px` | 32 |
| `one_page.pdf` | Single page | `pdf.page_count` | 1 |
| `tiny_schema.json` | Valid JSON object | `json.schema_valid` | true (valid against schema.json) |
