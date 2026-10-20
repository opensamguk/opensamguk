import styles from './ValueDelta.module.css';

// 변화량은 색과 부호를 함께 쓴다. 색만으로 의미를 전하지 않는다 (NFR-08).
export function ValueDelta({ value }: { value: number }) {
  const trend = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const text =
    value > 0 ? `+${value.toLocaleString('ko-KR')}` : value < 0 ? `−${Math.abs(value).toLocaleString('ko-KR')}` : '±0';
  return (
    <span className={`num ${styles[trend]}`} data-trend={trend}>
      {text}
    </span>
  );
}
