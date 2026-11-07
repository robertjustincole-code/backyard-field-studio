import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const dir = await mkdtemp(join(tmpdir(), 'bfs-export-'));
const html = await readFile('index.html');
const worker = await readFile('export-worker.js');
const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/export-worker.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(worker);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
const slots = [0, 1, 2, 3, 5, 6];
const colors = ['red', 'lime', 'blue', 'yellow', 'magenta', 'cyan'];
const expected = [[255,0,0], [0,255,0], [0,0,255], [255,255,0], [255,0,255], [0,255,255]];
let context;

try {
  const clips = colors.map((color, index) => {
    const path = join(dir, color + '.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=' + color + ':size=320x568:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=' + (440 + index * 110) + ':sample_rate=48000',
      '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path
    ]);
    return path;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Playwright WebKit cannot persist File objects in its private contexts.
  context = await webkit.launchPersistentContext(join(dir, 'profile'), { acceptDownloads: true });
  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => console.log('browser:', message.type(), message.text()));
  // The OS share sheet needs a real device. Verify the browser hands it the MP4.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: ({ files }) => files?.length === 1 });
    Object.defineProperty(navigator, 'share', { value: async ({ files }) => {
      const [file] = files;
      window.sharedVideo = {
        name: file.name, type: file.type, size: file.size,
        active: navigator.userActivation.isActive
      };
    } });
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: '+ New species' }).click();
  const sections = page.locator('#segments section');

  for (const [index, slot] of slots.entries()) {
    const section = sections.nth(slot);
    await section.locator('input[type=file]').setInputFiles(clips[index]);
    const video = section.locator('video');
    try {
      await page.waitForFunction(i => {
        const video = document.querySelectorAll('#segments video')[i];
        return video.error || (video.readyState >= 1 && Number.isFinite(video.duration));
      }, slot, { polling: 100, timeout: 10000 });
      assert.equal(await video.evaluate(element => element.error?.message), undefined);
    } catch (error) {
      const details = await video.evaluate(element => ({
        src: element.getAttribute('src'), readyState: element.readyState,
        networkState: element.networkState, error: element.error?.message,
        canPlay: element.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
        fileState: element.closest('section').querySelector('.fileState').textContent,
        saved: JSON.parse(localStorage.getItem('bfs_projects'))[0].clips
      }));
      throw Error('Fixture failed in slot ' + slot + ': ' + JSON.stringify({ details, errors }), { cause: error });
    }
    await section.locator('.start').fill('0.3');
    await section.locator('.end').fill('1.3');
    await section.locator('.end').press('Tab');
  }

  const first = sections.nth(0);
  const timeline = first.locator('.timeline');
  const startHandle = first.getByRole('button', { name: /Trim start handle/ });
  const endHandle = first.getByRole('button', { name: /Trim end handle/ });
  await startHandle.press('ArrowRight');
  assert.equal(await first.locator('.start').inputValue(), '0.31');
  await startHandle.press('ArrowLeft');
  const track = await timeline.boundingBox();
  const handle = await endHandle.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - track.width / 5, handle.y + handle.height / 2);
  await page.mouse.up();
  assert.ok(Math.abs(Number(await first.locator('.end').inputValue()) - 1) < 0.03);
  await first.locator('.end').fill('1.3');
  await first.locator('.end').press('Tab');
  await first.getByRole('button', { name: 'Play selection' }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('#segments video');
    return !video.paused && video.currentTime >= 0.3 && video.currentTime < 1.3;
  });
  await page.waitForFunction(() => {
    const video = document.querySelector('#segments video');
    return video.paused && Math.abs(video.currentTime - 1.3) < 0.04;
  });
  console.log('PASS: timeline handle drag, keyboard trim, and playback bounded by selection');

  await page.reload();
  await page.getByRole('button', { name: 'Open project' }).click();
  await page.waitForFunction(() => document.querySelector('#segments .start').value === '0.3',
    null, { polling: 100, timeout: 10000 });
  const trims = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('bfs_projects'))[0].clips)
    .map(({ start, end }) => [start, end]));
  assert.deepEqual(trims, slots.map(() => [0.3, 1.3]));
  const status = page.locator('#status');
  await page.getByRole('button', { name: 'Stitch video' }).click();
  try {
    await page.waitForFunction(() =>
      /Export complete|Render failed|cannot record/.test(document.querySelector('#status').textContent),
      null, { timeout: 180000 });
  } catch (error) {
    throw Error('Export stalled: ' + await status.innerText(), { cause: error });
  }
  assert.match(await status.innerText(), /Export complete/);
  assert.deepEqual(errors, []);

  const preview = page.getByLabel('Finished video preview');
  assert.equal(await preview.count(), 1);
  await page.waitForFunction(() => document.querySelector('#download video').readyState >= 1);
  assert.ok(await preview.evaluate(video => video.duration > 7 && !video.error));
  await page.getByRole('button', { name: 'Share or save video' }).click();
  const shared = await page.evaluate(() => window.sharedVideo);
  assert.equal(shared.name, 'species-1.mp4');
  assert.equal(shared.type, 'video/mp4');
  assert.equal(shared.active, true);
  assert.ok(shared.size > 0);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /Download finished video/ }).click()
  ]);
  assert.equal(download.suggestedFilename(), 'species-1.mp4');
  const path = await download.path();
  assert.equal((await stat(path)).size, shared.size);
  const { streams, format } = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path
  ], { encoding: 'utf8' }));
  assert.match(format.format_name, /mp4/);
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(audio?.codec_name, 'aac');
  assert.equal(audio.sample_rate, '48000');
  assert.equal(video.avg_frame_rate, '30/1');
  assert.deepEqual([video.width, video.height], [720, 1280]);
  console.log('MP4 timing:', format.duration, 'seconds', video.avg_frame_rate, 'fps', audio.sample_rate, 'Hz',
    'stream durations:', video.duration, audio.duration);
  assert.ok(Math.abs(Number(format.duration) - 7) < 0.15, 'Expected six one-second trims and one second of closing card: ' + format.duration);
  for (const [index, color] of expected.entries()) {
    const pixel = execFileSync('ffmpeg', [
      '-v', 'error', '-ss', String(index + 0.5), '-i', path,
      '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'
    ]);
    assert.equal(pixel.length, 3);
    assert.ok(color.every((value, channel) => Math.abs(value - pixel[channel]) < 35),
      'Wrong clip at ' + (index + 0.5) + 's: ' + [...pixel]);
  }
  function titleFrame(time) {
    return execFileSync('ffmpeg', [
      '-v', 'error', '-ss', String(time), '-i', path,
      '-vf', 'crop=720:240:0:875,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'
    ]);
  }
  function whitePixels(frame) {
    let count = 0;
    for (let index = 0; index < frame.length; index += 3) {
      if (frame[index] > 225 && frame[index + 1] > 225 && frame[index + 2] > 225) count++;
    }
    return count;
  }
  assert.ok(whitePixels(titleFrame(0.5)) > 1000, 'Missing opening title');
  assert.equal(whitePixels(titleFrame(1.5)), 0, 'Title leaked into a middle clip');
  const closing = titleFrame(5.5);
  const card = titleFrame(6.5);
  assert.ok(whitePixels(closing) > 1000, 'Missing closing title');
  assert.ok(whitePixels(card) > 1000, 'Missing black-card title');
  assert.ok(card.subarray(0, 720 * 20 * 3).every(value => value < 10), 'Card background is not black');
  const samples = execFileSync('ffmpeg', [
    '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'
  ]);
  for (const index of slots.keys()) {
    const start = (index * 8000 + 2400) * 2;
    const end = start + 3200 * 2;
    let peak = 0;
    for (let offset = start; offset < Math.min(end, samples.length - 1); offset += 2) {
      peak = Math.max(peak, Math.abs(samples.readInt16LE(offset)));
    }
    assert.ok(peak > 500, 'Missing audio in clip ' + (index + 1));
  }
  console.log('PASS: six saved clips trimmed in order, downloaded and decoded as portrait H.264/AAC MP4');
} finally {
  await context?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
