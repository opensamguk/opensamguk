export interface MapView {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MapTapTarget extends MapView {
  key: number;
  anchorX: number;
  anchorY: number;
}

// 실제 표시 좌표는 그대로 두고 누르는 영역만 화면 안에 둔다.
export function mapTapTargets(
  sites: readonly { key: number; x: number; y: number }[],
  view: MapView,
  frame: { width: number; height: number },
): MapTapTarget[] {
  if (
    ![view.x, view.y, view.width, view.height, frame.width, frame.height].every(Number.isFinite) ||
    view.width <= 0 ||
    view.height <= 0 ||
    frame.width < 46 ||
    frame.height < 46
  )
    return [];
  const size = 46 * Math.max(view.width / frame.width, view.height / frame.height);
  if (size > view.width || size > view.height) return [];
  return sites.flatMap((site) => {
    if (
      !Number.isFinite(site.x) ||
      !Number.isFinite(site.y) ||
      site.x < view.x ||
      site.x > view.x + view.width ||
      site.y < view.y ||
      site.y > view.y + view.height
    )
      return [];
    return [
      {
        key: site.key,
        anchorX: site.x,
        anchorY: site.y,
        x: Math.max(view.x, Math.min(view.x + view.width - size, site.x - size / 2)),
        y: Math.max(view.y, Math.min(view.y + view.height - size, site.y - size / 2)),
        width: size,
        height: size,
      },
    ];
  });
}

export function tapCandidates(targets: readonly MapTapTarget[], point: { x: number; y: number }): number[] {
  return targets
    .filter(
      (target) =>
        point.x >= target.x &&
        point.x <= target.x + target.width &&
        point.y >= target.y &&
        point.y <= target.y + target.height,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.anchorX - point.x, a.anchorY - point.y) - Math.hypot(b.anchorX - point.x, b.anchorY - point.y),
    )
    .map((target) => target.key);
}
