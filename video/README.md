# Hearsay launch film

"The conversation you never see" is a 51-second film about researching how AI answers a buyer's question. It follows a fictional meeting-notes product through a reviewed question, a saved answer and its evidence, a proposed change, and a later observation. See [the brief](BRIEF.md) for the story, claim sources, visual direction, and shot mapping.

The Remotion package lives here so Hearsay's runtime keeps its zero-dependency setup. The film source uses the repository's MIT license. Third-party fonts and audio have their own licenses, recorded in [ASSETS.md](ASSETS.md).

From this directory, with Node 22.13 or newer:

```sh
npm ci
npm run dev
npm run lint
npm run render
npm run render:nobgm
npm run qa
npm run preview:gif
```

The two exports are `out/hearsay-launch.mp4` and `out/hearsay-launch-nobgm.mp4`. Both use the same 1920×1080, 30fps timeline. The second retains sound effects. `npm run qa` decodes the finished film, checks its dimensions, frame count, and audio peak, and saves frames and a technical report in `out/qa/`. It uses the bundled FFmpeg on Linux; `FFMPEG` and `FFPROBE` can select other installed binaries.

The delivered film is [docs/hearsay-launch.mp4](../docs/hearsay-launch.mp4), with [a version without music](../docs/hearsay-launch-nobgm.mp4). Source timing, copy, and sound cues are in `src/timeline.ts`.

GitHub strips HTML video tags from README content. The README instead embeds `docs/hearsay-preview.gif`, a silent 14-second loop of the opening story at 640×360 and 8fps. Clicking it opens the [browser player](https://melonwer.github.io/hearsay/) for the full film with sound. `npm run preview:gif` regenerates the GIF from the delivered MP4. Viewer animation settings can pause it.

The browser player is `docs/index.html`. GitHub Pages serves the `docs/` directory on `main`; `.nojekyll` keeps it a plain static site. The page includes a quick workflow overview, a Return to Repo link, and the assistant quickstart. The player uses native video controls, supports inline mobile playback, and starts loading the MP4 when the viewer presses Play. Its lightweight `docs/film-poster.webp` comes from the film's opening; the original poster remains preserved.

## Captures and accuracy

`public/captures/` contains actual Hearsay UI screenshots from a separate temporary fictional demo workspace. Its `fixture.json`, `measurement-fixture.json`, `layout.json`, and `provenance.json` retain the inputs and origin. No live agent, provider, web search, buyer conversation, or website experiment was performed. The demo is visibly labeled in the film. The later comparison is an illustration and claims no improvement or sales effect.

To capture fresh screenshots:

```sh
npx playwright install chromium
npm run capture
```

The script uses installed Google Chrome on this Linux host when available, or Playwright's Chromium. `CHROME_EXECUTABLE` can select another browser. New captures use the current date so they remain in the dashboard's observation window. The stored screenshots remain fixed inputs for deterministic rendering. Capture outputs replace matching files; preserve copies before refreshing inputs for a film revision.

## Visual editor

Video Shotcraft was installed from the author's AtomGit mirror at revision `5ddbf521038b0a7accfb6dc1e0a9eb29c67277ab`; the requested GitHub source returned 404. Its local workbench dependencies were aligned to Remotion 4.0.532, with `@remotion/media` added.

```sh
node /home/d4ydy/.codex/skills/video-shotcraft/workbench/scripts/open.mjs /home/d4ydy/Projects/repos/hearsay/video
```

Open `http://localhost:5198/?import=project` to edit shot timing, headline copy, and sound. Music is a separate "Music bed" clip to preserve its trim and fades. `src/workbench.ts` imports the film's timing and copy rather than maintaining another timeline. The workbench's `npm run parity` compares the imported composition against the original.

Video Shotcraft also supports exporting a Jianying project for further editing. Its Gallery's published preview clips were unavailable during production; the local recipe cards and exact TSX demo sources supplied the motion references.
