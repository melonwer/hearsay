# Film verification

Verified locally on 2026-10-02. The delivered files are `../docs/hearsay-launch.mp4`, `../docs/hearsay-launch-nobgm.mp4`, and `../docs/video-poster.png`.

An independent review found no blocking product-claim, visual, or artifact fault. Its findings and limits are recorded in [REVIEW.md](REVIEW.md).

- The final MP4 has 1,534 frames, 1920×1080 at 30fps, H.264 video and 48kHz AAC audio. Its full video and audio streams decode without errors.
- The music mix peaks at −10.12 dBFS. The sound-effects-only mix peaks at −14.01 dBFS. Neither reaches full scale.
- Both exports have an identical encoded video stream. Their audio difference matches the selected music with correlation 0.99958; the remaining small difference comes from separate lossy AAC encodes.
- A low-frequency onset fit and rendered-audio cross-correlation place all seven scene cuts within 0.76 frames of the music grid. The measured output offset is zero frames for this Remotion 4.0.532 / H.264 / AAC 48kHz / MP4 pipeline.
- The Shotcraft editor imports the actual timeline, copy, font loader, and trimmed music component. Pixel comparison passed at frames 110, 260, 590, 830, 1030, 1260, and 1490; a final check after capture updates passed at frames 402, 714, and 1462 with zero differing pixels.
- The editor at `http://localhost:5198/?import=project` loaded with no browser page errors.
- `npm run lint` passed, including TypeScript checking. The repository diff has no whitespace errors. Hearsay's root runtime dependencies remain empty.
- Product claims were checked against the README, portable skill, evidence report, and studies documentation. The fictional example makes no lead, sale, uplift, customer-demand, or causal-effect claim. Actual product pages supply the UI screenshots.

Detailed machine reports, extracted frames, waveform probes, and prior inputs are retained under `out/qa/` and `out/capture-backups/`. The previous launch MP4 and poster are backed up under `out/backups/20261002T214427Z/`. Inputs and output hashes are retained in `out/qa/installed-artifacts.json`.

The requested GitHub source and published Shotcraft Gallery clips returned 404. Shotcraft is installed from the author's AtomGit mirror; the local recipe cards and demo source are available for review. No remote repository push or publishing step was performed.

## README preview compression

On 2026-10-03, the README GIF was reduced from 2,422,476 to 630,532 bytes, a 74% reduction. It retains the complete 14-second opening loop and the full-film link. The generator now exports 640×360 at 8fps with a 96-color palette and ordered Bayer dithering. Frame inspection confirmed readable story text and smoother shadows than the more aggressive no-dither candidate. Running `npm run preview:gif` twice produced the same SHA-256 checksum, `e297312a8797130948548542701a7f7fcc4dadcec513f12ed308118544fab631`.

All 112 frames decode without errors. A browser check confirmed automatic animation and the full-film link. The GIF loops indefinitely; its encoded duration is 14.01 seconds because GIF delays use hundredths of a second. The previous GIF is preserved in `out/backups/20261003T145253118Z/`. Compression comparisons and fresh artifact checks are retained in `out/qa/gif-optimization/`.

## Browser playback

On 2026-10-03, the [browser player](https://melonwer.github.io/hearsay/) was published through GitHub Pages from `main`'s `docs/` directory. The README's animated preview and full-film link open this player. It uses the existing MP4 and poster, native video controls, and inline mobile playback.

Fresh public-browser verification confirmed playback advances with unmuted audio and decoded AAC samples, zero download prompts or page errors, and no horizontal overflow at 390px. The page requests no MP4 before Play. GitHub Pages serves the MP4 as `video/mp4` and returns HTTP 206 for byte-range requests, supporting playback and seeking without saving the file. Detailed local and public receipts are retained in `out/qa/browser-player/`.

## Player page overview

The page now presents a short product introduction, the film, and the question → evidence → next-step workflow, with a prominent Return to Repo link and the assistant quickstart. Its design follows the film's light background and blue accents. The new opening poster is a 35 KB WebP extracted from the existing film; the original poster and MP4 remain preserved.

Desktop and mobile screenshots, playback checks, and link verification are retained in `out/qa/page-polish/`. Layout checks cover 320px and 390px widths, and the player retains its native controls, unmuted audio, and no video loading before Play.
