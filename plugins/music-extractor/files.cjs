'use strict';

const { spawn } = require('node:child_process');
const { constants, createWriteStream, existsSync, realpath } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { backend } = require('./sources.cjs');

const resolvePath = promisify(realpath);
const bundledEngine = path.join(__dirname, 'ffmpeg.exe');
const projectEngine = path.join(__dirname, '../../native-app/vendor/ffmpeg.exe');
const engine = process.env.MUSIC_EXTRACTOR_FFMPEG ||
    [bundledEngine, projectEngine].find(candidate => existsSync(candidate)) ||
    (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const encoders = { mp3: ['libmp3lame', '-b:a', '192k'], flac: ['flac'], wav: ['pcm_s16le'] };
const inputFormats = 'mov,matroska,webm,mp3,flac,wav,aac,avi,mpeg,mpegts,ogg,flv,asf,mp4,m4a,m4v,3gp,3g2,mj2,aiff,ac3,rm,ape,amr,au';
const inputArgs = source => ['-protocol_whitelist', 'file', '-format_whitelist', inputFormats, '-i', source];
const probeBytes = 512 * 1024;
const referers = {
    netease: 'https://music.163.com/',
    bilibili: 'https://www.bilibili.com/',
    douyin: 'https://www.douyin.com/'
};

function absoluteFilePath(value) {
    if (process.platform === 'win32') {
        // A drive-qualified path avoids device namespaces, UNC paths and alternate data streams.
        return /^[a-z]:[\\/][^:"<>|?*\x00-\x1f]*$/i.test(value) &&
            !value.split(/[\\/]/).slice(1).some(part => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(part));
    }
    return path.isAbsolute(value) && !value.includes('\0');
}

function safeStem(value) {
    const name = Array.from(String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '')).slice(0, 65).join('');
    if (!name) return 'media';
    return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(name) ? '_' + name : name;
}

async function invokeEngine(args, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(engine, ['-hide_banner', '-nostdin', '-nostats', '-n', ...args],
            { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
        let diagnostics = '';
        let startupFailure;
        child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
        child.once('error', failure => { startupFailure = failure; });
        child.once('close', code => {
            if (signal.aborted) return reject(signal.reason);
            if (startupFailure) return reject(new Error('无法启动 FFmpeg。请安装 FFmpeg 并加入 PATH，或设置 MUSIC_EXTRACTOR_FFMPEG。'));
            resolve({ code, diagnostics });
        });
    });
}

function videoDimensions(diagnostics) {
    const match = /Stream #\d+:.*?Video:[^\r\n]*?,\s*(\d{2,5})x(\d{2,5})(?=\s|,)/.exec(diagnostics);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return { width, height, pixels: Math.min(width, height) };
}

async function runEngine(inputPath, outputPath, format, signal, separateAudioPath) {
    const outputArgs = format === 'mp4'
        ? ['-map', '0:v:0', '-map', separateAudioPath ? '1:a:0' : '0:a:0?', '-sn', '-dn', '-c', 'copy', '-movflags', '+faststart']
        : ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', ...encoders[format]];
    const { code, diagnostics } = await invokeEngine([
        '-loglevel', format === 'mp4' ? 'info' : 'error', ...inputArgs(inputPath),
        ...(separateAudioPath ? inputArgs(separateAudioPath) : []), ...outputArgs, outputPath
    ], signal);
    if (code !== 0) {
        const missingAudio = /matches no streams|does not contain any stream/i.test(diagnostics);
        throw new Error(missingAudio && format !== 'mp4' ? '输入文件没有可提取的音轨。' :
            'FFmpeg 无法处理该媒体文件。请确认文件完整且包含所需的音视频流。');
    }
    return format === 'mp4' ? videoDimensions(diagnostics) : null;
}

async function writeOutput(outputDirectory, name, extension, signal, create) {
    const directory = outputDirectory || path.join(os.homedir(), 'Downloads', '音乐提取器');
    if (!absoluteFilePath(directory)) throw new Error('保存目录须为本机的绝对路径。');
    signal.throwIfAborted();
    await fs.mkdir(directory, { recursive: true });
    const outputRoot = await resolvePath(directory);
    if (!absoluteFilePath(outputRoot)) throw new Error('保存目录须位于本机。');
    const temp = await fs.mkdtemp(path.join(outputRoot, '.music-extractor-'));
    try {
        const output = path.join(temp, 'output.' + extension);
        await create(output, temp);
        signal.throwIfAborted();
        const { size } = await fs.stat(output);
        if (!size) throw new Error('生成的媒体文件为空。');

        const stem = safeStem(name);
        for (let index = 0; ; index++) {
            const destination = path.join(outputRoot, stem + (index ? ' (' + index + ')' : '') + '.' + extension);
            try {
                // The same-directory hard link publishes a complete file without overwriting a concurrent result.
                await fs.link(output, destination);
                return { path: destination, format: extension, bytes: size };
            } catch (failure) {
                if (failure.code === 'EEXIST') continue;
                if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(failure.code)) throw failure;
                try {
                    await fs.copyFile(output, destination, constants.COPYFILE_EXCL);
                    return { path: destination, format: extension, bytes: size };
                } catch (copyError) {
                    if (copyError.code !== 'EEXIST') throw copyError;
                }
            }
        }
    } finally {
        await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function extractAudio({ sourcePath, outputDirectory, format }, signal) {
    if (!absoluteFilePath(sourcePath)) throw new Error('音视频文件须为本机的绝对路径。');
    const inputPath = await resolvePath(sourcePath).catch(failure => {
        if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') return null;
        throw failure;
    });
    if (!inputPath || !absoluteFilePath(inputPath) || !(await fs.stat(inputPath)).isFile()) {
        throw new Error('找不到可读取的本地音视频文件。');
    }
    return writeOutput(outputDirectory, path.parse(inputPath).name, format, signal,
        outputPath => runEngine(inputPath, outputPath, format, signal));
}

function mediaAddress(raw, platform) {
    if (typeof raw !== 'string') return null;
    const url = raw.replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
    return backend.isPlatformMediaUrl(url, platform) ? url : null;
}

async function fetchMedia(address, platform, target, signal, prefixOnly = false) {
    const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(prefixOnly ? 5000 : 15 * 60 * 1000)]);
    for (let hop = 0; address && hop <= 5; hop++) {
        const response = await fetch(address, {
            redirect: 'manual', signal: fetchSignal,
            headers: {
                Referer: referers[platform],
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                ...(prefixOnly ? { Range: `bytes=0-${probeBytes - 1}` } : {})
            }
        });
        if (response.status >= 300 && response.status < 400) {
            const next = response.headers.get('location');
            await response.body?.cancel();
            address = next && mediaAddress(new URL(next, address).href, platform);
            continue;
        }
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !response.body || (type && !/^(audio\/|video\/|(?:application|binary)\/octet-stream\b)/i.test(type))) {
            await response.body?.cancel();
            throw new Error('平台未返回可下载的媒体文件（HTTP ' + response.status + '）。');
        }
        let remaining = probeBytes;
        const chunks = async function* (source) {
            for await (const chunk of source) {
                yield chunk.subarray(0, remaining);
                remaining -= chunk.length;
                if (remaining <= 0) break;
            }
        };
        const input = Readable.fromWeb(response.body);
        const output = createWriteStream(target, { flags: 'wx' });
        await pipeline(input, ...(prefixOnly ? [chunks] : []), output, { signal: fetchSignal });
        return;
    }
    throw new Error('平台媒体链接已失效，或重定向到了其他站点。');
}

