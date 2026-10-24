import { EXPORT_SCALE, type DrawOp, type PngDrawing } from './export';

// frameDrawing의 크기와 명령을 캔버스에 옮겨 PNG로 받고 내려받게 한다. 브라우저에서만 돈다 (docs/plans/T4-37.md 2.2).
// 글꼴은 화면과 같은 --font-sans(Pretendard)다. 글자를 그리기 전에 글꼴을 다 불러왔는지 기다린다.

function fontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim();
  return value === '' ? 'sans-serif' : value;
}

function draw(context: CanvasRenderingContext2D, ops: readonly DrawOp[], family: string) {
  for (const op of ops) {
    context.save();
    if (op.kind === 'rect') {
      context.fillStyle = op.fill;
      context.fillRect(op.x, op.y, op.w, op.h);
      if (op.stroke) {
        context.strokeStyle = op.stroke;
        context.lineWidth = 1;
        context.strokeRect(op.x + 0.5, op.y + 0.5, op.w - 1, op.h - 1);
      }
    } else if (op.kind === 'line') {
      context.strokeStyle = op.stroke;
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(op.x1, op.y1);
      context.lineTo(op.x2, op.y2);
      context.stroke();
    } else if (op.kind === 'circle') {
      context.beginPath();
      context.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      if (op.fill !== null) {
        context.fillStyle = op.fill;
        context.fill();
      }
      context.setLineDash(op.dashed ? [2, 2] : []);
      context.strokeStyle = op.stroke;
      context.lineWidth = 1;
      context.stroke();
    } else {
      context.fillStyle = op.color;
      context.font = `${op.weight} ${op.size}px ${family}`;
      context.textAlign = op.align;
      context.textBaseline = 'alphabetic';
      context.fillText(op.text, op.x, op.y, op.maxWidth);
    }
    context.restore();
  }
}

export async function renderPng({ width, height, ops }: PngDrawing): Promise<Blob> {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = width * EXPORT_SCALE;
  canvas.height = height * EXPORT_SCALE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('캔버스를 만들 수 없습니다.');
  context.scale(EXPORT_SCALE, EXPORT_SCALE);
  draw(context, ops, fontFamily());
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG를 만들지 못했습니다.'))), 'image/png');
  });
}

// 내려받기 링크를 잠깐 만들어 누른다. 주소는 바로 놓아 메모리에 남기지 않는다.
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // 같은 작업 안에서 놓으면 일부 브라우저가 내려받기를 시작하기 전에 주소가 사라진다.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function downloadPng(drawing: PngDrawing, fileName: string): Promise<void> {
  saveBlob(await renderPng(drawing), fileName);
}
