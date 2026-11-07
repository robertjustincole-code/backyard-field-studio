// Single-threaded FFmpeg keeps the export available on GitHub Pages without
// cross-origin isolation. The codec engine runs in this worker.
const coreURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js';

self.onmessage = async ({ data: clips }) => {
  try {
    importScripts(coreURL);
    const wasmURL = coreURL.replace(/\.js$/, '.wasm');
    const core = await self.createFFmpegCore({
      mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL }))
    });
    const fs = core.FS;
    let log = [];
    core.setLogger(({ message }) => {
      log.push(message);
      if (log.length > 24) log.shift();
    });

    function encode(args) {
      log = [];
      core.exec(...args);
      const result = core.ret;
      core.reset();
      if (result !== 0) throw Error(log.slice(-5).join(' ') || 'FFmpeg exited with code ' + result);
    }

    fs.mkdir('/source');
    const parts = [];
    for (const [index, { file, clip, name }] of clips.entries()) {
      self.postMessage({ status: 'Encoding clip ' + (index + 1) + '/' + clips.length + ': ' + name, index });
      const input = '/source/clip';
      const output = 'part-' + index + '.mp4';
      fs.mount(fs.filesystems.WORKERFS, { blobs: [{ name: 'clip', data: file }] }, '/source');
      try {
        log = [];
        core.ffprobe(
          '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
          '-of', 'json', input, '-o', 'probe.json'
        );
        core.reset();
        if (!fs.analyzePath('probe.json').exists) throw Error(log.slice(-5).join(' ') || 'Cannot read clip');
        const { format, streams } = JSON.parse(fs.readFile('probe.json', { encoding: 'utf8' }));
        fs.unlink('probe.json');
        if (!streams.some(stream => stream.codec_type === 'video')) throw Error('No video track');
        const begin = Math.max(0, clip.start || 0);
        const end = Math.min(Number(format.duration), clip.end || Number(format.duration));
        if (!Number.isFinite(end) || end <= begin) throw Error('Invalid trim');
        const audio = streams.some(stream => stream.codec_type === 'audio');
        encode([
          '-loglevel', 'error', '-ss', String(begin), '-i', input,
          ...(audio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
          '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0',
          '-t', String(end - begin),
          '-vf', "scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
          '-af', 'aresample=48000:async=1:first_pts=0,apad',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-maxrate', '20M', '-bufsize', '20M',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
          '-threads', '1', output
        ]);
      } catch (error) {
        throw Error(name + ' (' + file.name + '): ' + error.message);
      } finally {
        fs.unmount('/source');
      }
      parts.push(output);
    }

    self.postMessage({ status: 'Finalizing MP4…', index: clips.length });
    fs.writeFile('parts.txt', parts.map(path => "file '" + path + "'").join('\n'));
    encode([
      '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', 'parts.txt',
      '-c', 'copy', '-movflags', '+faststart', 'species.mp4'
    ]);
    const video = fs.readFile('species.mp4');
    self.postMessage({ video }, [video.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
