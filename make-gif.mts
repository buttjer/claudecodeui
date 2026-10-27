/**
 * Records btw-side-question.gif: a BTW side question asked on a phone while
 * a turn is being written, cropped to the lower half of the screen.
 *
 *   node make-gif.mts <claudecodeui checkout> <out.gif>
 *
 * Needs the checkout's client built (`npx vite build`), ffmpeg on PATH, and
 * playwright-core with a Chromium, resolved from the checkout or from
 * PLAYWRIGHT_FROM=<dir>. KEEP=1 keeps the scratch directory.
 *
 * Nothing touches a real CloudCLI. The throwaway server gets its own HOME,
 * because CloudCLI writes ~/.cloudcli/local-server.json on start whatever
 * DATABASE_PATH says, and a seeded demo session with a demo login. The busy
 * state and the answer are simulated in the browser: the running-sessions
 * poll and the chat socket are answered there, and no fork is run, since the
 * throwaway HOME has no Claude login.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [checkoutArg, outArg] = process.argv.slice(2);
if (!checkoutArg || !outArg) {
  console.error('usage: node make-gif.mts <claudecodeui checkout> <out.gif>');
  process.exit(2);
}
const CHECKOUT = resolve(checkoutArg);
const OUT = resolve(outArg);
const { chromium } = createRequire(join(resolve(process.env.PLAYWRIGHT_FROM ?? CHECKOUT), 'noop.js'))('playwright-core');

const VIEWPORT = { width: 390, height: 844 };
// The lower half of the phone screen at 2x. The CDP screencast only delivers
// CSS pixels, even with maxWidth set, so frames are polled screenshots with
// an explicit clip scale; that held a steady 30 fps here.
const CLIP = { x: 0, y: 422, width: 390, height: 422, scale: 2 };
const QUESTION = 'Does it check confirm-password too?';
const ANSWER = 'Not yet. SignupForm.tsx only checks email and password; the form has no confirm-password field so far.';
const STATUS = 'Editing SignupForm.tsx';

const WORK = mkdtempSync(join(tmpdir(), 'btw-gif-'));
const HOME = join(WORK, 'home');
const PROJECT = join(WORK, 'project', 'demo-app');
const FRAMES = join(WORK, 'frames');
const LOG = join(WORK, 'server.log');
const SID = randomUUID();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function seed(): void {
  mkdirSync(join(HOME, '.cloudcli'), { recursive: true });
  mkdirSync(join(PROJECT, 'src'), { recursive: true });
  mkdirSync(FRAMES);
  writeFileSync(join(PROJECT, 'package.json'), '{ "name": "demo-app", "version": "0.0.0", "private": true }\n');
  writeFileSync(join(PROJECT, 'src', 'SignupForm.tsx'), 'export function SignupForm() {\n  return null;\n}\n');

  const turns = [
    { role: 'user', text: 'Can you add form validation to the signup page? Email and password should both be required.' },
    { role: 'assistant', text: 'Sure. I added required-field checks for email and password in SignupForm.tsx, plus a basic email-format check before the form submits.' },
    { role: 'user', text: 'Nice. Now show an inline error under each field instead of one banner, and run the tests when you are done.' },
    { role: 'assistant', text: 'On it. I will move the errors next to their fields first, then update the tests.' },
  ];
  // Dated just before now: asides sort into the transcript by time, and a
  // transcript dated later today would put the new one at the top.
  let t = Date.now() - 5 * 60_000;
  let parentUuid: string | null = null;
  const rows = turns.map((turn) => {
    const uuid = randomUUID();
    const row = {
      type: turn.role, uuid, parentUuid, sessionId: SID, cwd: PROJECT, timestamp: new Date((t += 50_000)).toISOString(),
      isMeta: false, isSidechain: false, userType: 'external', version: '2.0.0',
      message: { role: turn.role, content: turn.text, ...(turn.role === 'assistant' ? { model: 'claude-sonnet-5' } : {}) },
    };
    parentUuid = uuid;
    return row;
  });
  const dir = join(HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => ok(port));
    });
  });
}

function startServer(port: number) {
  const log = openSync(LOG, 'w');
  // detached: its own process group, so one kill takes npx, tsx and node.
  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: CHECKOUT, detached: true, stdio: ['ignore', log, log],
    env: {
      ...process.env, HOME, DATABASE_PATH: join(WORK, 'auth.db'), VITE_IS_PLATFORM: 'true',
      NODE_ENV: 'production', SERVER_PORT: String(port), HOST: '127.0.0.1',
    },
  });
  closeSync(log);
  return () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } };
}

async function signIn(base: string): Promise<string> {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch { /* not up yet */ }
    if (i === 60) throw new Error(`the server did not answer within 60 s; see ${LOG}`);
    await sleep(1000);
  }
  const reg = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo-pass-1234' }),
  })).json();
  const token = reg.token ?? reg.data?.token;
  if (!token) throw new Error(`register returned no token: ${JSON.stringify(Object.keys(reg))}`);
  await fetch(`${base}/api/user/complete-onboarding`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return token;
}

