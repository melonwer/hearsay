import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import {FPS, SHOTS} from '../src/timeline.ts';

if (!ffmpegPath) throw new Error('FFmpeg is unavailable on this platform.');
const start = .8;
const duration = SHOTS.agent.from / FPS - start;
const input = fileURLToPath(new URL('../../docs/hearsay-launch.mp4', import.meta.url));
const output = fileURLToPath(new URL('../../docs/hearsay-preview.gif', import.meta.url));
execFileSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(duration), '-i', input,
  '-filter_complex', '[0:v]fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  '-an', '-loop', '0', '-y', output,
], {stdio: 'inherit'});
console.log(`README preview saved to ${output}`);
