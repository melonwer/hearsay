# The conversation you never see

A 51-second Hearsay launch film for founders and marketers who already work with an AI assistant. The viewer should remember one question: when a buyer asks AI what to use, does your product appear? The film follows a blue Notewell website card into a documented investigation and ends with a next decision, rather than an invented success story.

The user approved replacing the existing tour, then asked for a memorable story, better visuals, Remotion, and Video Shotcraft. This is autonomous custom creation within that approved direction. The original GitHub Shotcraft repository returns 404. The author's AtomGit mirror is installed at `/home/d4ydy/.codex/skills/video-shotcraft`, revision `5ddbf521038b0a7accfb6dc1e0a9eb29c67277ab`.

## Creative decisions

| Requirement | Execution |
| --- | --- |
| Memorable story | A useful product, a buying conversation the founder cannot see, an unanswered question, then a practical investigation. One blue Notewell website card connects the scenes. |
| Pleasant visuals | Hearsay's off-white, ink, and blue palette. Large Inter Display typography, soft directional shadows, restrained depth, camera motion with rest frames. |
| Accurate claims | Copy linked below to README and the portable skill. Conceptual graphics carry an illustration label. Actual product screenshots come from a temporary demo workspace. |
| No invented results | No fabricated visibility scores, customer names, uplift, sales, or testimonials. The closing comparison names observations and preserves uncertainty. |
| Remotion | Separate `video/` development package. No runtime dependencies added to Hearsay. |
| Video Shotcraft | Read exact marker-underline-title, title-demote-to-label, row-embed, and outro-group-photo-launch recipes and demo sources. Adapt their timing and motion to Hearsay. Custom opening and buyer scenes are not claimed as recipe reproductions. |
| Sound | No voiceover. Tactile SFX with a quiet music bed; a second render retains SFX without music. Document asset licenses. |
| Editable delivery | Source timeline and Shotcraft workbench manifest share the same shot table. |

## Visual direction

Chosen direction: a clear editorial investigation, with dimensional cards. A literal dashboard walkthrough makes dense UI the story. A dark futuristic treatment suggests capabilities and precision the product does not claim. The chosen treatment uses the product's palette while giving one website card a physical journey.

Tokens derive from `public/style.css`: page `#f9f9f7`, surface `#fcfcfb`, ink `#0b0b0b`, secondary ink `#52514e`, blue `#2a78d6`, grid `#e1e0d9`. Dark blue is a restrained expansion for the unanswered-question scene. Inter follows the product's sans-serif system font, bundled for stable rendering. Narrative text is 72–132px; readable supporting labels are at least 36px. Dense screenshot text is background context unless shown in a dedicated close-up. UI screenshots preserve the real font and layout.

Motion is deliberate and friendly: 26-frame primary entrances, bezier `(0.16,1,0.3,1)`, small physical overshoot only on landings, no camera shake. Each shot has one main action and a static reading period. No glitter, repeated scanning effects, rainbow gradients, or fake metrics.

## Storyboard and claim sources

| Shot | From / duration | Story and picture | Claim source | QA frames |
| --- | --- | --- | --- | --- |
| Built | 0 / 148 | "You built something worth finding." A blue Notewell website card rises into a light, quiet stage. | Hypothetical founder setup; explicitly an illustration. | 26, 96, 147 |
| Buyer | 148 / 177 | "Then a buyer asks AI." A large neutral buyer question arrives across the frame, while the website card is outside the conversation. | README, What it does; the specific question is illustrative. | 174, 263, 324 |
| Question | 325 / 118 | "Would your name come up?" Blue field, white typography, an unanswered question. No answer or score is fabricated. | A question, not a result claim. | 351, 402, 442 |
| Agent | 443 / 206 | "Ask the agent you already use." Hearsay research prompt and reviewed buyer questions, with the original website card beside them. | README, Start with your assistant; skill/SKILL.md. | 469, 577, 648 |
| Evidence | 649 / 236 | "Keep the answer. Follow the evidence." Real demo Answers card, followed by native Source observations and Final-answer citations crops. | README, What it does; docs/evidence-report.md. Fictional demo label remains visible. | 675, 714, 804, 884 |
| Change | 885 / 236 | "Choose one change worth testing." Real Opportunities proposal with hypothesis and supporting report, then a review label. | README and core/research-store.js. Acceptance does not publish. | 911, 1038, 1120 |
| Repeat | 1121 / 207 | "Ask again. Compare what was observed." The same question connects a saved baseline and a later observation. No improvement is claimed. | README, independent trials; skill/references/studies.md. | 1147, 1256, 1327 |
| Hearsay | 1328 / 206 | Reunite the website, saved answer, source, citation, and reviewable decision around the Hearsay name. "AI visibility research, with a record you can inspect." Repository URL. | README and saved-evidence workflow. | 1354, 1462, 1533 |

Timing and copy are selected for the full film. Still frames verify the direction before implementation, then rendered frames and an independent review verify the result. Actual capture inputs are public fictional fixtures. The capture script creates a temporary database, calls no live provider, and preserves source screenshots and fixture JSON.

## Final production notes

The Notewell example is fictional, including its answer, source, citation, and proposal. It is captured in the actual Hearsay UI from a separate temporary database. The film does not claim to retrieve a buyer's private conversation. It asks viewers to run their own sample. The repeat scene illustrates a later observation, with no improvement, lead, sale, or causal effect claimed.

The actual timeline is `src/timeline.ts`: 1,534 frames at 30fps, 51.13 seconds. Cuts use a 122 BPM grid. Music is House Vibez by Lily J, kept quiet under tactile paper and marker sounds. Native screenshot detail is supporting context; large headlines and captions carry the story.

Shotcraft mapping uses `marker-underline-title` for the question underline, `title-demote-to-label` variant A for the agent section, a `row-embed`-inspired standalone-card entrance for the saved answer, and the gathering/wordmark structure of `outro-group-photo-launch` for the close. The closing adaptation omits particles and flashes to match the calm visual direction. These are adaptations of the cards, rather than pixel-identical reproductions. The published Gallery MP4 endpoint returned 404 on 2026-10-02. The installed recipe cards and exact TSX implementations are the available motion references; independent review must not claim a visual match to unavailable reference clips.
