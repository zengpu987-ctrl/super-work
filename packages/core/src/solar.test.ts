import assert from "node:assert/strict";
import { test } from "node:test";
import { earthSurfaceNormal, subsolarPoint, sunDirection } from "./solar.js";

const at = (iso: string): Date => new Date(iso);

test("太阳位置：春分 12:00 UTC 日下点在赤道、本初子午线附近", () => {
  const point = subsolarPoint(at("2026-03-20T12:00:00Z"));
  assert.ok(Math.abs(point.latitude) < 0.6, `declination=${point.latitude}`);
  assert.ok(Math.abs(point.longitude - 1.85) < 0.15, `longitude=${point.longitude}`);
});

test("太阳位置：夏至 / 冬至赤纬约 ±23.44°", () => {
  const june = subsolarPoint(at("2026-06-21T12:00:00Z"));
  const december = subsolarPoint(at("2026-12-21T12:00:00Z"));
  assert.ok(june.latitude > 23.2 && june.latitude < 23.6, `june=${june.latitude}`);
  assert.ok(december.latitude < -23.2 && december.latitude > -23.6, `dec=${december.latitude}`);
});

test("太阳位置：日下点每小时西移约 15°", () => {
  const a = subsolarPoint(at("2026-03-20T06:00:00Z"));
  const b = subsolarPoint(at("2026-03-20T07:00:00Z"));
  let delta = a.longitude - b.longitude;
  if (delta < 0) delta += 360;
  assert.ok(Math.abs(delta - 15) < 0.2, `delta=${delta}`);
});

test("太阳位置：日下点经度始终在 (-180, 180]", () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const point = subsolarPoint(at(`2026-11-19T${String(hour).padStart(2, "0")}:00:00Z`));
    assert.ok(point.longitude > -180 && point.longitude <= 180, `hour=${hour} lon=${point.longitude}`);
  }
});

test("太阳位置：均时差按分钟换算，二月约 -14 分钟，十一月约 +16 分钟", () => {
  const feb = subsolarPoint(at("2026-02-11T12:00:00Z"));
  const nov = subsolarPoint(at("2026-11-03T12:00:00Z"));
  assert.ok(Math.abs(feb.equationOfTime + 14.2) < 0.2);
  assert.ok(Math.abs(nov.equationOfTime - 16.45) < 0.2);
  assert.ok(Math.abs(feb.longitude - 3.55) < 0.1);
  assert.ok(Math.abs(nov.longitude + 4.11) < 0.1);
});

test("地固光照：上午直射点在东经，直射点法线迎光，对跖点和晨昏线分别为 −1 和 0", () => {
  const time = at("2026-03-20T06:00:00Z");
  const { latitude, longitude } = subsolarPoint(time);
  const sun = sunDirection(time);
  assert.ok(sun.z < -0.99, "东经 +90° 对应 Three.js −Z");
  const dot = ({ x, y, z }: ReturnType<typeof earthSurfaceNormal>) => x * sun.x + y * sun.y + z * sun.z;
  assert.ok(Math.abs(dot(earthSurfaceNormal(latitude, longitude)) - 1) < 1e-12);
  assert.ok(Math.abs(dot(earthSurfaceNormal(-latitude, longitude + 180)) + 1) < 1e-12);
  assert.ok(Math.abs(dot(earthSurfaceNormal(0, longitude + 90))) < 1e-12);
});

test("夏至和冬至的极昼、极夜方向互换", () => {
  assert.ok(sunDirection(at("2026-06-21T00:00:00Z")).y > 0.39);
  assert.ok(sunDirection(at("2026-12-21T00:00:00Z")).y < -0.39);
});
