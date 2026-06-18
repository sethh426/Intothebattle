import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const DEFAULT_TRANSCODE_TIMEOUT_MS = Number(process.env.SPONSOR_TRANSCODE_TIMEOUT_MS || 180000);
const DEFAULT_PROBE_TIMEOUT_MS = Number(process.env.SPONSOR_PROBE_TIMEOUT_MS || 20000);
const DEFAULT_THUMBNAIL_TIMEOUT_MS = Number(process.env.SPONSOR_THUMBNAIL_TIMEOUT_MS || 30000);
const THUMBNAIL_MAX_BYTES = Number(process.env.SPONSOR_THUMBNAIL_MAX_BYTES || 260000);
const MB = 1024 * 1024;
const MAX_DURATION_SECONDS = Number(process.env.SPONSOR_VIDEO_MAX_SECONDS || 120);
const RECOMMENDED_MAX_DURATION_SECONDS = Number(process.env.SPONSOR_VIDEO_RECOMMENDED_MAX_SECONDS || 30);
const MAX_FILE_BYTES = Number(process.env.SPONSOR_VIDEO_MAX_MB || 100) * MB;
const MIN_RECOMMENDED_WIDTH = Number(process.env.SPONSOR_VIDEO_MIN_WIDTH || 1280);
const MIN_RECOMMENDED_HEIGHT = Number(process.env.SPONSOR_VIDEO_MIN_HEIGHT || 720);
const MIN_ACCEPTABLE_WIDTH = Number(process.env.SPONSOR_VIDEO_MIN_ACCEPTABLE_WIDTH || 640);
const MIN_ACCEPTABLE_HEIGHT = Number(process.env.SPONSOR_VIDEO_MIN_ACCEPTABLE_HEIGHT || 360);
const SUPPORTED_VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const SUPPORTED_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const OBS_SAFE_VIDEO_CODECS = new Set(['h264']);
const OBS_SAFE_AUDIO_CODECS = new Set(['', 'aac', 'mp3']);

function strictMediaGateEnabled(options = {}) {
  if (options.strict != null) return Boolean(options.strict);
  if (process.env.SPONSOR_STRICT_MEDIA_GATE != null) {
    return process.env.SPONSOR_STRICT_MEDIA_GATE !== 'false';
  }
  return process.env.NODE_ENV === 'production';
}

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

function uniqueMessages(messages = []) {
  return Array.from(new Set(messages.filter(Boolean)));
}

function fileExtensionForQuality(file = {}, metadata = {}) {
  return path.extname(metadata.filename || file.originalname || file.originalName || file.filename || '').toLowerCase();
}

function qualityScore(blockers, warnings) {
  return Math.max(0, Math.min(100, 100 - (blockers.length * 35) - (warnings.length * 10)));
}

