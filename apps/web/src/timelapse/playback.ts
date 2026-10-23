// 재생 위치와 재생 여부. 받은 프레임 수(count)와 더 받을 페이지가 있는지(hasMore)는 동작마다 넘겨받는다.
export interface PlaybackState {
  index: number;
  playing: boolean;
}

export type PlaybackAction =
  | { type: 'first' }
  | { type: 'prev' }
  | { type: 'next'; count: number }
  | { type: 'seek'; index: number; count: number }
  | { type: 'toggle'; count: number; hasMore: boolean }
  | { type: 'tick'; count: number; hasMore: boolean };

export const initialPlayback: PlaybackState = { index: 0, playing: false };

const clamp = (index: number, count: number) => Math.max(0, Math.min(count - 1, index));

// 이전·다음·위치 조작은 재생을 멈춘다. 끝에서 더 받을 것이 있으면 그 자리에서 기다리고 없으면 멈춘다.
export function playback(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'first':
      return { index: 0, playing: false };
    case 'prev':
      return { index: Math.max(0, state.index - 1), playing: false };
    case 'next':
      return { index: clamp(state.index + 1, action.count), playing: false };
    case 'seek':
      return { index: clamp(action.index, action.count), playing: false };
    case 'toggle':
      if (state.playing) return { ...state, playing: false };
      if (action.count === 0) return state;
      if (state.index >= action.count - 1 && !action.hasMore) return { index: 0, playing: true };
      return { ...state, playing: true };
    case 'tick':
      if (!state.playing) return state;
      if (state.index < action.count - 1) return { ...state, index: state.index + 1 };
      return action.hasMore ? state : { ...state, playing: false };
  }
}

// 재생 중인데 받은 마지막 달에서 다음 페이지를 기다리는지.
export const isWaiting = (state: PlaybackState, count: number, hasMore: boolean) =>
  state.playing && hasMore && state.index >= count - 1;
