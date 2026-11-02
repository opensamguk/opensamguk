import { describe, expect, it } from 'vitest';
import { externalOrigin } from '../e2e/imageRequestPolicy';
import { PUBLIC_IMAGES } from '../packages/shared/src/publicImages';
import toolImages from '../packages/shared/src/toolImageCatalog.json' with { type: 'json' };

const APP_HOST = 'localhost:5173';
const RAW = 'https://raw.githubusercontent.com';
const approved = PUBLIC_IMAGES[0]!.url;
const githack = PUBLIC_IMAGES.find((image) => image.url.startsWith('https://rawcdn.githack.com/'))!.url;
const judge = (url: string, resourceType = 'image') => externalOrigin({ url, resourceType }, APP_HOST);

describe('조약 화면 시험의 외부 요청 판정', () => {
  it('앱 출처와 웹 밖 프로토콜은 기존처럼 외부로 세지 않는다', () => {
    expect(judge('http://localhost:5173/trpc/home.get', 'fetch')).toBeNull();
    expect(judge('ws://localhost:5173/sse', 'websocket')).toBeNull();
    expect(judge('data:image/png;base64,AAAA')).toBeNull();
    expect(judge('blob:http://localhost:5173/x')).toBeNull();
  });

  it('승인 이미지 97개의 고정 주소를 이미지로 읽을 때만 허용한다', () => {
    expect(PUBLIC_IMAGES).toHaveLength(97);
    for (const image of PUBLIC_IMAGES) expect(judge(image.url)).toBeNull();
  });

  it('같은 주소라도 이미지가 아닌 요청은 외부다', () => {
    for (const type of ['script', 'fetch', 'xhr', 'stylesheet', 'document', 'other'])
      expect(judge(approved, type)).toBe(RAW);
    expect(judge(githack, 'fetch')).toBe('https://rawcdn.githack.com');
  });

  it('query·조각·다른 커밋·접두 경로는 승인 주소와 정확히 같지 않아 외부다', () => {
    expect(judge(`${approved}?v=1`)).toBe(RAW);
    expect(judge(`${approved}#x`)).toBe(RAW);
    expect(judge(approved.replace(/\/[0-9a-f]{40}\//, `/${'0'.repeat(40)}/`))).toBe(RAW);
    expect(judge(approved.slice(0, approved.lastIndexOf('/') + 1))).toBe(RAW);
    expect(judge(`${approved.slice(0, approved.lastIndexOf('/') + 1)}other.png`)).toBe(RAW);
    expect(judge(approved.replace('https:', 'http:'))).toBe('http://raw.githubusercontent.com');
  });

  it('원작 초상과 개발 도구 이미지 11개는 승인 목록 밖이라 외부다', () => {
    expect(judge(`${RAW}/opensamguk/opensamguk-images/48163bd1ce8d54c54c94fb5484b05f9db9e50c62/portraits/1.jpg`)).toBe(
      RAW,
    );
    expect(toolImages).toHaveLength(11);
    for (const image of toolImages) expect(judge(image.url)).toBe(RAW);
  });

  it('승인 목록에 없는 외부 출처는 종류와 관계없이 외부다', () => {
    expect(judge('https://example.com/a.png')).toBe('https://example.com');
    expect(judge('https://example.com/api', 'fetch')).toBe('https://example.com');
  });
});
