import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {COLORS, progress} from './visuals';

export type CameraKey = {frame: number; cx: number; cy: number; zoom: number; rotX: number; rotY: number; rotZ: number};
export const PageCam: React.FC<React.PropsWithChildren<{src: string; pageH: number; keys: [CameraKey, ...CameraKey[]]}>> = ({src, pageH, keys, children}) => {
  const frame = useCurrentFrame();
  const first = keys[0];
  const camera = keys.reduce((current, key, i) => {
    const previous = keys[i - 1] ?? first;
    if (i === 0 || frame < previous.frame) return current;
    const t = previous.frame === key.frame ? 1 : progress(frame, previous.frame, key.frame);
    const mix = (a: number, b: number) => a + (b - a) * t;
    return {frame, cx: mix(previous.cx, key.cx), cy: mix(previous.cy, key.cy), zoom: mix(previous.zoom, key.zoom), rotX: mix(previous.rotX, key.rotX), rotY: mix(previous.rotY, key.rotY), rotZ: mix(previous.rotZ, key.rotZ)};
  }, first);
  return <AbsoluteFill style={{overflow: 'hidden', background: COLORS.page, perspective: `${1600 * camera.zoom}px`, perspectiveOrigin: '960px 540px'}}>
    <div style={{position: 'absolute', width: 1920, height: pageH, zoom: camera.zoom, transform: `translate(${960 / camera.zoom - camera.cx}px, ${540 / camera.zoom - camera.cy}px) rotateY(${camera.rotY}deg) rotateX(${camera.rotX}deg) rotateZ(${camera.rotZ}deg)`, transformOrigin: `${camera.cx}px ${camera.cy}px`, transformStyle: 'preserve-3d'}}>
      <Img src={staticFile(src)} style={{width: 1920, height: pageH, position: 'absolute'}} />{children}
    </div>
  </AbsoluteFill>;
};
