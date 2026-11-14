// 게임 화면 효과음 (INT-29). 소리 파일 없이 WebAudio로 짧은 나무·징 소리를 만든다.
// 켜고 끄기는 이 브라우저에만 기억한다(저장이 막혀도 소리는 켠 상태로 시작한다).
import { useCallback, useState } from 'react';

export type StageSound = 'tap' | 'open' | 'close' | 'confirm';

const KEY = 'opensamguk.stage.sound';
let context: AudioContext | null = null;

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeEnabled(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // 저장이 막힌 브라우저: 이번 화면에서만 기억한다.
  }
}

// 음 하나: 주파수에서 끝 주파수로 미끄러지며 짧게 사라진다.
function tone(ctx: AudioContext, at: number, from: number, to: number, length: number, type: OscillatorType, volume: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

export function playStageSound(kind: StageSound) {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return;
  try {
    context ??= new AudioContext();
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    if (kind === 'tap') tone(ctx, t, 760, 520, 0.07, 'triangle', 0.05);
    else if (kind === 'open') {
      tone(ctx, t, 420, 560, 0.09, 'triangle', 0.045);
      tone(ctx, t + 0.06, 630, 840, 0.1, 'triangle', 0.035);
    } else if (kind === 'close') tone(ctx, t, 560, 360, 0.1, 'triangle', 0.04);
    else {
      // 확정: 작은 징
      tone(ctx, t, 330, 320, 0.45, 'sine', 0.05);
      tone(ctx, t, 660, 650, 0.3, 'sine', 0.02);
    }
  } catch {
    // 소리를 낼 수 없는 환경이면 조용히 넘어간다.
  }
}

export function useStageSound() {
  const [enabled, setEnabled] = useState(readEnabled);
  const play = useCallback(
    (kind: StageSound) => {
      if (enabled) playStageSound(kind);
    },
    [enabled],
  );
  const toggle = useCallback(() => {
    setEnabled((on) => {
      writeEnabled(!on);
      if (!on) playStageSound('tap');
      return !on;
    });
  }, []);
  return { enabled, play, toggle };
}
