import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const DEFAULT_TRANSCODE_TIMEOUT_MS = Number(process.env.SPONSOR_TRANSCODE_TIMEOUT_MS || 180000);
const DEFAULT_PROBE_TIMEOUT_MS = Number(process.env.SPONSOR_PROBE_TIMEOUT_MS || 20000);
const DEFAULT_THUMBNAIL_TIMEOUT_MS = Number(process.env.SPONSOR_THUMBNAIL_TIMEOUT_MS || 30000);
const THUMBNAIL_MAX_BYTES = Number(process.env.SPONSOR_THUMBNAIL_MAX_BYTES || 260000);

function commandAvailable(command) {
  const result = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function resolveCommand(envName, fallbackCommand) {
  const configured = String(process.env[envName] || '').trim();
  if (configured && commandAvailable(configured)) return configured;
  if (commandAvailable(fallbackCommand)) return fallbackCommand;
  return '';
}

export function getSponsorMediaToolStatus() {
  const ffmpeg = resolveCommand('FFMPEG_PATH', 'ffmpeg');
  const ffprobe = resolveCommand('FFPROBE_PATH', 'ffprobe');
  return {
    ffmpeg,
    ffprobe,
    ffmpegAvailable: Boolean(ffmpeg),
    ffprobeAvailable: Boolean(ffprobe),
    transcodeEnabled: process.env.SPONSOR_TRANSCODE_ENABLED !== 'false',
  };
}

function runTool(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error((stderr || stdout || `${path.basename(command)} exited with ${code}`).slice(0, 1200)));
    });
  });
}

function parsePositiveNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback = null) {
  const parsed = parsePositiveNumber(value, fallback);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function sanitizeThumbnailData(value) {
  const text = String(value || '');
  if (!/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(text)) return '';
  return text.slice(0, THUMBNAIL_MAX_BYTES);
}

function aspectRatioLabel(width, height) {
  if (!width || !height) return '';
  const ratio = width / height;
  if (Math.abs(ratio - (16 / 9)) < 0.04) return '16:9';
  if (Math.abs(ratio - (9 / 16)) < 0.04) return '9:16';
  if (Math.abs(ratio - 1) < 0.04) return '1:1';
  return `${width}:${height}`;
}

function safeDerivedFilename(filename, suffix, ext) {
  const originalExt = path.extname(filename || '');
  const base = path.basename(filename || `sponsor-${Date.now()}`, originalExt)
    .replace(/[^a-z0-9_.-]/gi, '-')
    .slice(0, 120) || `sponsor-${Date.now()}`;
  return `${base}${suffix}${ext}`;
}

function metadataFromBrowserProbe(file, body = {}) {
  const width = parsePositiveInteger(body.width);
  const height = parsePositiveInteger(body.height);
  return {
    durationSeconds: parsePositiveNumber(body.durationSeconds),
    width,
    height,
    fileSize: Number(file?.size || body.fileSize || 0) || 0,
    mimeType: String(file?.mimetype || body.mimeType || '').slice(0, 120),
    aspectRatio: aspectRatioLabel(width, height),
    thumbnailData: sanitizeThumbnailData(body.thumbnailData),
    videoCodec: '',
    audioCodec: '',
    bitRate: null,
  };
}

function metadataFromProbeJson(probe = {}) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video') || {};
  const audio = streams.find(stream => stream.codec_type === 'audio') || {};
  const format = probe.format || {};
  const width = parsePositiveInteger(video.width);
  const height = parsePositiveInteger(video.height);
  return {
    durationSeconds: parsePositiveNumber(format.duration) || parsePositiveNumber(video.duration),
    width,
    height,
    fileSize: parsePositiveInteger(format.size),
    mimeType: '',
    aspectRatio: aspectRatioLabel(width, height),
    videoCodec: String(video.codec_name || '').slice(0, 80),
    audioCodec: String(audio.codec_name || '').slice(0, 80),
    bitRate: parsePositiveInteger(format.bit_rate),
  };
}

function mergeMetadata(base, next) {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(next || {}).filter(([, value]) => value !== null && value !== undefined && value !== '')),
    thumbnailData: next?.thumbnailData || base.thumbnailData || '',
    mimeType: next?.mimeType || base.mimeType || '',
  };
}

function buildQualityWarnings(file, metadata, options = {}) {
  const warnings = [];
  const mimeType = metadata.mimeType || file?.mimetype || '';
  if (mimeType && mimeType !== 'video/mp4') warnings.push('MP4 H.264/AAC is recommended for OBS-safe playback.');
  if (metadata.videoCodec && metadata.videoCodec !== 'h264') warnings.push(`Video codec is ${metadata.videoCodec}; H.264 is recommended.`);
  if (metadata.audioCodec && metadata.audioCodec !== 'aac') warnings.push(`Audio codec is ${metadata.audioCodec}; AAC is recommended.`);
  if (!metadata.durationSeconds) warnings.push('Duration could not be verified.');
  else if (metadata.durationSeconds > 120) warnings.push('Keep arena moments under 120 seconds.');
  else if (metadata.durationSeconds > 30) warnings.push('Shorter 10-30 second placements usually hold attention better.');
  if (metadata.width && metadata.height) {
    const ratio = metadata.width / metadata.height;
    if (Math.abs(ratio - (16 / 9)) > 0.08) warnings.push('16:9 video is recommended for full-screen placement.');
    if (metadata.width < 1280 || metadata.height < 720) warnings.push('720p or 1080p video is recommended.');
  } else {
    warnings.push('Resolution could not be verified.');
  }
  if ((metadata.fileSize || file?.size || 0) > 100 * 1024 * 1024) warnings.push('Large files can buffer in OBS; compress before production use.');
  if (!options.ffprobeAvailable) warnings.push('Server ffprobe is unavailable; metadata was limited to browser-provided values.');
  if (!options.ffmpegAvailable) warnings.push('Server FFmpeg is unavailable; video was not normalized.');
  return warnings;
}

