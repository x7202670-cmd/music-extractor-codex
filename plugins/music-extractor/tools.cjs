'use strict';

const { backend, fromPlatform, identify, resolve } = require('./sources.cjs');
const { download, extractAudio, mediaAddress, selectVideo } = require('./files.cjs');

const qualities = ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster', 'dolby'];
const audioFormats = ['mp3', 'flac', 'wav'];
const platforms = ['netease', 'bilibili', 'douyin'];
const string = (description, maxLength = 2048) => ({ type: 'string', minLength: 1, maxLength, description });
const choice = (values, description) => ({ type: 'string', enum: values, description });
const integer = (minimum, maximum, description) => ({ type: 'integer', minimum, maximum, description });
const limit = integer(1, 50, '最多返回多少首歌曲，默认 20。');
const outputDirectory = string('用户指定的本机绝对保存目录。省略时使用用户目录下的 Downloads/音乐提取器。', 32767);
const mediaReference = {
    platform: choice(platforms, 'netease 为网易云单曲，bilibili 为 B 站视频，douyin 为抖音公开视频或图集。'),
    input: string('平台的单曲、视频或图集分享链接、分享文案、作品 ID，或浏览器导出的图集 JSON（MusicExtractor.DouyinAlbum.v1）。', 262144),
    quality: choice(qualities, '仅用于网易云歌曲。默认 lossless，实际音质取决于平台返回。'),
    resolution: {
        ...string('仅用于 B 站和抖音视频。默认 best，选择平台当前提供的最高分辨率。也可指定档位，例如 720p、1080p、2160p。', 5),
        pattern: '^(best|[1-9][0-9]{2,3}p)$'
    },
    page: integer(1, 99999999, '仅用于 B 站分 P，或抖音图集指定下载第几张（省略则下载全部）。')
};

function summarizeTrack(track) {
    return { id: String(track.id), title: track.name, artist: track.artistNames, album: (track.album || track.al)?.name,
        duration: track.duration, vip: Boolean(track.fee) };
}

function videoResolution(media) {
    return { resolution: media.resolution ?? null, width: media.width, height: media.height,
        availableResolutions: media.availableResolutions ?? [] };
}

async function resolveForTool(args, signal) {
    const media = await resolve(args, signal);
    if (args.platform === 'netease' || media.isAlbum) return media;
    return selectVideo(media, args.resolution ?? 'best', signal);
}

function describe(media, platform, includeLyrics) {
    if (platform === 'netease') {
        return { platform, id: media.id, title: media.name, artist: media.ar_name, album: media.al_name,
            cover: media.pic, quality: media.level, vip: Boolean(media.fee), isPreview: Boolean(media.is_trial),
            downloadAvailable: Boolean(mediaAddress(media.url, platform)), bytes: media.size_bytes,
            ...(includeLyrics ? { lyrics: (media.processedLyrics || media.lyric || '').slice(0, 16000) } : {}) };
    }
    if (platform === 'douyin' && media.isAlbum) {
        return {
            platform,
            id: media.id,
            title: media.title,
            author: media.author,
            duration: media.duration,
            cover: media.cover,
            quality: media.quality,
            isAlbum: true,
            mediaType: media.media_type,
            imageCount: media.imageCount,
            motionCount: media.motionCount,
            downloadAvailable: media.images.some(item =>
                Boolean(mediaAddress(item.image_url, platform) || mediaAddress(item.video_url, platform))),
            items: media.images.map(item => ({
                index: item.index,
                hasImage: Boolean(mediaAddress(item.image_url, platform)),
                hasMotion: Boolean(mediaAddress(item.video_url, platform))
            }))
        };
    }
    return { platform, id: media.id, title: media.title, author: media.author, duration: media.duration,
        cover: media.cover, page: media.page, pageCount: media.pageCount, pageTitle: media.pageTitle,
        quality: media.quality, ...videoResolution(media), downloadAvailable: Boolean(mediaAddress(media.video_url, platform)),
        audioAvailable: Boolean(mediaAddress(platform === 'bilibili' ? media.audio_url : media.video_url, platform)),
        bytes: media.size_bytes };
}

function tool(name, title, description, properties, required, readOnly, openWorld, execute) {
    return {
        definition: { name, title, description,
            inputSchema: { type: 'object', properties, required, additionalProperties: false },
            annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: openWorld } },
        execute
    };
}

