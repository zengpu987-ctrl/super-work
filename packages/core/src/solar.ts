/**
 * 太阳位置（NOAA 近似算法）——用于地球模型的实时昼夜线。
 *
 * 输入任意时刻，输出「日下点」：太阳直射点的纬度（赤纬）与经度（东经为正）。
 * 采用 UTC 近似地球自转时刻，不依赖网络；用于可视化，不替代精密星历。
 *
 * 参考：NOAA Solar Calculator / Astronomical Algorithms (Meeus) 的常用简化式。
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface SubsolarPoint {
  /** 太阳直射点纬度（度），北为正 */
  latitude: number;
  /** 太阳直射点经度（度），东经为正；范围 (-180, 180] */
  longitude: number;
  /** 太阳赤纬（度），与 latitude 相同 */
  declination: number;
  /** 均时差（分钟） */
  equationOfTime: number;
  /** UTC 小时（0-24） */
  utcHours: number;
}

function normalizeLongitude(value: number): number {
  let lon = value % 360;
  if (lon > 180) lon -= 360;
  if (lon <= -180) lon += 360;
  return lon;
}

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/** 计算某一时刻的太阳直射点（日下点）。 */
export function subsolarPoint(date: Date): SubsolarPoint {
  const jd = julianDay(date);
  const T = (jd - 2_451_545.0) / 36_525;

  // 太阳几何平黄经与平近点角
  const L0 = (280.46646 + T * (36_000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35_999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // 中心差 → 真黄经 → 视黄经（含章动修正）
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const trueLongitude = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  // 平黄赤交角 → 真黄赤交角
  const meanObliquity =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);

  const declination =
    Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD)) * DEG;

  // 括号内是弧度；转成度后，每度乘 4 分钟。
  const y = Math.tan((obliquity * RAD) / 2) ** 2;
  const equationOfTime =
    4 * DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));

  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3_600_000;
  const longitude = normalizeLongitude(180 - (utcHours * 60 + equationOfTime) / 4);

  return {
    latitude: declination,
    longitude,
    declination,
    equationOfTime,
    utcHours,
  };
}

/** 地固单位法线：+Y 指北，+X 是本初子午线，东经 90° 指向 −Z。
 * 这与 Three.js SphereGeometry 的标准等距圆柱地图 UV 一致。
 */
export function earthSurfaceNormal(latitude: number, longitude: number): { x: number; y: number; z: number } {
  const lat = latitude * RAD;
  const lon = longitude * RAD;
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.sin(lat),
    z: -Math.cos(lat) * Math.sin(lon),
  };
}

/** 地固坐标系中指向太阳的单位向量。 */
export function sunDirection(date: Date): { x: number; y: number; z: number } {
  const { latitude, longitude } = subsolarPoint(date);
  return earthSurfaceNormal(latitude, longitude);
}