async function probeVideoStream(address, platform, signal) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'music-extractor-probe-'));
    try {
        const sample = path.join(directory, 'sample.media');
        await fetchMedia(address, platform, sample, signal, true);
        const { diagnostics } = await invokeEngine([
            ...inputArgs(sample), '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'null', '-'
        ], AbortSignal.any([signal, AbortSignal.timeout(3000)]));
        return videoDimensions(diagnostics);
    } catch {
        signal.throwIfAborted();
        return null;
    } finally {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function selectVideo(media, resolution, signal) {
    const candidates = new Map(media.videoStreams.map(stream => [stream.url, stream]));
    const streams = await Promise.all([...candidates.values()].map(async stream => {
        if (media.platform === 'bilibili' && stream.pixels) return stream;
        return { ...stream, ...await probeVideoStream(stream.url, media.platform, signal) };
    }));
    const { selected, ...video } = backend.selectVideoStream(streams, resolution);
    if (media.platform === 'douyin') {
        return { ...media, ...video, quality: video.quality || (selected ? '官方分享版本' : undefined) };
    }
    const separateAudio = selected?.audio || (!selected && resolution === 'best' ? media.dashAudio : '');
    const audioUrl = separateAudio || (selected?.dash ? '' : video.video_url);
    return { ...media, ...video, audio_url: audioUrl, separateAudio: Boolean(separateAudio) };
}

async function download({ platform, format, outputDirectory, resolution }, media, signal) {
    const source = platform === 'netease' ? media.url :
        platform === 'bilibili' && format !== 'original' ? media.audio_url : media.video_url;
    const address = mediaAddress(source, platform);
    if (!address) throw new Error('平台有媒体信息，但当前没有提供可下载的官方音视频流。');
    const nativeFormat = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg'].includes(media.ext) ? media.ext : null;
    const originalTrack = platform === 'netease' && format === 'original' && nativeFormat;
    const extension = format !== 'original' ? format : platform === 'netease' ? (nativeFormat || 'mp3') : 'mp4';
    const name = platform === 'netease' ? media.name + ' - ' + media.ar_name + (media.is_trial ? ' (试听)' : '') :
        media.title + (media.pageCount > 1 ? ` - P${media.page}` : '');

    let dimensions;
    const result = await writeOutput(outputDirectory, name, extension, signal, async (output, temp) => {
        const downloaded = originalTrack ? output : path.join(temp, 'source.media');
        await fetchMedia(address, platform, downloaded, signal);
        let separateAudioPath;
        if (extension === 'mp4' && media.separateAudio) {
            separateAudioPath = path.join(temp, 'audio.media');
            await fetchMedia(mediaAddress(media.audio_url, platform), platform, separateAudioPath, signal);
        }
        if (!originalTrack) dimensions = await runEngine(downloaded, output, extension, signal, separateAudioPath);
        if (extension === 'mp4' && resolution && resolution !== 'best' &&
            (!dimensions || `${dimensions.pixels}p` !== resolution)) {
            const actual = dimensions ? `实际返回 ${dimensions.width}×${dimensions.height}。` : '无法确认实际分辨率。';
            throw new Error('下载流与请求的 ' + resolution + ' 不符。' + actual);
        }
    });
    return { ...result, platform, id: media.id, title: media.name || media.title,
        ...(platform === 'netease' ? { isPreview: Boolean(media.is_trial), quality: media.level } : {}),
        ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
        ...(dimensions ? { resolution: `${dimensions.pixels}p` } : {}) };
}

module.exports = { download, extractAudio, mediaAddress, selectVideo };
