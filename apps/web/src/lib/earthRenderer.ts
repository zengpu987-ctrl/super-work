import { earthSurfaceNormal, subsolarPoint } from "@super-work/core";

export type EarthGlobeMode = "hero" | "mini";

export interface EarthRenderer {
  update(mode: EarthGlobeMode, visible: boolean, size: number): void;
  rotateView(longitudeDelta: number, latitudeDelta: number): void;
  resetView(): void;
  dispose(): void;
}

const DAY_TEXTURE = "earth_atmos_2048.jpg";
const NIGHT_TEXTURE = "earth_lights_2048.png";
const CLOUD_TEXTURE = "earth_clouds_1024.jpg";
const OCEAN_TEXTURE = "earth_specular_2048.jpg";
const WGS84_FLATTENING = 1 / 298.257223563;
const ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vSurfaceNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vSurfaceNormal = normalize(mat3(modelMatrix) * normal);
    vec4 positionW = modelMatrix * vec4(position, 1.0);
    vWorldPosition = positionW.xyz;
    gl_Position = projectionMatrix * viewMatrix * positionW;
  }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uClouds;
  uniform sampler2D uOcean;
  uniform vec3 uSun;
  uniform vec3 uView;
  varying vec2 vUv;
  varying vec3 vSurfaceNormal;

  void main() {
    vec3 normal = normalize(vSurfaceNormal);
    float elevation = dot(normal, uSun);
    // The geometric terminator is elevation = 0. The disc spans about 0.53°.
    float halfSun = max(0.00465, 0.5 * fwidth(elevation));
    float disc = smoothstep(-halfSun, halfSun, elevation);
    float directLight = disc * max(elevation + 0.0015, 0.0);
    // An illustrative, blue-shifted twilight contribution, separate from direct sun.
    float twilight = smoothstep(-0.20791, 0.10, elevation);
    float directOrSky = 0.14 * twilight + 1.24 * directLight;

    vec3 albedo = texture2D(uDay, vUv).rgb;
    float ocean = texture2D(uOcean, vUv).r;
    float cloud = smoothstep(0.04, 0.77, texture2D(uClouds, vUv).r);
    vec3 night = vec3(0.0017, 0.0039, 0.0090) + albedo * vec3(0.016, 0.026, 0.047);
    vec3 ground = night + albedo * directOrSky;
    float lights = dot(texture2D(uNight, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
    ground += lights * vec3(0.62, 0.37, 0.16) * (1.0 - smoothstep(-0.15, -0.03, elevation));
    float sparkle = pow(max(dot(reflect(-uSun, normal), uView), 0.0), 65.0);
    ground += sparkle * directLight * ocean * vec3(0.22, 0.35, 0.46);

    vec3 cloudLight = vec3(0.60, 0.70, 0.78) * (0.028 + directOrSky);
    vec3 color = mix(ground, cloudLight, cloud * 0.58);

    float limb = pow(1.0 - max(dot(normal, uView), 0.0), 3.2);
    color += vec3(0.045, 0.17, 0.34) * limb * (0.055 + 0.32 * twilight + 0.47 * directLight);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uView;
  varying vec3 vSurfaceNormal;

  void main() {
    vec3 normal = normalize(vSurfaceNormal);
    float rim = pow(1.0 - abs(dot(normal, uView)), 4.0);
    float sunlit = smoothstep(-0.16, 0.42, dot(normal, uSun));
    float opacity = rim * (0.085 + 0.5 * sunlit);
    gl_FragColor = vec4(0.09, 0.35, 0.66, opacity);
    #include <colorspace_fragment>
  }
`;

const DEFAULT_VIEW_LATITUDE = 17;
const clampViewLatitude = (latitude: number): number => Math.max(-84, Math.min(84, latitude));
const wrapLongitude = (longitude: number): number => (((longitude + 180) % 360) + 360) % 360 - 180;
const angleDifference = (target: number, from: number): number => ((target - from + 540) % 360) - 180;

/** One canvas follows both slots. All light is calculated in geographic, Earth-fixed coordinates. */
export async function createEarthRenderer(canvas: HTMLCanvasElement): Promise<EarthRenderer> {
  const modulePath = `${import.meta.env.BASE_URL}vendor/three.module.js`;
  const THREE = await import(/* @vite-ignore */ modulePath);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const loader = new THREE.TextureLoader();
  const results = await Promise.allSettled([DAY_TEXTURE, NIGHT_TEXTURE, CLOUD_TEXTURE, OCEAN_TEXTURE].map(async (file) => {
    const texture = await loader.loadAsync(`${import.meta.env.BASE_URL}earth/${file}`);
    texture.colorSpace = file === OCEAN_TEXTURE ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    return texture;
  }));
  const textures = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (textures.length !== results.length) {
    textures.forEach((texture) => texture.dispose());
    renderer.dispose();
    throw new Error("Unable to load the bundled earth maps");
  }
  const [day, night, clouds, ocean] = textures;

  // SphereGeometry samples conventional north-up, west-to-east equirectangular maps.
  // Its normals already encode geodetic latitude; move the vertices onto WGS84
  // without changing those normals so the terminator is still n · sun = 0.
  const globeGeometry = (radius: number, segments: number, rings: number) => {
    const geometry = new THREE.SphereGeometry(1, segments, rings);
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i += 1) {
      const latitudeComponent = positions.getY(i);
      const curvature = radius / Math.sqrt(1 - ECCENTRICITY_SQUARED * latitudeComponent ** 2);
      positions.setXYZ(i, curvature * positions.getX(i),
        curvature * (1 - ECCENTRICITY_SQUARED) * latitudeComponent, curvature * positions.getZ(i));
    }
    return geometry;
  };

  const sun = { value: new THREE.Vector3() };
  const view = { value: new THREE.Vector3() };
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, 0.1, 20);
  const earthGeometry = globeGeometry(1, 128, 72);
  const earthMaterial = new THREE.ShaderMaterial({
    vertexShader, fragmentShader: earthFragment,
    uniforms: { uDay: { value: day }, uNight: { value: night }, uClouds: { value: clouds }, uOcean: { value: ocean }, uSun: sun, uView: view },
  });
  const atmosphereGeometry = globeGeometry(1.018, 96, 48);
  const atmosphereMaterial = new THREE.ShaderMaterial({
    vertexShader, fragmentShader: atmosphereFragment, uniforms: { uSun: sun, uView: view },
    side: THREE.BackSide, transparent: true, depthWrite: false, toneMapped: false,
  });
  scene.add(new THREE.Mesh(earthGeometry, earthMaterial));
  scene.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial));

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let mode: EarthGlobeMode = "hero";
  let visible = false;
  let requestedSize = 0;
  let renderSize = 0;
  let frame = 0;
  let timer = 0;
  let lastRender = 0;
  let isAnimating = false;
  let longitude: number | undefined;
  let latitude = DEFAULT_VIEW_LATITUDE;
  let manualView: { longitude: number; latitude: number } | undefined;
  let solarSecond = -1;
  let solarLongitude = 0;

  function cancel(): void {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    frame = 0;
    timer = 0;
    lastRender = 0;
  }

  function request(): void {
    if (!visible || document.hidden || frame !== 0) return;
    window.clearTimeout(timer);
    timer = 0;
    frame = window.requestAnimationFrame(draw);
  }

  function draw(now: number): void {
    frame = 0;
    if (!visible || document.hidden) return;
    if (mode === "mini" && lastRender > 0 && now - lastRender < 1000 / 32) {
      request();
      return;
    }
    const delta = lastRender > 0 ? Math.min((now - lastRender) / 1000, 0.08) : 1 / 30;
    lastRender = now;

    const utc = Date.now();
    const second = Math.floor(utc / 1000);
    if (second !== solarSecond) {
      solarSecond = second;
      const point = subsolarPoint(new Date(utc));
      const direction = earthSurfaceNormal(point.latitude, point.longitude);
      sun.value.set(direction.x, direction.y, direction.z);
      solarLongitude = point.longitude;
    }

    const targetLongitude = manualView?.longitude ?? solarLongitude + 55;
    const targetLatitude = manualView?.latitude ?? DEFAULT_VIEW_LATITUDE;
    longitude ??= targetLongitude;
    const ease = 1 - Math.exp(-7 * delta);
    if (reducedMotion.matches) {
      longitude = targetLongitude;
      latitude = targetLatitude;
      isAnimating = false;
    } else if (mode === "mini") {
      // The miniature orbits the view, never speeds up the physical solar clock.
      longitude -= 16 * delta;
      latitude += (DEFAULT_VIEW_LATITUDE - latitude) * ease;
      isAnimating = true;
    } else {
      const longitudeGap = angleDifference(targetLongitude, longitude);
      const latitudeGap = targetLatitude - latitude;
      isAnimating = Math.abs(longitudeGap) > 0.08 || Math.abs(latitudeGap) > 0.08;
      longitude += isAnimating ? longitudeGap * ease : longitudeGap;
      latitude += isAnimating ? latitudeGap * ease : latitudeGap;
    }
    longitude = wrapLongitude(longitude);

    const position = earthSurfaceNormal(latitude, longitude);
    view.value.set(position.x, position.y, position.z);
    camera.position.copy(view.value).multiplyScalar(4);
    camera.lookAt(0, 0, 0);

    if (requestedSize !== renderSize && requestedSize > 0) {
      renderSize = requestedSize;
      renderer.setSize(renderSize, renderSize, false);
    }
    renderer.render(scene, camera);
    if (isAnimating) request();
    else timer = window.setTimeout(request, 1000);
  }

  function resume(): void {
    cancel();
    request();
  }

  document.addEventListener("visibilitychange", resume);
  reducedMotion.addEventListener("change", resume);

  return {
    update(nextMode, nextVisible, size) {
      const pixels = Math.max(44, Math.round(size * Math.min(window.devicePixelRatio || 1, 2)));
      if (nextMode === mode && nextVisible === visible && pixels === requestedSize) return;
      mode = nextMode;
      visible = nextVisible;
      requestedSize = pixels;
      resume();
    },
    rotateView(longitudeDelta, latitudeDelta) {
      if (mode !== "hero" || !visible) return;
      // Only the camera moves. The Earth-fixed light direction is updated from UTC in draw().
      longitude = wrapLongitude((longitude ?? solarLongitude + 55) + longitudeDelta);
      latitude = clampViewLatitude(latitude + latitudeDelta);
      manualView = { longitude, latitude };
      request();
    },
    resetView() {
      if (mode !== "hero" || !visible) return;
      manualView = undefined;
      request();
    },
    dispose() {
      visible = false;
      cancel();
      document.removeEventListener("visibilitychange", resume);
      reducedMotion.removeEventListener("change", resume);
      earthGeometry.dispose();
      atmosphereGeometry.dispose();
      earthMaterial.dispose();
      atmosphereMaterial.dispose();
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
    },
  };
}
