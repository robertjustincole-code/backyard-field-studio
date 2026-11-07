import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const dir = await mkdtemp(join(tmpdir(), 'bfs-export-'));
const html = await readFile('index.html');
const server = createServer((req, res) => {
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
      null, { timeout: 90000 });
  } catch (error) {
    throw Error('Export stalled: ' + await status.innerText(), { cause: error });
  }
  assert.match(await status.innerText(), /Export complete/);
  assert.deepEqual(errors, []);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /Download finished video/ }).click()
  ]);
  assert.equal(download.suggestedFilename(), 'species-1.mp4');
  const path = await download.path();
  const { streams, format } = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path
  ], { encoding: 'utf8' }));
  assert.match(format.format_name, /mp4/);
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(audio?.codec_name, 'aac');
  assert.deepEqual([video.width, video.height], [720, 1280]);
  console.log('MP4 timing:', format.duration, 'seconds', video.avg_frame_rate, 'fps', audio.sample_rate, 'Hz');
  assert.ok(Math.abs(Number(format.duration) - 6) < 0.75, 'Expected six one-second trims: ' + format.duration);
  for (const [index, color] of expected.entries()) {
    const pixel = execFileSync('ffmpeg', [
      '-v', 'error', '-ss', String(index + 0.5), '-i', path,
      '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'
    ]);
    assert.equal(pixel.length, 3);
    assert.ok(color.every((value, channel) => Math.abs(value - pixel[channel]) < 35),
      'Wrong clip at ' + (index + 0.5) + 's: ' + [...pixel]);
  }
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
