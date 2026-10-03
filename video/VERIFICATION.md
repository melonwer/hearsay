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
