/**
 * Records btw-side-question.gif on a phone, cropped to the lower half of the
 * screen: a BTW side question while a turn is being written (the send menu
 * ends in Stop), then the turn ends with its tests left running in the
 * background and a second one is asked (the menu ends in Send anyway).
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
 * states and the answers are simulated in the browser: the running-sessions
 * poll and the chat socket are answered there, and no fork is run, since the
 * throwaway HOME has no Claude login. Each simulated side question is also
 * written to the throwaway database, as the real server does, so a history
 * reload keeps it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const Database = createRequire(join(CHECKOUT, 'noop.js'))('better-sqlite3');

const VIEWPORT = { width: 390, height: 844 };
// The lower half of the phone screen at 2x. The CDP screencast only delivers
// CSS pixels, even with maxWidth set, so frames are polled screenshots with
// an explicit clip scale; that held a steady 30 fps here.
const CLIP = { x: 0, y: 422, width: 390, height: 422, scale: 2 };
const STATUS = 'Editing SignupForm.tsx';
// What is asked in each case, and what the simulated fork answers.
const ANSWERS: Record<string, string> = {
  'Does it check confirm-password too?':
    'Not yet. SignupForm.tsx only checks email and password; the form has no confirm-password field so far.',
  'Which test covers the signup form?':
    'SignupForm.test.tsx. It checks both required fields and the email format; nothing covers the inline errors yet.',
};
const [FIRST_QUESTION, SECOND_QUESTION] = Object.keys(ANSWERS);
// The test run the turn leaves in the background.
const TOOL_ID = 'toolu_tests_1';
const TASK_ID = 'bg_tests_1';
const TOOL_INPUT = { command: 'npm test', description: 'Run the tests', run_in_background: true };
const CLOSING_TEXT = 'Each error now sits under its own field. The tests are running in the background.';

const WORK = mkdtempSync(join(tmpdir(), 'btw-gif-'));
const HOME = join(WORK, 'home');
const PROJECT = join(WORK, 'project', 'demo-app');
const FRAMES = join(WORK, 'frames');
const LOG = join(WORK, 'server.log');
const DATABASE = join(WORK, 'auth.db');
const SID = randomUUID();
const TRANSCRIPT = join(HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'), `${SID}.jsonl`);

// What the running-sessions poll reports: the turn, then only its tests.
let busy: 'responding' | 'background' = 'responding';
// The page's chat socket, for the frames that end the turn.
let pageSocket: any = null;
// The transcript's last row, which the turn's closing rows chain onto.
let lastUuid: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function transcriptRow(type: 'user' | 'assistant', message: object, timestamp: string, extra: object = {}): string {
  const uuid = randomUUID();
  const row = {
    type, uuid, parentUuid: lastUuid, sessionId: SID, cwd: PROJECT, timestamp,
    isMeta: false, isSidechain: false, userType: 'external', version: '2.0.0', message, ...extra,
  };
  lastUuid = uuid;
  return JSON.stringify(row) + '\n';
}

function seed(): void {
  mkdirSync(join(HOME, '.cloudcli'), { recursive: true });
  mkdirSync(join(PROJECT, 'src'), { recursive: true });
  mkdirSync(join(TRANSCRIPT, '..'), { recursive: true });
  mkdirSync(FRAMES);
  writeFileSync(join(PROJECT, 'package.json'), '{ "name": "demo-app", "version": "0.0.0", "private": true }\n');
  writeFileSync(join(PROJECT, 'src', 'SignupForm.tsx'), 'export function SignupForm() {\n  return null;\n}\n');

  const turns: { role: 'user' | 'assistant'; text: string }[] = [
    { role: 'user', text: 'Can you add form validation to the signup page? Email and password should both be required.' },
    { role: 'assistant', text: 'Sure. I added required-field checks for email and password in SignupForm.tsx, plus a basic email-format check before the form submits.' },
    { role: 'user', text: 'Nice. Now show an inline error under each field instead of one banner, and run the tests when you are done.' },
    { role: 'assistant', text: 'On it. I will move the errors next to their fields first, then run the tests.' },
  ];
  // Dated just before now: asides sort into the transcript by time, and a
  // transcript dated later today would put the new one at the top.
  let t = Date.now() - 5 * 60_000;
  writeFileSync(TRANSCRIPT, turns.map((turn) => transcriptRow(turn.role, {
    role: turn.role, content: turn.text, ...(turn.role === 'assistant' ? { model: 'claude-sonnet-5' } : {}),
  }, new Date((t += 50_000)).toISOString())).join(''));
}

// The turn ends the way a real one does: it launches the tests in the
// background, says so, and completes. The rows go into the transcript first,
// in the CLI's own format, because `complete` makes the page reload it.
async function finishTurn(base: string, token: string): Promise<void> {
  appendFileSync(TRANSCRIPT, [
    transcriptRow('assistant', { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Bash', input: TOOL_INPUT }] }, now()),
    transcriptRow('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: `Command running in background with ID: ${TASK_ID}` }] }, now(),
      { toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: TASK_ID } }),
    transcriptRow('assistant', { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: CLOSING_TEXT }] }, now()),
  ].join(''));

  // Every frame carries an id, as the server's createNormalizedMessage gives
  // one: the client's merge reads it, and one without it throws there.
  pageSocket.send(JSON.stringify({ kind: 'tool_use', id: `live-${TOOL_ID}`, sessionId: SID, toolId: TOOL_ID, toolName: 'Bash', toolInput: TOOL_INPUT, timestamp: now(), provider: 'claude' }));
  pageSocket.send(JSON.stringify({ kind: 'task_status', id: `live-task-${TASK_ID}`, sessionId: SID, toolUseId: TOOL_ID, event: 'started', taskId: TASK_ID, taskType: 'local_bash', description: TOOL_INPUT.description, timestamp: now(), provider: 'claude' }));
  pageSocket.send(JSON.stringify({ kind: 'text', id: 'live-closing-text', role: 'assistant', content: CLOSING_TEXT, sessionId: SID, timestamp: now(), provider: 'claude' }));
  busy = 'background';
  // The server reads transcripts through an index that trails the file, and
  // a reload before it caught up would come back without the closing text.
  for (let i = 0; i < 40; i++) {
    const history = await fetch(`${base}/api/providers/sessions/${SID}/messages`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.text()).catch(() => '');
    if (history.includes(CLOSING_TEXT)) break;
    await sleep(250);
  }
  await sleep(400);
  pageSocket.send(JSON.stringify({ kind: 'complete', id: 'live-complete', provider: 'claude', sessionId: SID, aborted: false, success: true, timestamp: now() }));
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
      ...process.env, HOME, DATABASE_PATH: DATABASE, VITE_IS_PLATFORM: 'true',
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
  const answer = ANSWERS[frame.question] ?? 'No answer scripted for that question.';
  const createdAt = now();
  const row = (text: string, status: string) => ({
    id: frame.sideQuestionId, sessionId: frame.sessionId, question: frame.question, answer: text, status,
    error: null, model: 'claude-sonnet-5', createdAt, finishedAt: status === 'done' ? now() : null,
  });
  const event = (phase: string, extra: object) => JSON.stringify({
    kind: 'side_question', sessionId: frame.sessionId, sideQuestionId: frame.sideQuestionId, phase, timestamp: now(), ...extra,
  });
  // The row the real server keeps: a turn's `complete` reloads history, and
  // history brings the side questions from this table.
  const db = new Database(DATABASE);
  await sleep(250);
  db.prepare('INSERT INTO side_questions (id, session_id, question, answer, status, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(frame.sideQuestionId, frame.sessionId, frame.question, '', 'running', 'claude-sonnet-5', createdAt);
  ws.send(event('started', { sideQuestion: row('', 'running') }));
  await sleep(1400); // the fork reads the conversation before it writes
  for (const word of answer.split(/(?<= )/)) {
    ws.send(event('delta', { text: word }));
    await sleep(70);
  }
  await sleep(150);
  const done = row(answer, 'done');
  db.prepare('UPDATE side_questions SET answer = ?, status = ?, finished_at = ? WHERE id = ?').run(answer, 'done', done.finishedAt, frame.sideQuestionId);
  db.close();
  ws.send(event('done', { sideQuestion: done }));
}

// The poll reports the turn, then only its tests; the subscribe ack is
// turned busy and a status line follows it. `chat.btw` never reaches the
// server.
async function simulateBusySession(page: any): Promise<void> {
  await page.route('**/api/providers/sessions/running*', (route: any) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: {
        sessions: [busy === 'responding'
          ? { sessionId: SID, startedAt: Date.now() - 30_000, canInterrupt: true, background: false, tasks: [] }
          : {
            sessionId: SID, startedAt: Date.now() - 30_000, canInterrupt: false, background: true,
            tasks: [{ taskId: TASK_ID, toolUseId: TOOL_ID, taskType: 'local_bash', description: TOOL_INPUT.description, startedAt: Date.now() - 5_000 }],
          }],
      },
    }),
  }));
  await page.routeWebSocket(/\/ws(\?|$)/, (ws: any) => {
    pageSocket = ws;
    const server = ws.connectToServer();
    server.onMessage((frame: any) => {
      try {
        const data = JSON.parse(String(frame));
        if (data.kind === 'chat_subscribed' && data.sessionId === SID && busy === 'responding') {
          ws.send(JSON.stringify({ ...data, isProcessing: true }));
          setTimeout(() => ws.send(JSON.stringify({ kind: 'status', id: 'live-status', provider: 'claude', sessionId: SID, text: STATUS, canInterrupt: true, timestamp: now() })), 150);
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

    // The chat scrolls when a message is added, not while one grows (as on
    // main), so a finished answer is partly behind the composer: swipe up.
    const swipeUp = async () => {
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
    };

    // Type, open the send menu, pass over its red last item and Queue, take BTW.
    const askOnTheSide = async (question: string, lastItem: 'Stop' | 'Send anyway') => {
      const field = await centre(page.locator('textarea').first());
      await glide(field.x - 60, field.y, 700);
      await tap();
      await page.waitForTimeout(250);
      await page.keyboard.type(question, { delay: 45 });
      await page.waitForTimeout(600);

      const trigger = await centre(page.getByRole('button', { name: 'Send options' }));
      await glide(trigger.x, trigger.y, 600);
      await page.waitForTimeout(450);
      await tap();
      await page.waitForTimeout(700);

      const last = await centre(item(lastItem));
      const queue = await centre(item('Queue'));
      const btw = await centre(item('BTW'));
      await glide(last.x + 30, last.y, 450);
      await page.waitForTimeout(800);
      await glide(queue.x + 10, queue.y, 500);
      await page.waitForTimeout(700);
      await glide(btw.x, btw.y, 350);
      await page.waitForTimeout(700);
      await tap();

      await page.waitForTimeout(600);
      await glide(386, at.y - 120, 600); // the finger leaves past the right edge
      await page.waitForTimeout(3600);   // pending shimmer, streaming, done
      await swipeUp();
    };

    await page.waitForTimeout(900);
    await mouse.move(at.x, at.y);
    await askOnTheSide(FIRST_QUESTION, 'Stop');
    await page.waitForTimeout(1200);
    await finishTurn(base, token);
    await page.waitForTimeout(2600);   // the turn's last rows land; its tests keep running
    await askOnTheSide(SECOND_QUESTION, 'Send anyway');
    await page.waitForTimeout(2400);   // hold on both asides

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
