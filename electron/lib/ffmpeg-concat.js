'use strict';
// ffmpeg-concat.js — ffmpeg post-processing for generated media:
//   (1) concat() — stitch >=2 local clips into one MP4;
//   (2) normalizeImage() — scale+crop a still to an exact frame size for i2v references.
//
// concat: probe each clip's WxH+fps; if all match, concat losslessly (concat demuxer
// + `-c copy`); if they differ, normalize each to 1920x1080@30 (scale + pad to preserve
// aspect, fps filter) then concat with a re-encode (libx264/aac). Output → outputs/video-noi-<ts>.mp4.
//
// normalizeImage: scale-to-fill + center-crop a reference still to EXACTLY w×h, so an
// off-ratio or too-small picture (e.g. a square logo) becomes a valid i2v first-frame.
// Gommo/VEO rejects a frame whose ratio/size doesn't match the requested video
// ("Ảnh đính kèm không hợp lệ"); conforming the still to the video's dims fixes that.
//
// ANTI-FEATURES (deliberately out of scope for v1):
//   - No transitions / crossfades / overlays / titles — hard cut concatenation only.
//     (A logo overlay/watermark was explicitly declined — references go IN as frames,
//      they are never composited ON TOP of the finished video here.)
//   - No audio mixing or per-clip volume — streams are passed through / re-encoded as-is.
//   - No GPU encode, no quality presets — one fixed 1920x1080@30 normalize target.
//   - No remote URLs — clips MUST be local files (path confinement lives in the API layer).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TARGET_W = 1920;
const TARGET_H = 1080;
const TARGET_FPS = 30;
const KILL_TIMEOUT_MS = 20 * 60 * 1000;   // a long re-encode of several clips must not hang forever
const PROBE_TIMEOUT_MS = 30 * 1000;
// scale-to-fit then letterbox-pad so AR is preserved (never stretch), then force fps.
const NORMALIZE_VF = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS}`;

// Injection seams for tests (no real ffmpeg / no real bin resolution under test).
let _spawn = spawn;
let _ffmpegBinOverride = null;
function _setSpawnForTest(fn) { _spawn = fn; }
function _setBinForTest(p) { _ffmpegBinOverride = p; }

function ffmpegBin() {
  if (_ffmpegBinOverride) return _ffmpegBinOverride;
  const ri = require('./runtime-installer');
  return ri.getFfmpegBin(ri.getRuntimeNodeDir());
}

function assertReady() {
  if (!ffmpegBin()) {
    throw new Error('Chưa cài ffmpeg — mở lại app để bộ cài tự tải, hoặc kiểm tra mạng.');
  }
}

// Run ffmpeg; resolve {code, stderr}. Never rejects on non-zero exit — the caller
// decides (ffmpeg -i for probing exits non-zero by design yet prints stream info).
function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cp = _spawn(ffmpegBin(), args, { shell: false, windowsHide: true });
    let stderr = '';
    cp.stderr && cp.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg timeout')); }, timeoutMs);
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

// Parse "1920x1080" + "30 fps" out of ffmpeg -i stderr. Defensive: live ffmpeg
// formats vary ("29.97 fps", "30000/1001"); we round to the nearest integer fps
// and tolerate a missing fps (defaults to TARGET_FPS so it won't force a re-encode
// on a probe-parse miss alone — dims are the primary signal).
function parseProbe(stderr) {
  const dim = stderr.match(/(\d{2,5})x(\d{2,5})/);
  const fpsM = stderr.match(/([\d.]+)\s*fps/);
  return {
    w: dim ? parseInt(dim[1], 10) : null,
    h: dim ? parseInt(dim[2], 10) : null,
    fps: fpsM ? Math.round(parseFloat(fpsM[1])) : TARGET_FPS,
  };
}

async function probe(clip) {
  const { stderr } = await run(['-i', clip], PROBE_TIMEOUT_MS);
  const p = parseProbe(stderr);
  if (!p.w || !p.h) throw new Error('Không đọc được kích thước video: ' + path.basename(clip));
  return p;
}

// concat-demuxer list.txt: each line `file '<path>'`. Single-quotes inside a path
// are escaped as '\'' per ffmpeg's concat-demuxer quoting rules.
function writeListFile(dir, clips) {
  const lines = clips.map((c) => `file '${String(c).replace(/'/g, "'\\''")}'`);
  const listPath = path.join(dir, 'concat-list-' + Date.now() + '.txt');
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');
  return listPath;
}

