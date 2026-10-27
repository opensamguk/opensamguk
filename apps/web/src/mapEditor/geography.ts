import basemap from './geodata/natural-earth.json';
export { basemap };
// Plate carree in WGS84; identical degree scale on both axes, independent of game movement.
export function projectGeographicPoint(longitude: number, latitude: number) {
  const [west, south, east, north] = basemap.bounds as [number, number, number, number];
  return {
    x: Math.round(((longitude - west) / (east - west)) * 1000),
    y: Math.round(((north - latitude) / (north - south)) * 700),
  };
}
export function unprojectGeographicPoint(x: number, y: number) {
  const [west, south, east, north] = basemap.bounds as [number, number, number, number];
  return { longitude: west + (x / 1000) * (east - west), latitude: north - (y / 700) * (north - south) };
}
