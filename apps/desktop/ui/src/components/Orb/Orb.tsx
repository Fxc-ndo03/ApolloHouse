import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { useAppStore } from '../../store';
import type { OrbState } from '../../store';
import { theme } from '../../theme';

interface OrbProps {
  width: number;
  height: number;
}

interface OrbParams {
  breathe: number;
  breatheSpeed: number;
  jitter: number;
  waveAmp: number;
  waveSpeed: number;
  rotate: number;
  brightness: number;
  tint: string;
  tintMix: number;
}

type OrbMode = OrbState['state'];

const COUNT = 2800;
const RADIUS = 1.0;

const TARGETS: Record<OrbMode, OrbParams> = {
  idle: {
    breathe: 0.05, breatheSpeed: 0.9, jitter: 0.01, waveAmp: 0,
    waveSpeed: 5, rotate: 0.12, brightness: 1.0,
    tint: theme.color.primary, tintMix: 0,
  },
  listening: {
    breathe: 0.03, breatheSpeed: 2.4, jitter: 0.055, waveAmp: 0,
    waveSpeed: 5, rotate: 0.3, brightness: 1.3,
    tint: theme.color.primarySoft, tintMix: 0,
  },
  thinking: {
    breathe: 0.04, breatheSpeed: 1.4, jitter: 0.028, waveAmp: 0,
    waveSpeed: 5, rotate: 1.5, brightness: 1.15,
    tint: theme.color.primary, tintMix: 0,
  },
  speaking: {
    breathe: 0.05, breatheSpeed: 3.2, jitter: 0.02, waveAmp: 0.2,
    waveSpeed: 6, rotate: 0.45, brightness: 1.4,
    tint: theme.color.primarySoft, tintMix: 0,
  },
  confirming: {
    breathe: 0.09, breatheSpeed: 1.8, jitter: 0.015, waveAmp: 0,
    waveSpeed: 5, rotate: 0.2, brightness: 1.25,
    tint: theme.color.primarySoft, tintMix: 0,
  },
  focusing: {
    breathe: 0.04, breatheSpeed: 0.7, jitter: 0.008, waveAmp: 0,
    waveSpeed: 5, rotate: 0.08, brightness: 0.95,
    tint: theme.color.primary, tintMix: 0,
  },
  alarm: {
    breathe: 0.12, breatheSpeed: 5.0, jitter: 0.04, waveAmp: 0.1,
    waveSpeed: 8, rotate: 0.8, brightness: 1.3,
    tint: theme.color.danger, tintMix: 1,
  },
  error: {
    breathe: 0.08, breatheSpeed: 2.8, jitter: 0.035, waveAmp: 0,
    waveSpeed: 5, rotate: 0.3, brightness: 1.2,
    tint: theme.color.danger, tintMix: 1,
  },
};

const VERTEX_SHADER = /* glsl */ `
  attribute float aScale;
  attribute float aPhase;
  attribute float aRadiusN;
  attribute float aTwinkle;
  attribute float aAlpha;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uBreathe;
  uniform float uBreatheSpeed;
  uniform float uJitter;
  uniform float uWaveAmp;
  uniform float uWaveSpeed;
  uniform float uWaveFreq;
  uniform float uBrightness;
  uniform vec3 uTint;
  uniform float uTintMix;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float breathe = 1.0 + uBreathe * sin(uTime * uBreatheSpeed);
    vec3 p = position * breathe;

    vec3 jitter = vec3(
      sin(uTime * (6.0 + aTwinkle * 4.0) + aPhase),
      sin(uTime * (7.0 + aTwinkle * 5.0) + aPhase * 1.7),
      cos(uTime * (5.0 + aTwinkle * 3.0) + aPhase * 0.6)
    ) * uJitter;
    p += jitter;

    vec3 dir = normalize(position);
    float wave = sin(aRadiusN * uWaveFreq - uTime * uWaveSpeed) * uWaveAmp;
    p += dir * wave;

    vec3 core = vec3(0.965, 0.953, 1.0);
    vec3 mid = vec3(0.655, 0.545, 0.98);
    vec3 edge = vec3(0.545, 0.361, 0.965);
    vec3 base = mix(core, mid, smoothstep(0.0, 0.45, aRadiusN));
    base = mix(base, edge, smoothstep(0.35, 1.0, aRadiusN));

    float glow = 1.0 - aRadiusN;
    vec3 tinted = uTint * (0.45 + 0.75 * glow);
    vColor = mix(base, tinted, uTintMix) * uBrightness;
    vAlpha = aAlpha * (1.0 - aRadiusN * 0.35);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aScale * uSize * uPixelRatio * (420.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.04, d);
    a *= a;
    gl_FragColor = vec4(vColor, a * vAlpha);
  }
`;