async function concat(clipPaths, outDir) {
  assertReady();
  if (!Array.isArray(clipPaths) || clipPaths.length < 2) {
    throw new Error('Cần ít nhất 2 clip để nối video.');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'video-noi-' + Date.now() + '.mp4');
  const temps = [];

  try {
    const probes = [];
    for (const c of clipPaths) probes.push(await probe(c));
    const first = probes[0];
    const uniform = probes.every((p) => p.w === first.w && p.h === first.h && p.fps === first.fps);

    if (uniform) {
      // Lossless: no re-encode, just stitch the matching streams.
      const list = writeListFile(outDir, clipPaths);
      temps.push(list);
      const { code, stderr } = await run(
        ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', outPath],
        KILL_TIMEOUT_MS
      );
      if (code !== 0) throw new Error('ffmpeg concat lỗi: ' + stderr.slice(-300));
    } else {
      // Normalize each clip to a common WxH/fps so the concat is valid, then re-encode.
      const normalized = [];
      for (let i = 0; i < clipPaths.length; i++) {
        const tmp = path.join(outDir, `norm-${Date.now()}-${i}.mp4`);
        temps.push(tmp);
        const { code, stderr } = await run(
          ['-i', clipPaths[i], '-vf', NORMALIZE_VF, '-c:v', 'libx264', '-c:a', 'aac', '-y', tmp],
          KILL_TIMEOUT_MS
        );
        if (code !== 0) throw new Error('ffmpeg normalize lỗi: ' + stderr.slice(-300));
        normalized.push(tmp);
      }
      const list = writeListFile(outDir, normalized);
      temps.push(list);
      const { code, stderr } = await run(
        ['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-c:a', 'aac', '-y', outPath],
        KILL_TIMEOUT_MS
      );
      if (code !== 0) throw new Error('ffmpeg concat (re-encode) lỗi: ' + stderr.slice(-300));
    }
    return { path: outPath };
  } finally {
    for (const t of temps) { try { fs.unlinkSync(t); } catch {} }
  }
}

// Conform a still image to EXACTLY w×h via cover (scale-to-fill + center-crop, no
// letterbox bars) so it is a valid i2v first-frame for the target video ratio. Used by
// the aivideoauto reference path: a reference picture is uploaded as the video's first
// frame, and Gommo rejects one whose ratio/resolution doesn't match the request. Cover
// (not pad) keeps the frame full-bleed; the subject is assumed roughly centered.
async function normalizeImage(srcPath, outPath, w, h) {
  assertReady();
  // w/h go into the -vf filter string. They never reach a shell (run() uses an arg
  // array, shell:false), so this is not an injection guard — it's a fail-FAST: a
  // non-integer/≤0 dimension makes ffmpeg emit an opaque filter-parse error instead
  // of a clear message. Reject before spawning.
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`normalizeImage: w/h phải là số nguyên dương (nhận w=${w}, h=${h})`);
  }
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const { code, stderr } = await run(
    ['-i', srcPath, '-vf', vf, '-frames:v', '1', '-y', outPath],
    PROBE_TIMEOUT_MS
  );
  if (code !== 0) throw new Error('ffmpeg chuẩn hóa ảnh lỗi: ' + stderr.slice(-300));
  return outPath;
}

// Lay a voiceover / music track over a (usually silent) generated video: keep the
// picture untouched (-c:v copy, fast + lossless) and encode the supplied audio as AAC.
// We DROP any audio the video already has (map only the new track) so the Vietnamese
// voiceover isn't mixed with model-generated noise. We do NOT pass -shortest: both the
// full picture AND the full narration survive — if the audio runs longer the last frame
// holds, if shorter the tail is silent. Sizing the script to the clip is the storyboard's
// job. +faststart so the muxed file streams/plays inline on Telegram tap.
async function muxAudio(videoPath, audioPath, outDir) {
  assertReady();
  if (!fs.existsSync(videoPath)) throw new Error('Không thấy video để lồng tiếng: ' + path.basename(String(videoPath)));
  if (!fs.existsSync(audioPath)) throw new Error('Không thấy file giọng/nhạc để lồng: ' + path.basename(String(audioPath)));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'video-long-tieng-' + Date.now() + '.mp4');
  const { code, stderr } = await run(
    ['-i', videoPath, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '-y', outPath],
    KILL_TIMEOUT_MS
  );
  if (code !== 0) throw new Error('ffmpeg lồng tiếng lỗi: ' + stderr.slice(-300));
  return { path: outPath };
}

module.exports = { concat, normalizeImage, muxAudio, _setSpawnForTest, _setBinForTest };