async function probeMedia(filePath, ffprobe) {
  const result = await runTool(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], DEFAULT_PROBE_TIMEOUT_MS);
  return JSON.parse(result.stdout || '{}');
}

async function transcodeToMp4(inputPath, outputPath, ffmpeg) {
  await runTool(ffmpeg, [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-c:v', 'libx264',
    '-preset', process.env.SPONSOR_TRANSCODE_PRESET || 'veryfast',
    '-crf', String(process.env.SPONSOR_TRANSCODE_CRF || 23),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    outputPath,
  ], DEFAULT_TRANSCODE_TIMEOUT_MS);
}

async function generateThumbnail(inputPath, outputPath, ffmpeg) {
  await runTool(ffmpeg, [
    '-y',
    '-ss', '00:00:00.5',
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '4',
    outputPath,
  ], DEFAULT_THUMBNAIL_TIMEOUT_MS);
}

function thumbnailDataUrl(filepath) {
  try {
    const stat = fs.statSync(filepath);
    if (!stat.size || stat.size > THUMBNAIL_MAX_BYTES) return '';
    return `data:image/jpeg;base64,${fs.readFileSync(filepath).toString('base64')}`;
  } catch (_err) {
    return '';
  }
}

export async function processSponsorUpload({ file, body = {}, targetDir }) {
  if (!file?.path || !targetDir) throw new Error('Sponsor upload file is missing');

  const tools = getSponsorMediaToolStatus();
  let activePath = file.path;
  let activeFilename = file.filename;
  let normalized = false;
  let processingStatus = 'ready';
  let processingMessage = '';
  let metadata = metadataFromBrowserProbe(file, body);

  if (tools.ffprobeAvailable) {
    try {
      metadata = mergeMetadata(metadata, metadataFromProbeJson(await probeMedia(activePath, tools.ffprobe)));
    } catch (err) {
      processingMessage = `ffprobe failed: ${err.message}`;
    }
  }

  if (tools.transcodeEnabled && tools.ffmpegAvailable) {
    const normalizedFilename = safeDerivedFilename(file.filename, '-normalized', '.mp4');
    const normalizedPath = path.join(targetDir, normalizedFilename);
    try {
      processingStatus = 'processing';
      await transcodeToMp4(activePath, normalizedPath, tools.ffmpeg);
      if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).size > 0) {
        try { if (normalizedPath !== activePath && fs.existsSync(activePath)) fs.unlinkSync(activePath); } catch (_err) {}
        activePath = normalizedPath;
        activeFilename = normalizedFilename;
        normalized = true;
        processingStatus = 'normalized';
        processingMessage = 'Normalized to MP4 H.264/AAC 16:9 720p.';
        if (tools.ffprobeAvailable) {
          metadata = mergeMetadata(metadata, metadataFromProbeJson(await probeMedia(activePath, tools.ffprobe)));
        }
      }
    } catch (err) {
      processingStatus = 'ready';
      processingMessage = `Normalization skipped: ${err.message}`;
      try { if (fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath); } catch (_cleanupErr) {}
    }
  } else if (!tools.ffmpegAvailable) {
    processingMessage = processingMessage || 'Server FFmpeg unavailable; using original upload.';
  }

  if (tools.ffmpegAvailable) {
    const thumbnailFilename = safeDerivedFilename(activeFilename, '-thumb', '.jpg');
    const thumbnailPath = path.join(targetDir, thumbnailFilename);
    try {
      await generateThumbnail(activePath, thumbnailPath, tools.ffmpeg);
      metadata.thumbnailData = thumbnailDataUrl(thumbnailPath) || metadata.thumbnailData;
      try { if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath); } catch (_err) {}
    } catch (err) {
      if (!metadata.thumbnailData) processingMessage = processingMessage || `Thumbnail generation skipped: ${err.message}`;
    }
  }

  const stat = fs.statSync(activePath);
  metadata.fileSize = stat.size || metadata.fileSize || file.size || 0;
  metadata.mimeType = normalized ? 'video/mp4' : metadata.mimeType;
  metadata.aspectRatio = aspectRatioLabel(metadata.width, metadata.height);
  const warnings = buildQualityWarnings(file, metadata, tools);
  if (normalized) {
    const normalizedWarning = warnings.find(warning => /ffprobe|Duration|Resolution/i.test(warning));
    metadata.qualityWarnings = normalizedWarning ? [normalizedWarning] : [];
  } else {
    metadata.qualityWarnings = warnings;
  }

  return {
    filename: activeFilename,
    filepath: activePath,
    originalFilename: file.filename,
    originalName: file.originalname,
    normalized,
    processingStatus,
    processingMessage,
    processedAt: new Date().toISOString(),
    ...metadata,
    toolStatus: tools,
  };
}
