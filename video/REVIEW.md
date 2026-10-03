# Independent final film review

Reviewed on 2026-10-02 against `BRIEF.md`, `ASSETS.md`, the final Remotion source, frozen capture fixtures and provenance, `styleframes.html`, Shotcraft's `final-review.md` and `aesthetic-rules.md`, the four selected recipe cards, their exact TSX demos, and the Gallery library entries. Mode: autonomous custom creation. User requirements: a memorable story, pleasant polished visuals, accurate product details, Remotion and Video Shotcraft, captions and music without narration.

**No blocking product-claim, visual, or artifact fault was found in the inspected evidence.** The film has a coherent question → investigation → evidence → decision → repeat arc. The optional refinements below would strengthen the finish and recipe fidelity; they do not prevent delivery.

## Evidence inspected

- Final exports: `out/hearsay-launch.mp4` and `out/hearsay-launch-nobgm.mp4`.
- Visual inspection began with `out/qa/final-contact-sheet.png`, then eight 960×540 thumbnails: f0000, f0263, f0402, f0577, f0804, f1038, f1256, and f1462. The contact sheet also includes f0096 and f0714.
- Independent FFprobe: both exports are H.264, 1920×1080, 30fps, 1,534 frames, 51.133333 seconds of video, with 48kHz AAC audio. Both fully decoded without errors using the bundled `ffmpeg-static` binary.
- Independent encoded video stream hashes match: `fa6c4ef62d250f306d04f46888867efaa47278dc37d2698d1c23646efa3e4aa5`. This confirms identical pictures in the music and no-music exports, agreeing with `version-parity.json`.
- Independent PCM measurements: music export peak −10.12dBFS / RMS −27.83dBFS; no-music export peak −14.01dBFS / RMS −42.70dBFS. No clipping. The no-music version contains nonzero audio. Both use the same SFX table in source.
- `npm run lint` passed. No `Math.random()` or `Date.now()` appears in the rendering source.
- `audio-timing.json` reports rendered BGM cross-correlation offset 0 frames and all seven cuts within 0.76 frames of the fitted beat grid, below the 3-frame limit.

## Numbered findings

**P1 ✓ Product positioning.** f0263–f0402 establishes the buyer question and uncertainty; f0577 identifies the existing-agent workflow; f1462 names AI visibility research and inspectable records. This is consistent with the root README and `skill/SKILL.md`.

**P2/F1 ✓ Feature priorities.** The film clearly covers reviewed questions (f0577), retained answers (contact-sheet f0714), separate source/citation evidence (f0804), a hypothesis and reviewable draft (f1038), and a later observation rather than an invented uplift (f1256). These are the priorities recorded in the brief. It need not demonstrate every optional dashboard or study capability.

**P3/D1/D2 ✓ Claim and data accuracy.** Visible labels identify illustrations and fictional demo data. `notewell.example`, `demo-model`, and the fictional guide are retained in the inputs. The capture script starts a temporary database and constructs fixtures; no live provider call, private buyer conversation, customer result, sales effect, or automated publishing is claimed. “You decide what to change and publish” agrees with the README, `skill/references/studies.md`, and the Opportunities workflow. “Ask again” preserves observed differences without asserting causation.

**P4/B1/B2 ✓ Execution consistency.** Source timing matches the brief's eight shots and 1,534-frame total. The sequence and captions support the story shown in the inspected frames. `styleframes.html` and the finished film share the same editorial off-white/ink/blue direction; actual UI evidence replaces the conceptual evidence styleframe as the brief specifies.

**F2/F3 ✓ Information progression.** The same question anchors each phase, while each phase adds a new action or record. There is no redundant dashboard-tour shot or repeated closing tagline. The unanswered question at f0402 is a stronger memory point than a fabricated success metric.

**V1–V4/Q1/Q4/Q6 ✓ Visual direction and material quality.** f0263, f0577, f0804, f1038, and f1462 use restrained shadows, matching palette, consistent Inter typography, rounded masks, and clear hierarchy. UI screenshots are actual captures, not rebuilt Hearsay pages. Dense evidence and opportunity crops settle near frontal view. No neon drift, glitter, repeated glints, light spilling beyond card corners, or unwanted screen-wide beat pumping is apparent in the inspected frames or motion code.

**R1/R2/B3 ✓ Rest frames and finish.** The opening's last camera/card change ends at local f82, leaving 66 frames before the cut. The outro's assembled elements settle by local f40; the wordmark is fully landed by about local f61 and remains through local f205. Its URL and supporting line are settled by local f114, leaving more than three seconds of clean reading time. Nonlinear entrances and clipped single seams avoid mechanical repetition.

