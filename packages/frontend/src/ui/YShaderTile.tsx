import { useEffect, useRef, type JSX } from 'react'
import type { IdentityFamily } from './identity'

/*
 * The moving lanes on a working project's tile: vertical lanes of blocks
 * sliding up or down, seeded from the project so each project has its own
 * lane width, block length and direction, faster with more agents (`rate`
 * 1 to 3). One shared WebGL context draws every tile and copies the result
 * into each tile's own 2D canvas, because browsers cap live WebGL contexts
 * at about sixteen. Drawing stops while the page is hidden and holds a
 * still frame under reduced motion.
 */

const FRAGMENT = `
precision mediump float;
uniform float t; uniform vec2 res; uniform vec3 c0; uniform vec3 c1; uniform vec3 c2; uniform float seed; uniform float rate;
float hs(float n){ return fract(sin(n*91.345)*47453.5453); }
vec3 sub(float u, float v, float pitch, float gapw, float seg, float speed){
  float i = floor(u/pitch); float local = fract(u/pitch); float px = 1.1/res.x/pitch;
  float body = smoothstep(gapw - px, gapw + px, local);
  float sp = speed*(.5 + hs(i + seed*7.));
  float j = floor((v - t*sp)/seg + hs(i + seed)*9.);
  float k = hs(i*13.7 + j*3.1 + seed*31.);
  vec3 lo = mix(c0, c1, .7), mid = mix(c1, c2, .13), hi = mix(c1, c2, .25);
  vec3 tn = k < .45 ? c1 : (k < .7 ? lo : (k < .9 ? mid : hi));
  return mix(mix(c0, c1, .55), tn, body);
}
void main(){ vec2 uv = gl_FragCoord.xy/res;
  float pitch = .1 + .05*hs(seed*5.1); float dir = hs(seed*9.7) < .5 ? 1. : -1.;
  gl_FragColor = vec4(sub(uv.x + 1., (uv.y - .5)*dir, pitch, .13, .22 + .2*hs(seed*2.2), (.05 + .04*hs(seed*4.4))*rate), 1.); }`

interface Tile {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  colours: [number, number, number][]
  seed: number
  rate: number
  t0: number
}

const tiles = new Set<Tile>()
let renderer: { draw: (tile: Tile, now: number) => void } | null | undefined
let running = false

function getRenderer(): typeof renderer {
  if (renderer !== undefined) return renderer
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true })
  if (!gl) return (renderer = null)
  const shader = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type) as WebGLShader
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(prog)
  gl.useProgram(prog)
  const u = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, n)
  const U = { t: u('t'), res: u('res'), c0: u('c0'), c1: u('c1'), c2: u('c2'), seed: u('seed'), rate: u('rate') }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const a = gl.getAttribLocation(prog, 'a')
  gl.enableVertexAttribArray(a)
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)
  renderer = {
    draw(tile, now) {
      const { width: w, height: h } = tile.canvas
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      gl.viewport(0, 0, w, h)
      gl.uniform1f(U.t, (now - tile.t0) / 1000)
      gl.uniform2f(U.res, w, h)
      gl.uniform1f(U.seed, tile.seed)
      gl.uniform1f(U.rate, tile.rate)
      gl.uniform3fv(U.c0, tile.colours[0])
      gl.uniform3fv(U.c1, tile.colours[1])
      gl.uniform3fv(U.c2, tile.colours[2])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      tile.ctx.clearRect(0, 0, w, h)
      tile.ctx.drawImage(canvas, 0, 0)
    },
  }
  return renderer
}

const still = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* Draws every tile at about 30 frames a second while any are mounted. */
function loop(): void {
  if (running) return
  running = true
  let last = 0
  const frame = (now: number): void => {
    if (tiles.size === 0) { running = false; return }
    if (now - last > 32) {
      last = now
      const r = getRenderer()
      if (r) for (const tile of tiles) r.draw(tile, still() ? tile.t0 + 4000 : now)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/* A token colour as 0…1 RGB, resolved against the element's theme. */
function resolveColour(el: HTMLElement, token: string): [number, number, number] {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  el.appendChild(probe)
  const m = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]
  probe.remove()
  return [m[0] / 255, m[1] / 255, m[2] / 255]
}

export function YShaderTile({ family, seedKey, size, rate = 1, bright = false }: {
  family: IdentityFamily
  /** What the lanes are seeded from: the project's id. */
  seedKey: string
  size: number
  rate?: number
  /** The lit tile's lanes, drawn in the family's fill shades. */
  bright?: boolean
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const shades = bright ? ['glow', 'fill', 'ink'] : ['deep', 'tint', 'glow']
    const tile: Tile = {
      canvas,
      ctx,
      colours: shades.map((s) => resolveColour(canvas.parentElement ?? document.body, `--proj-${family}-${s}`)),
      seed: [...seedKey].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 997, 7) / 97.3,
      rate: Math.min(3, Math.max(1, rate)),
      t0: performance.now() - Math.random() * 20000,
    }
    tiles.add(tile)
    loop()
    return () => { tiles.delete(tile) }
  }, [family, seedKey, size, rate, bright])
  return <canvas ref={ref} aria-hidden="true" className="block" style={{ width: size, height: size }} />
}
