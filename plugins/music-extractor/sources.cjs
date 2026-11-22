'use strict';

const { existsSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bundledBackend = path.join(__dirname, 'backend.cjs');
const backend = require(existsSync(bundledBackend) ? bundledBackend : '../../server.js');

const sources = {
    netease: {
        hosts: ['music.163.com', 'y.music.163.com', '163cn.tv', '163.lu'],
        shortHosts: ['y.music.163.com', '163cn.tv', '163.lu'],
        invalid: '请提供网易云歌曲或歌单的链接，或纯数字 ID。'
    },
    bilibili: {
        hosts: ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com', 'b23.tv'],
        shortHosts: ['b23.tv'],
        invalid: '请提供 B 站视频链接、BV 号或 AV 号。'
    },
    douyin: {
        hosts: ['www.douyin.com', 'm.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com'],
        shortHosts: ['v.douyin.com'],
        invalid: '请提供抖音公开视频链接、分享文案或纯数字视频 ID。'
    }
};

function platformUrl(input, platform) {
    try {
        const url = new URL(input);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
            sources[platform].hosts.includes(url.hostname)) {
            url.protocol = 'https:';
            return url;
        }
    } catch {}
    return null;
}

function parseId(platform, input) {
    if (platform === 'bilibili') {
        if (/^BV[\da-z]{10}$/i.test(input)) return 'BV' + input.slice(2);
        if (/^av\d{1,18}$/i.test(input)) return input.toLowerCase();
    } else if (platform === 'netease' ? /^\d{1,16}$/.test(input) : /^\d{16,21}$/.test(input)) {
        return input;
    }
    return null;
}

async function identify(platform, input, kind, signal) {
    const directId = parseId(platform, input);
    if (directId) return { id: directId };

    const candidates = input.match(/(?:https?:\/\/|www\.|music\.163\.com\/|y\.music\.163\.com\/|163cn\.tv\/|163\.lu\/|m\.bilibili\.com\/|b23\.tv\/|v\.douyin\.com\/)[^\s<>"'，。！？、；）】]+/gi) || [];
    let url = candidates.map(value => value.replace(/[),.!;]+$/, '')).map(value =>
        platformUrl(/^https?:\/\//i.test(value) ? value : 'https://' + value, platform)).find(Boolean);

    for (let hop = 0; url && hop <= 4; hop++) {
        const route = platform === 'netease' && url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
        let id;
        if (platform === 'netease') {
            const escapedKind = kind === 'playlist' ? 'playlist' : 'song';
            const match = route.pathname.match(new RegExp('^/(?:m/)?' + escapedKind + '(?:/(\\d+))?/?$'));
            if (match) id = parseId(platform, match[1] || route.searchParams.get('id') || '');
        } else if (platform === 'bilibili') {
            id = parseId(platform, route.pathname.match(/^\/video\/([^/]+)\/?$/i)?.[1] || '');
        } else {
            if (/\/(?:note|slides)\//i.test(route.pathname)) {
                throw new Error('此链接是抖音图集，请在原软件的浏览器辅助功能中处理。');
            }
            const match = route.pathname.match(/\/(?:share\/)?video\/(\d+)\/?$/i);
            id = parseId(platform, match?.[1] || route.searchParams.get('modal_id') || '');
        }
        if (id) {
            const page = platform === 'bilibili' ? route.searchParams.get('p') : null;
            return { id, page: page && /^\d{1,8}$/.test(page) && Number(page) > 0 ? Number(page) : undefined };
        }
        if (!sources[platform].shortHosts.includes(url.hostname) || hop === 4) break;
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' } });
        const location = response.headers.get('location');
        await response.body?.cancel();
        url = location && response.status >= 300 && response.status < 400 ?
            platformUrl(new URL(location, url), platform) : null;
    }
    throw new Error(sources[platform].invalid);
}

async function fromPlatform(action) {
    let result;
    try {
        result = await action();
    } catch {
        throw new Error('无法连接平台服务，请检查网络后重试。');
    }
    if (result.code !== 200) throw new Error(result.msg || '平台没有返回可用结果。');
    return result;
}

async function readConfiguredSession(envName, fileName, readError) {
    const configured = process.env[envName];
    if (configured !== undefined) return configured;
    const file = path.join(os.homedir(), '.music-extractor', fileName);
    try {
        return await readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw new Error(readError);
    }
}

async function bilibiliSession() {
    const configured = await readConfiguredSession(
        'MUSIC_EXTRACTOR_BILIBILI_SESSION',
        'bilibili-session.txt',
        '无法读取本地 B 站登录配置。'
    );
    if (configured === undefined) return undefined;
    const value = configured.trim().replace(/^SESSDATA=/, '');
    if (!value) return undefined;
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(value)) {
        throw new Error('本地 B 站登录配置无效，请只配置 SESSDATA 的原始值。');
    }
    return 'SESSDATA=' + value;
}

async function neteaseSession() {
    const configured = await readConfiguredSession(
        'MUSIC_EXTRACTOR_NETEASE_SESSION',
        'netease-session.txt',
        '无法读取本地网易云登录配置。'
    );
    if (configured === undefined) return undefined;
    const trimmed = configured.trim();
    if (!trimmed) return undefined;
    const match = trimmed.match(/(?:^|;\s*)MUSIC_U=([A-Za-z0-9]+)(?:;|$)/i);
    const value = match ? match[1] : trimmed.replace(/^MUSIC_U=/i, '').trim();
    if (!/^[A-Za-z0-9]{10,4096}$/.test(value)) {
        throw new Error('本地网易云登录配置无效，请配置 MUSIC_U 的原始值或包含 MUSIC_U 的 Cookie。');
    }
    return 'MUSIC_U=' + value;
}

async function resolve({ platform, input, quality, page, resolution }, signal) {
    if (platform === 'netease' && resolution !== undefined) throw new Error('resolution 仅用于 B 站和抖音视频。');
    const reference = await identify(platform, input, 'song', signal);
    signal.throwIfAborted();
    if (platform === 'netease') {
        const session = await neteaseSession();
        return fromPlatform(() => backend.handleSongParse(reference.id, quality, { officialOnly: true, session }));
    }
    if (platform === 'bilibili') {
        const session = await bilibiliSession();
        return fromPlatform(() => backend.handleBilibiliParse(reference.id, {
            officialOnly: true, page: page ?? reference.page ?? 1, resolution, session, signal
        }));
    }
    return fromPlatform(() => backend.handleDouyinParse(reference.id, { officialOnly: true }));
}

module.exports = { backend, identify, resolve, fromPlatform };