const definitions = [
    tool('search_netease', '搜索网易云歌曲', '根据歌名、歌手或关键词搜索网易云，返回候选歌曲和 ID。',
        { keyword: string('用于搜索的关键词。', 200), limit }, ['keyword'], true, true,
        async args => {
            const result = await fromPlatform(() => backend.handleSearch(args.keyword, args.limit ?? 20));
            return { platform: 'netease', total: result.total, tracks: result.data.map(summarizeTrack) };
        }),
    tool('resolve_media', '解析音乐或视频链接', '查看网易云单曲、B 站视频或抖音公开视频/图集（含实况及导出 JSON）的详情、分 P、可选分辨率和下载可用性。',
        { ...mediaReference, includeLyrics: { type: 'boolean', description: '是否在网易云单曲结果中附上歌词，默认 false。' } },
        ['platform', 'input'], true, true,
        async (args, signal) => describe(await resolveForTool(args, signal), args.platform, args.includeLyrics)),
    tool('resolve_netease_playlist', '解析网易云歌单', '根据网易云歌单 ID 或分享链接列出歌曲，可分页读取。',
        { input: string('网易云歌单的分享链接、分享文案或歌单 ID。'),
            offset: integer(0, 1000000, '从第几首开始，按 0 起算。'), limit }, ['input'], true, true,
        async (args, signal) => {
            const { id } = await identify('netease', args.input, 'playlist', signal);
            const { playlist } = await fromPlatform(() => backend.handlePlaylistParse(id));
            const offset = args.offset ?? 0;
            const tracks = playlist.tracks.slice(offset, offset + (args.limit ?? 20)).map(summarizeTrack);
            return { id: String(playlist.id), title: playlist.name, creator: playlist.creator.nickname,
                total: playlist.trackCount, availableTracks: playlist.returnedTrackCount, tracksComplete: playlist.tracksComplete,
                offset, nextOffset: offset + tracks.length < playlist.tracks.length ? offset + tracks.length : null, tracks };
        }),
    tool('download_media', '下载音乐或视频', '保存平台当前提供的媒体。视频可保存为 MP4 或提取 MP3/FLAC/WAV；抖音图集可保存全部或指定序号的原图及实况 MP4。',
        { ...mediaReference, format: choice(['original', ...audioFormats], '默认 original。网易云保留源音频，视频封装成 MP4，抖音图集保存原图和实况 MP4。'),
            outputDirectory }, ['platform', 'input'], false, true,
        async (args, signal) => {
            const media = await resolveForTool(args, signal);
            if (media.isAlbum) {
                return download({ ...args, format: args.format ?? 'original' }, media, signal);
            }
            if (args.resolution && args.resolution !== 'best' && !media.resolution) {
                const available = videoResolution(media).availableResolutions;
                const details = available.length ? '当前可选：' + available.join('、') + '。' : '平台当前未返回可确认的分辨率。';
                throw new Error('平台未提供 ' + args.resolution + ' 视频流。' + details);
            }
            const result = await download({ ...args, format: args.format ?? 'original' }, media, signal);
            if (result.format !== 'mp4') return result;
            const video = { ...videoResolution(media), ...result };
            const quality = args.platform === 'douyin' && video.resolution ? video.resolution.toUpperCase() : media.quality;
            return { ...video, quality };
        }),
    tool('extract_local_audio', '提取本地视频音轨', '在 Windows 本机用 FFmpeg 提取第一条音轨，支持 MP3、FLAC、WAV。',
        { sourcePath: string('本机音视频文件的绝对路径。', 32767),
            format: choice(audioFormats, '输出格式，默认 mp3。'), outputDirectory }, ['sourcePath'], false, false,
        (args, signal) => extractAudio({ ...args, format: args.format ?? 'mp3' }, signal))
];

const byName = new Map(definitions.map(entry => [entry.definition.name, entry]));

function validate(args, schema) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数须为对象。');
    for (const key of schema.required) {
        if (!Object.hasOwn(args, key)) throw new Error('缺少工具参数 ' + key + '。');
    }
    const result = {};
    for (const [key, original] of Object.entries(args)) {
        if (!Object.hasOwn(schema.properties, key)) throw new Error('不支持的工具参数 ' + key + '。');
        const rule = schema.properties[key];
        const value = typeof original === 'string' ? original.trim() : original;
        const valid = rule.type === 'string' ?
            typeof value === 'string' && value.length > 0 && (!rule.maxLength || value.length <= rule.maxLength) &&
            (!rule.enum || rule.enum.includes(value)) && (!rule.pattern || new RegExp(rule.pattern).test(value)) :
            rule.type === 'integer' ? Number.isInteger(value) && value >= rule.minimum && value <= rule.maximum :
                typeof value === 'boolean';
        if (!valid) throw new Error('工具参数 ' + key + ' 的值无效。');
        result[key] = value;
    }
    return result;
}

module.exports = {
    list: definitions.map(entry => entry.definition),
    has: name => byName.has(name),
    call(name, args, signal) {
        const entry = byName.get(name);
        return entry.execute(validate(args, entry.definition.inputSchema), signal);
    }
};
