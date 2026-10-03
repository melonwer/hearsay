export const FPS = 30;
export const BPM = 122;
export const beatFrame = (beat: number) => Math.round(beat * FPS * 60 / BPM);
const shot = (beat: number, beats: number) => ({from: beatFrame(beat), duration: beatFrame(beat + beats) - beatFrame(beat)});
export const SHOTS = {
  built: shot(0, 10),
  buyer: shot(10, 12),
  question: shot(22, 8),
  agent: shot(30, 14),
  evidence: shot(44, 16),
  change: shot(60, 16),
  repeat: shot(76, 14),
  outro: shot(90, 14),
};
export const TOTAL = beatFrame(104);
export const COPY = {
  built: {title: 'You built\nsomething\nworth finding.'},
  buyer: {title: 'Then a buyer\nasks AI.'},
  question: {title: 'Would your\nname come up?'},
  agent: {title: 'Your agent.', subtitle: 'Use the agent\nyou already use.'},
  evidence: {title: 'Keep the answer.', subtitle: 'Follow the evidence.'},
  change: {title: 'Choose one change\nworth testing.'},
  repeat: {title: 'Ask again.', subtitle: 'Compare what was observed.'},
  outro: {title: 'Hearsay', subtitle: 'AI visibility research,\nwith a record you can inspect.'},
};
export const MUSIC = {from: 0, duration: TOTAL, src: 'audio/music.mp3', trimBefore: 252, volume: 0.17};
export const SFX = [
  {from: SHOTS.built.from + 18, duration: 55, src: 'audio/paper.mp3', volume: 0.24, action: 'Website card rises'},
  {from: SHOTS.buyer.from + 24, duration: 45, src: 'audio/whoosh.mp3', volume: 0.22, action: 'Buyer question enters'},
  {from: SHOTS.question.from + 32, duration: 25, src: 'audio/marker.mp3', volume: 0.3, action: 'Underline draws'},
  {from: SHOTS.agent.from + 32, duration: 35, src: 'audio/whoosh.mp3', volume: 0.17, action: 'Title becomes section label'},
  {from: SHOTS.agent.from + 68, duration: 30, src: 'audio/paper.mp3', volume: 0.16, action: 'Question sheet settles'},
  {from: SHOTS.evidence.from + 20, duration: 45, src: 'audio/paper.mp3', volume: 0.23, action: 'Saved answer comes into view'},
  {from: SHOTS.evidence.from + 120, duration: 32, src: 'audio/click.mp3', volume: 0.23, action: 'Camera focuses on evidence receipt'},
  {from: SHOTS.change.from + 26, duration: 45, src: 'audio/paper.mp3', volume: 0.23, action: 'Proposal is placed on the desk'},
  {from: SHOTS.change.from + 136, duration: 25, src: 'audio/marker.mp3', volume: 0.25, action: 'Review annotation'},
  {from: SHOTS.repeat.from + 48, duration: 55, src: 'audio/paper.mp3', volume: 0.22, action: 'Later observation arrives beside baseline'},
  {from: SHOTS.outro.from + 4, duration: 60, src: 'audio/whoosh.mp3', volume: 0.2, action: 'Elements reunite'},
  {from: SHOTS.outro.from + 42, duration: 70, src: 'audio/impact.mp3', volume: 0.22, action: 'Hearsay wordmark lands'},
  {from: SHOTS.outro.from + 66, duration: 60, src: 'audio/shimmer.mp3', volume: 0.12, action: 'Closing rule and tagline'},
];