**R3/Q5 ✓ Focused opening, with a documented stylistic adaptation.** One Notewell card is the visual protagonist, with a restrained arrival rather than multiple competing objects. The opening lasts 4.93 seconds; its card movement lasts about 2.33 seconds, somewhat shorter than Shotcraft's default 3-second complete hero-motion arc. The settled time and large headline remain comfortable in the inspected frame sequence, so this is not a delivery blocker.

**Q3/R4 ✓ Stable motion source.** No handheld noise, random shake, repeated camera pumps, negative frames, or flash-cut set pieces appear in source. The outro has one small crane movement. Sampled stills show no accidental skew or layout jump; continuous perceptual playback was not available in this review.

**Q11/C1/C2 ✓ Main message readability.** The story headlines and narrative captions remain readable at the inspected 960×540 size, including the repository URL at f1462. Copy is concrete: reviewed questions, saved answers, recorded sources/citations, reviewable change, and repeat observation. Small native screenshot details at f0714, f0804 and f1038 remain contextual evidence, with large surrounding copy carrying the message. Pixel-level glyph-height certification and 480px-wide playback were not performed, so this is a practical readability finding rather than a claim that every small label meets Q11's numeric threshold.

**S1/S2/S3 ✓ Selected cards and variants.** The Gallery entries resolve all four named cards; there is no alternate style-key conflict. Agent uses variant A: 12f reveal, 20f continuous demotion at f32, content beginning at f44, the left-origin correction, and a short title. Its 0.38 end scale remains within the recipe's readable-label range. The outro preserves cue+12f staggered flight, genuine overshoot, 4° crane, f42–50 recession, per-letter landing, and rule timing. Its omitted particles/flashes and restrained lighting are explicitly documented for Hearsay's calm direction. No visual match to Gallery footage is claimed.

**S3/S4/Q9 △ Row-embed is a partial adaptation.** The saved-answer entrance retains the demo's 12f descent, 16° rotateX flattening, scale press-back, and one clipped bottom seam. It lands as a standalone editorial card (contact-sheet f0714), not in a visible native page slot; the empty-slot patch and downward page camera are absent. The film still clearly shows an actual saved answer, but calling it “row-embed-inspired entrance” would describe the result more precisely than implying the complete native-page embedding grammar.

**S3/S4 △ Marker texture is simplified.** At f0402 the underline is quick, close to the text, and slopes correctly, but `Marker` uses smooth constant-width SVG strokes rather than the demo's variable-width, seeded rough polygon. The underline supports the question cleanly; adding restrained variable width would make the tactile Shotcraft reference more recognizable. This is an optional refinement.

**A1/A5/A7/A8 ✓ Audio structure and delivery.** There is no narration track. The low-volume music bed and declared tactile paper/marker/camera sounds match the brief and asset record. All SFX have explicit Sequence durations, none of the selected SFX source files exceed five seconds, and no synthetic UI notification asset is used. The music/no-music picture parity is independently confirmed, and source retains the same SFX in both.

**A2/A3/A9 △ Alignment evidence is strongest for BGM cuts.** The reported BGM grid errors are comfortably within tolerance, and SFX are explicitly tied to named visual actions. The evidence does not contain separate per-source attack/peak lag measurements or a rendered three-probe SFX offset table; source also does not apply per-file lag compensation. Consequently this review cannot certify peak-perfect SFX alignment or the perceptual audibility of every quiet cue. This is a validation limit, not evidence of visible or audible failure.

**Q2/Q7/Q10/C3/P1–P4 scope.** True product captures, preserved inputs, selected recipe sources, storyboard, styleframes, and QA artifacts support the workflow. Q7's dark asset-pile close-up, Q10's document/report layout, and C3's 3D scene annotations are not used, so their specific staging rules do not apply. Full-resolution texture edge inspection was excluded from this bounded pass; the sampled views show no obvious pixel blocks, broken fonts, or incomplete captures.

## Must fix

None established by this review.

## Optional refinements

1. **Close the visual loop more literally.** f1462 reunites the website, answer, source/citation strips, and opportunity. The brief also says the question returns, but `Outro` has no buyer-question or observation-card element. A small representative question card would connect the remembered question to the sign-off, or the brief can be narrowed to the actual reunion. The current closing message remains clear without it.
2. **Keep recipe descriptions precise.** Describe the saved-answer entrance as inspired by row-embed, or add the genuine page-slot landing if full recipe fidelity is desired. Restore subtle variable-width marker texture if that tactile character is wanted.

## Limits that affect conclusions

Published Gallery reference MP4 URLs were unavailable (404); the comparison is against recipe cards, Gallery entries, and exact demo source only. This review inspected the contact sheet and eight thumbnails, probed and decoded both final files, and checked code/timing/fixtures. It did not perform continuous audiovisual playback, hear the mix, or inspect full-resolution glyph edges. The technical and story findings are supported; subjective music fit, every transient's perceived alignment, and final pixel-level typography remain outside this bounded pass.