export function Orb({ width, height }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { state, caption } = useAppStore((s) => s.orbState);
  const modeRef = useRef<OrbMode>(state);
  modeRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.z = 2.6;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(COUNT * 3);
    const scales = new Float32Array(COUNT);
    const phases = new Float32Array(COUNT);
    const radiusN = new Float32Array(COUNT);
    const twinkles = new Float32Array(COUNT);
    const alphas = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const rad = Math.pow(Math.random(), 2.2);
      positions[i * 3] = RADIUS * rad * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = RADIUS * rad * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = RADIUS * rad * Math.cos(phi);

      const coreBoost = rad < 0.25 ? 1.7 : 1.0;
      scales[i] = (0.5 + Math.random() * 1.0) * coreBoost;
      phases[i] = Math.random() * Math.PI * 2;
      radiusN[i] = rad;
      twinkles[i] = 0.5 + Math.random();
      alphas[i] = 0.35 + Math.random() * 0.45;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aRadiusN', new THREE.BufferAttribute(radiusN, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkles, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uSize: { value: 0.016 },
        uBreathe: { value: TARGETS.idle.breathe },
        uBreatheSpeed: { value: TARGETS.idle.breatheSpeed },
        uJitter: { value: TARGETS.idle.jitter },
        uWaveAmp: { value: 0 },
        uWaveSpeed: { value: 6 },
        uWaveFreq: { value: 9 },
        uBrightness: { value: 1 },
        uTint: { value: new THREE.Color(theme.color.primary) },
        uTintMix: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    const cluster = new THREE.Points(geometry, material);
    scene.add(cluster);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      1.2,
      0.55,
      0.0,
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const cur = { ...TARGETS.idle, tintMix: 0 };
    const tintCur = new THREE.Color(theme.color.primary);
    const tintTarget = new THREE.Color(theme.color.primary);
    const clock = new THREE.Clock();
    let frameId = 0;

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.getElapsedTime();
      const target = TARGETS[modeRef.current] ?? TARGETS.idle;

      const k = 1 - Math.exp(-delta * 4);
      cur.breathe += (target.breathe - cur.breathe) * k;
      cur.breatheSpeed += (target.breatheSpeed - cur.breatheSpeed) * k;
      cur.jitter += (target.jitter - cur.jitter) * k;
      cur.waveAmp += (target.waveAmp - cur.waveAmp) * k;
      cur.waveSpeed += (target.waveSpeed - cur.waveSpeed) * k;
      cur.rotate += (target.rotate - cur.rotate) * k;
      cur.brightness += (target.brightness - cur.brightness) * k;
      cur.tintMix += (target.tintMix - cur.tintMix) * k;
      tintTarget.set(target.tint);
      tintCur.lerp(tintTarget, k);

      const u = material.uniforms;
      u.uTime.value = elapsed;
      u.uBreathe.value = cur.breathe;
      u.uBreatheSpeed.value = cur.breatheSpeed;
      u.uJitter.value = cur.jitter;
      u.uWaveAmp.value = cur.waveAmp;
      u.uWaveSpeed.value = cur.waveSpeed;
      u.uBrightness.value = cur.brightness;
      u.uTintMix.value = cur.tintMix;
      (u.uTint.value as THREE.Color).copy(tintCur);

      cluster.rotation.y += cur.rotate * delta;
      cluster.rotation.x += cur.rotate * delta * 0.35;

      composer.render();
    };

    animate();

    const handleResize = () => {
      const w = wrap.clientWidth || width;
      const h = wrap.clientHeight || height;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      composer.setSize(w, h);
      material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(wrap);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [width, height]);

  const dotColor =
    state === 'idle'
      ? theme.color.textFaint
      : state === 'error' || state === 'alarm'
        ? theme.color.danger
        : theme.color.primarySoft;

  return (
    <div
      ref={wrapRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        borderRadius: '50%',
        overflow: 'hidden',
        background: '#000000',
        boxShadow: '0 0 64px rgba(139, 92, 246, 0.35), 0 0 24px rgba(139, 92, 246, 0.25)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      {caption && (
        <div
          style={{
            position: 'absolute',
            bottom: '12%',
            left: '50%',
            transform: 'translateX(-50%)',
            color: theme.color.text,
            fontSize: 12,
            fontWeight: 500,
            textAlign: 'center',
            pointerEvents: 'none',
            textShadow: '0 2px 8px rgba(0,0,0,0.9)',
            maxWidth: '80%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {caption}
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          top: '10%',
          right: '14%',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: state === 'idle' ? 'none' : `0 0 8px 2px ${dotColor}`,
          transition: 'all 0.3s ease',
        }}
      />
    </div>
  );
}
