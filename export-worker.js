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

    function probe(input, clip) {
      log = [];
      core.ffprobe(
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json', input, '-o', 'probe.json'
      );
      core.reset();
      if (!fs.analyzePath('probe.json').exists) throw Error(log.slice(-5).join(' ') || 'Cannot read clip');
      const { format, streams } = JSON.parse(fs.readFile('probe.json', { encoding: 'utf8' }));
      fs.unlink('probe.json');
      const begin = Math.max(0, clip.start || 0);
      const end = Math.min(Number(format.duration), clip.end || Number(format.duration));
      if (!Number.isFinite(end) || end <= begin) throw Error('Invalid trim');
      return { begin, duration: end - begin, streams };
    }

    fs.mkdir('/source');
    const parts = [];
    for (const [index, { file, clip, name, title, tail = 0, speed = 1, narration }] of clips.entries()) {
      self.postMessage({ status: 'Encoding clip ' + (index + 1) + '/' + clips.length + ': ' + name, index });
      const input = '/source/clip';
      const narrationPath = '/source/narration';
      const output = 'part-' + index + '.mp4';
      const blobs = [{ name: 'clip', data: file }];
      if (narration) blobs.push({ name: 'narration', data: narration.file });
      fs.mount(fs.filesystems.WORKERFS, { blobs }, '/source');
      try {
        const { begin, duration, streams } = probe(input, clip);
        if (!streams.some(stream => stream.codec_type === 'video')) throw Error('No video track');
        const sourceHasAudio = streams.some(stream => stream.codec_type === 'audio');
        const voice = narration ? probe(narrationPath, narration.clip) : null;
        if (voice && !voice.streams.some(stream => stream.codec_type === 'audio')) {
          throw Error('The narration video has no audio track');
        }
        const videoDuration = voice ? voice.duration : duration / speed;
        const videoSpeed = voice ? duration / voice.duration : speed;
        const audioInput = voice ? ['-ss', String(voice.begin), '-i', narrationPath]
          : sourceHasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
        const audioTrack = audioInput.length ? '1:a:0' : '0:a:0';
        const audioDuration = voice ? voice.duration : duration;
        const tempo = !voice && speed === 2 ? ',atempo=2' : '';
        const titlePath = 'title.png';
        if (title) fs.writeFile(titlePath, title);
        const videoFilters = [
          'scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2',
          'pad=720:1280:(ow-iw)/2:(oh-ih)/2', 'setsar=1'
        ];
        if (voice) videoFilters.unshift('trim=duration=' + duration);
        videoFilters.push('setpts=(PTS-STARTPTS)/' + videoSpeed, 'fps=30');
        if (voice) videoFilters.push('tpad=stop_mode=clone:stop=-1');
        if (tail) videoFilters.push('trim=duration=' + duration, 'tpad=stop_mode=add:stop_duration=' + tail + ':color=black');
        const titleInput = audioInput.length ? 2 : 1;
        encode([
          '-loglevel', 'error', '-ss', String(begin), '-i', input,
          ...audioInput,
          ...(title ? ['-i', titlePath, '-filter_complex_threads', '1',
            '-filter_complex', '[0:v]' + videoFilters.join(',') + '[base];[base][' + titleInput + ':v]overlay[v]',
            '-map', '[v]'] : ['-vf', videoFilters.join(','), '-map', '0:v:0']),
          '-map', audioTrack,
          '-t', String(videoDuration + tail),
          '-af', 'aresample=48000:async=1:first_pts=0,atrim=duration=' + audioDuration + tempo + ',apad',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-maxrate', '20M', '-bufsize', '20M',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
          '-threads', '1', output
        ]);
        if (title) fs.unlink(titlePath);
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