// A finger-sized dot that follows the mouse, so taps and hovers show. A
// mouse rather than touch emulation, because hover only exists for a mouse.
function installFingerDot(): void {
  const add = () => {
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'fixed', left: '-100px', top: '-100px', width: '30px', height: '30px',
      marginLeft: '-15px', marginTop: '-15px', borderRadius: '50%',
      background: 'rgba(30, 30, 30, 0.28)', border: '2px solid rgba(255, 255, 255, 0.9)',
      boxShadow: '0 1px 6px rgba(0,0,0,0.35)', pointerEvents: 'none', zIndex: '2147483647',
      transition: 'transform 90ms ease-out, background 90ms ease-out, opacity 200ms ease-out', opacity: '0',
    });
    document.body.appendChild(dot);
    const press = (on: boolean) => {
      dot.style.transform = on ? 'scale(0.75)' : 'scale(1)';
      dot.style.background = on ? 'rgba(30, 30, 30, 0.5)' : 'rgba(30, 30, 30, 0.28)';
    };
    document.addEventListener('mousemove', (e) => {
      dot.style.left = `${e.clientX}px`;
      dot.style.top = `${e.clientY}px`;
      // A move past the viewport sends no event, so the edge itself hides it.
      dot.style.opacity = e.clientX > window.innerWidth - 12 ? '0' : '1';
    }, true);
    document.addEventListener('mousedown', () => press(true), true);
    document.addEventListener('mouseup', () => press(false), true);
    (window as any).__fingerPress = press;
  };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
}

async function streamAnswer(ws: any, frame: any): Promise<void> {
  const createdAt = now();
  const row = (answer: string, status: string) => ({
    id: frame.sideQuestionId, sessionId: frame.sessionId, question: frame.question, answer, status,
    error: null, model: 'claude-sonnet-5', createdAt, finishedAt: status === 'done' ? now() : null,
  });
  const event = (phase: string, extra: object) => JSON.stringify({
    kind: 'side_question', sessionId: frame.sessionId, sideQuestionId: frame.sideQuestionId, phase, timestamp: now(), ...extra,
  });
  await sleep(250);
  ws.send(event('started', { sideQuestion: row('', 'running') }));
  await sleep(1400); // the fork reads the conversation before it writes
  for (const word of ANSWER.split(/(?<= )/)) {
    ws.send(event('delta', { text: word }));
    await sleep(70);
  }
  await sleep(150);
  ws.send(event('done', { sideQuestion: row(ANSWER, 'done') }));
}

// "A turn is being written": the poll says so, the subscribe ack is turned
// busy, and a status line follows it. `chat.btw` never reaches the server.
async function simulateBusySession(page: any): Promise<void> {
  await page.route('**/api/providers/sessions/running*', (route: any) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { sessions: [{ sessionId: SID, startedAt: Date.now() - 30_000, canInterrupt: true, background: false, tasks: [] }] } }),
  }));
  await page.routeWebSocket(/\/ws(\?|$)/, (ws: any) => {
    const server = ws.connectToServer();
    server.onMessage((frame: any) => {
      try {
        const data = JSON.parse(String(frame));
        if (data.kind === 'chat_subscribed' && data.sessionId === SID) {
          ws.send(JSON.stringify({ ...data, isProcessing: true }));
          setTimeout(() => ws.send(JSON.stringify({ kind: 'status', sessionId: SID, text: STATUS, canInterrupt: true, timestamp: now() })), 150);
          return;
        }
      } catch { /* not JSON */ }
      ws.send(frame);
    });
    ws.onMessage((frame: any) => {
      let data: any = null;
      try { data = JSON.parse(String(frame)); } catch { /* not JSON */ }
      if (data?.type === 'chat.btw') void streamAnswer(ws, data);
      else server.send(frame);
    });
  });
}