export function evaluateSponsorMediaQuality({ file = {}, metadata = {}, tools = {}, normalized = false, strict = null } = {}) {
  const strictGate = strictMediaGateEnabled({ strict });
  const blockers = [];
  const warnings = [];
  const recommendations = [];
  const mimeType = String(metadata.mimeType || file.mimetype || '').toLowerCase();
  const ext = fileExtensionForQuality(file, metadata);
  const fileSize = Number(metadata.fileSize || file.size || 0) || 0;
  const durationSeconds = Number(metadata.durationSeconds || 0) || 0;
  const width = Number(metadata.width || 0) || 0;
  const height = Number(metadata.height || 0) || 0;
  const videoCodec = String(metadata.videoCodec || '').toLowerCase();
  const audioCodec = String(metadata.audioCodec || '').toLowerCase();
  const hasSupportedExt = SUPPORTED_VIDEO_EXTS.has(ext);
  const hasSupportedMime = !mimeType || SUPPORTED_VIDEO_MIMES.has(mimeType);
  const looksLikeVideo = (mimeType && mimeType.startsWith('video/')) || hasSupportedExt;
  const isMp4Container = mimeType === 'video/mp4' || ext === '.mp4' || ext === '.m4v';
  const isKnownObsSafe = isMp4Container
    && (!videoCodec || OBS_SAFE_VIDEO_CODECS.has(videoCodec))
    && (!audioCodec || OBS_SAFE_AUDIO_CODECS.has(audioCodec));

  if (!looksLikeVideo) blockers.push('Upload a video file for sponsor breaks.');
  if (!hasSupportedExt && !hasSupportedMime) blockers.push('Use MP4, M4V, WebM, or MOV video.');
  if (fileSize <= 0) blockers.push('Uploaded video is empty.');
  if (fileSize > MAX_FILE_BYTES) blockers.push(`Video is too large. Keep sponsor creatives under ${Math.round(MAX_FILE_BYTES / MB)}MB.`);

  if (durationSeconds > MAX_DURATION_SECONDS) {
    blockers.push(`Video is too long. Keep sponsor creatives under ${MAX_DURATION_SECONDS} seconds.`);
  } else if (durationSeconds > RECOMMENDED_MAX_DURATION_SECONDS) {
    recommendations.push(`Shorter ${Math.min(10, RECOMMENDED_MAX_DURATION_SECONDS)}-${RECOMMENDED_MAX_DURATION_SECONDS} second placements usually hold attention better.`);
  } else if (!durationSeconds) {
    warnings.push('Duration could not be verified before playback.');
  }

  if (width && height) {
    const ratio = width / height;
    if (width < MIN_ACCEPTABLE_WIDTH || height < MIN_ACCEPTABLE_HEIGHT) {
      blockers.push(`Video resolution is too low. Use at least ${MIN_ACCEPTABLE_WIDTH}x${MIN_ACCEPTABLE_HEIGHT}.`);
    } else if (width < MIN_RECOMMENDED_WIDTH || height < MIN_RECOMMENDED_HEIGHT) {
      recommendations.push(`${MIN_RECOMMENDED_HEIGHT}p or 1080p video is recommended.`);
    }
    if (Math.abs(ratio - (16 / 9)) > 0.08) recommendations.push('16:9 video is recommended for full-screen placement.');
  } else {
    warnings.push('Resolution could not be verified before playback.');
  }

  if (videoCodec && !OBS_SAFE_VIDEO_CODECS.has(videoCodec)) {
    const message = `Video codec is ${videoCodec}; H.264 is required for the safest OBS/browser playback.`;
    if (strictGate || normalized || !tools.ffmpegAvailable) blockers.push(message);
    else recommendations.push(message);
  }
  if (audioCodec && !OBS_SAFE_AUDIO_CODECS.has(audioCodec)) {
    const message = `Audio codec is ${audioCodec}; AAC is recommended.`;
    if (strictGate && !tools.ffmpegAvailable) blockers.push(message);
    else recommendations.push(message);
  }

  if (!normalized && strictGate && mimeType && mimeType !== 'video/mp4' && !tools.ffmpegAvailable) {
    blockers.push('Non-MP4 uploads need FFmpeg normalization before production playback.');
  } else if (!normalized && mimeType && mimeType !== 'video/mp4') {
    recommendations.push('MP4 H.264/AAC is recommended for OBS-safe playback.');
  }
  if (!tools.ffprobeAvailable) warnings.push('Server ffprobe is unavailable; metadata was limited to browser-provided values.');
  if (!normalized && !tools.ffmpegAvailable && !isKnownObsSafe) warnings.push('Server FFmpeg is unavailable; video was not normalized.');

  const finalBlockers = uniqueMessages(blockers);
  const finalWarnings = uniqueMessages(warnings);
  const finalRecommendations = uniqueMessages(recommendations);
  return {
    status: finalBlockers.length ? 'blocked' : finalWarnings.length || finalRecommendations.length ? 'warn' : 'ready',
    score: qualityScore(finalBlockers, [...finalWarnings, ...finalRecommendations]),
    blockers: finalBlockers,
    warnings: finalWarnings,
    recommendations: finalRecommendations,
    strict: strictGate,
    limits: {
      maxDurationSeconds: MAX_DURATION_SECONDS,
      recommendedMaxDurationSeconds: RECOMMENDED_MAX_DURATION_SECONDS,
      maxFileBytes: MAX_FILE_BYTES,
      minRecommendedWidth: MIN_RECOMMENDED_WIDTH,
      minRecommendedHeight: MIN_RECOMMENDED_HEIGHT,
    },
  };
}

export class SponsorMediaQualityError extends Error {
  constructor(qualityGate) {
    const detail = qualityGate?.blockers?.join(' ') || 'Sponsor video did not pass the production quality gate.';
    super(detail);
    this.name = 'SponsorMediaQualityError';
    this.statusCode = 422;
    this.qualityGate = qualityGate;
  }
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
  const qualityGate = evaluateSponsorMediaQuality({
    file: { ...file, filename: activeFilename, originalname: file.originalname },
    metadata: { ...metadata, filename: activeFilename },
    tools,
    normalized,
  });
  if (qualityGate.status === 'blocked') {
    try { if (activePath && fs.existsSync(activePath)) fs.unlinkSync(activePath); } catch (_err) {}
    throw new SponsorMediaQualityError(qualityGate);
  }
  metadata.qualityWarnings = qualityGate.warnings;

  return {
    filename: activeFilename,
    filepath: activePath,
    originalFilename: file.filename,
    originalName: file.originalname,
    normalized,
    processingStatus,
    processingMessage,
    processedAt: new Date().toISOString(),
    qualityGateStatus: qualityGate.status,
    qualityGateScore: qualityGate.score,
    qualityGateBlockers: qualityGate.blockers,
    qualityRecommendations: qualityGate.recommendations,
    ...metadata,
    toolStatus: tools,
  };
}