async function record(base: string, token: string): Promise<{ file: string; t: number }[]> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });
    await context.addInitScript((t: string) => window.localStorage.setItem('auth-token', t), token);
    await context.addInitScript(installFingerDot);
    const page = await context.newPage();
    await simulateBusySession(page);
    await page.goto(`${base}/session/${SID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const frames: { file: string; t: number }[] = [];
    const cdp = await context.newCDPSession(page);
    let capturing = true;
    const capture = (async () => {
      while (capturing) {
        const t = Date.now() / 1000;
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: CLIP, optimizeForSpeed: true });
        const file = join(FRAMES, `f${String(frames.length).padStart(5, '0')}.png`);
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        frames.push({ file, t });
      }
    })();

    const mouse = page.mouse;
    let at = { x: 360, y: 900 };
    // Eased, so the dot moves like a finger rather than jumping.
    const glide = async (x: number, y: number, ms = 450) => {
      const steps = Math.max(8, Math.round(ms / 16));
      const from = at;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        await mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
        await page.waitForTimeout(ms / steps);
      }
      at = { x, y };
    };
    const tap = async () => { await mouse.down(); await page.waitForTimeout(110); await mouse.up(); };
    const centre = async (locator: any) => {
      const b = await locator.boundingBox();
      return { x: b.x + b.width * 0.5, y: b.y + b.height * 0.5 };
    };
    const item = (name: string) => page.getByRole('menuitem', { name: new RegExp(`^${name}`) });

    await page.waitForTimeout(900);
    const field = await centre(page.locator('textarea').first());
    await mouse.move(at.x, at.y);
    await glide(field.x - 60, field.y, 700);
    await tap();
    await page.waitForTimeout(250);
    await page.keyboard.type(QUESTION, { delay: 45 });
    await page.waitForTimeout(600);

    const trigger = await centre(page.getByRole('button', { name: 'Send options' }));
    await glide(trigger.x, trigger.y, 600);
    await page.waitForTimeout(450);
    await tap();
    await page.waitForTimeout(700);

    const stop = await centre(item('Stop'));
    const queue = await centre(item('Queue'));
    const btw = await centre(item('BTW'));
    await glide(stop.x + 30, stop.y, 450);
    await page.waitForTimeout(800);
    await glide(queue.x + 10, queue.y, 500);
    await page.waitForTimeout(700);
    await glide(btw.x, btw.y, 350);
    await page.waitForTimeout(700);
    await tap();

    await page.waitForTimeout(600);
    await glide(386, at.y - 120, 600); // the finger leaves past the right edge
    await page.waitForTimeout(3600);   // pending shimmer, streaming, done

    // The chat scrolls when a message is added, not while one grows (as on
    // main), so the finished answer is partly behind the composer: swipe up.
    await glide(210, 640, 600);
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).__fingerPress(true));
    for (let i = 0; i < 14; i++) {
      at = { x: at.x, y: at.y - 14 };
      await mouse.move(at.x, at.y);
      await mouse.wheel(0, 14);
      await page.waitForTimeout(28);
    }
    await page.evaluate(() => (window as any).__fingerPress(false));
    await page.waitForTimeout(250);
    await glide(386, at.y - 60, 500);
    await page.waitForTimeout(2200);   // hold on the finished aside

    capturing = false;
    await capture;
    return frames;
  } finally {
    await browser.close();
  }
}

// GIF delays are centiseconds, so 25 fps (4 cs) plays at the recorded speed
// where 30 fps would round. The concat list carries each frame's real time.
function encode(frames: { file: string; t: number }[]): void {
  const list = join(WORK, 'frames.txt');
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    lines.push(`file '${f.file}'`, `duration ${(i + 1 < frames.length ? frames[i + 1].t - f.t : 0.04).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  writeFileSync(list, lines.join('\n') + '\n');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'fps=25,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', OUT,
  ], { stdio: 'inherit' });
}

let failed = false;
const port = await freePort();
seed();
const stopServer = startServer(port);
try {
  const base = `http://127.0.0.1:${port}`;
  const frames = await record(base, await signIn(base));
  encode(frames);
  console.log(`${OUT}: ${frames.length} frames over ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)} s`);
} catch (error) {
  failed = true;
  console.error(error);
  try { console.error(readFileSync(LOG, 'utf8').split('\n').slice(-20).join('\n')); } catch { /* no log */ }
} finally {
  stopServer();
  await sleep(1000);
  if (failed || process.env.KEEP) console.error(`scratch kept in ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
