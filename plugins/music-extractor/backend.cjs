/**
 * 音乐提取器 - 本地高性能后端服务
 * 支持：歌曲搜索、单曲无损解析、歌单完整解析、双语歌词合并、B站/抖音视频解析下载、流代理下载、用户VIP配置
 * 无需安装第三方 npm 包，直接使用 Node.js 原生模块运行
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { Readable } = require('stream');

// Node 24 的原生 fetch 默认不读取系统代理环境变量。
// 沿用启动环境的代理与 NO_PROXY，本地请求仍由 NO_PROXY 直接连接。
if (typeof http.setGlobalProxyFromEnv === 'function'
    && (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)) {
    http.setGlobalProxyFromEnv();
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 默认配置
let appConfig = {
    vipCookie: '',          // 用户自填的网易云 MUSIC_U 或完整 Cookie
    defaultQuality: 'lossless',
    proxyDownloads: true
};

// 加载配置
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        appConfig = { ...appConfig, ...saved };
    } catch (e) {
        console.error('读取配置文件失败:', e.message);
    }
}

// 保存配置
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2), 'utf-8');
    } catch (e) {
        console.error('保存配置文件失败:', e.message);
    }
}

// 统一 HTTP GET 请求辅助函数 (基于原生 fetch，自动解压并处理 TLS/重定向)
async function httpGet(targetUrl, headers = {}, timeoutMs = 8000, { redirect = 'follow', signal } = {}) {
    try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://music.163.com/',
                ...headers
            },
            redirect,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
        const buffer = Buffer.from(await res.arrayBuffer());
        return {
            statusCode: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: buffer.toString('utf-8'),
            buffer: buffer
        };
    } catch (e) {
        throw new Error(`GET ${targetUrl} 失败: ${e.message}`);
    }
}

// 统一 HTTP POST 请求辅助函数
async function httpPost(targetUrl, postData, headers = {}, timeoutMs = 8000) {
    try {
        const dataBuffer = Buffer.isBuffer(postData) ? postData : Buffer.from(postData, 'utf-8');
        const res = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://music.163.com/',
                'Content-Length': String(dataBuffer.length),
                ...headers
            },
            body: dataBuffer,
            signal: AbortSignal.timeout(timeoutMs)
        });
        const buffer = Buffer.from(await res.arrayBuffer());
        return {
            statusCode: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: buffer.toString('utf-8'),
            buffer: buffer
        };
    } catch (e) {
        throw new Error(`POST ${targetUrl} 失败: ${e.message}`);
    }
}

// 网易云 EAPI 加解密核心
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');

function eapiEncrypt(apiPath, data) {
    const text = typeof data === 'object' ? JSON.stringify(data) : String(data);
    const message = 'nobody' + apiPath + 'use' + text + 'md5forencrypt';
    const digest = crypto.createHash('md5').update(message).digest('hex');
    const dataToEncrypt = apiPath + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest;
    const cipher = crypto.createCipheriv('aes-128-ecb', EAPI_KEY, null);
    return Buffer.concat([cipher.update(dataToEncrypt, 'utf-8'), cipher.final()]).toString('hex').toUpperCase();
}

function eapiDecrypt(hexStr) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', EAPI_KEY, null);
    const buf = Buffer.from(hexStr, 'hex');
    return Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf-8');
}

// 辅助函数：解析网易云短链接（如 163cn.tv, 163.lu, y.music.163.com 等），追踪重定向获取真实目标 URL
async function resolveShortLink(rawInput) {
    if (!rawInput) return '';
    let str = String(rawInput).trim();

    // 匹配可能的网易云短链接或分享口令
    const shortMatch = str.match(/(?:https?:\/\/)?((?:163cn\.tv|163\.lu|y\.music\.163\.com\/m\/[a-zA-Z0-9_\-\/]+)[^\s,，。！!]+)/i);
    if (!shortMatch) return str;

    let targetUrl = shortMatch[0];
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
    }

    console.log('[短链解析] 正在追踪网易云短链重定向:', targetUrl);

    // 追踪重定向 (最多 4 跳)
    for (let hop = 0; hop < 4; hop++) {
        try {
            const res = await fetch(targetUrl, {
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                signal: AbortSignal.timeout(4000)
            });

            const loc = res.headers.get('location');
            if (loc) {
                targetUrl = loc.startsWith('http') ? loc : new URL(loc, targetUrl).href;
                console.log(`[短链解析] 第 ${hop + 1} 跳重定向 ->`, targetUrl);
            } else {
                break;
            }
        } catch (e) {
            console.warn('[短链解析] 追踪重定向异常:', e.message);
            break;
        }
    }

    return targetUrl;
}

// 辅助函数：从输入文本或URL中提取网易云单曲ID (支持异步追踪 163cn.tv 等移动端分享短链)
async function extractSongId(input) {
    if (!input) return null;
    let str = String(input).trim();
    if (/^\d+$/.test(str)) return str;

    // 1. 如果包含 163cn.tv / 163.lu 短链，先异步追踪真实目标
    if (/163cn\.tv|163\.lu|y\.music\.163\.com/i.test(str)) {
        str = await resolveShortLink(str);
    }

    // 2. 匹配标准单曲参数
    const matchId = str.match(/(?:id=|\/song\/|\/song\?id=)(\d+)/);
    if (matchId) return matchId[1];

    // 3. 匹配文本中的独立纯数字ID (4至12位)
    const numMatch = str.match(/\b\d{4,12}\b/);
    if (numMatch) return numMatch[0];

    return null;
}

// 辅助函数：从输入文本或URL中提取网易云歌单ID (支持异步追踪 163cn.tv 等歌单分享短链)
async function extractPlaylistId(input) {
    if (!input) return null;
    let str = String(input).trim();
    if (/^\d+$/.test(str)) return str;

    // 1. 如果包含短链，先追踪真实目标
    if (/163cn\.tv|163\.lu|y\.music\.163\.com/i.test(str)) {
        str = await resolveShortLink(str);
    }

    // 2. 匹配歌单参数
    const matchId = str.match(/(?:playlist\?id=|\/playlist\/)(\d+)/);
    if (matchId) return matchId[1];

    // 3. 匹配纯数字ID
    const numMatch = str.match(/\b\d{4,12}\b/);
    if (numMatch) return numMatch[0];

    return null;
}

// 格式化时间 毫秒 -> mm:ss
function formatDuration(ms) {
    if (!ms || isNaN(ms)) return '00:00';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// 格式化文件大小 字节 -> MB/KB
function formatSize(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '未知大小';
    if (bytes >= 1024 * 1024) {
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }
    return (bytes / 1024).toFixed(1) + ' KB';
}

// 解析并合并双语歌词
function mergeLyrics(origLyric, transLyric) {
    if (!origLyric) return '';
    if (!transLyric) return origLyric;

    const parseLrc = (text) => {
        const lines = text.split('\n');
        const map = new Map();
        const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
        
        for (const line of lines) {
            const matches = [...line.matchAll(timeRegex)];
            if (matches.length > 0) {
                const content = line.replace(timeRegex, '').trim();
                for (const m of matches) {
                    const min = parseInt(m[1], 10);
                    const sec = parseInt(m[2], 10);
                    const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
                    const totalMs = min * 60000 + sec * 1000 + ms;
                    map.set(totalMs, { timeStr: m[0], content });
                }
            }
        }
        return map;
    };

    const origMap = parseLrc(origLyric);
    const transMap = parseLrc(transLyric);

    const merged = [];
    const origTimes = Array.from(origMap.keys()).sort((a, b) => a - b);

    for (const t of origTimes) {
        const origItem = origMap.get(t);
        merged.push(`${origItem.timeStr}${origItem.content}`);

        let matchedTrans = null;
        for (const [transTime, transItem] of transMap.entries()) {
            if (Math.abs(transTime - t) < 500 && transItem.content) {
                matchedTrans = transItem.content;
                break;
            }
        }
        if (matchedTrans) {
            merged.push(`${origItem.timeStr}「译」${matchedTrans}`);
        }
    }

    return merged.join('\n');
}

// API 实现：搜索歌曲
async function handleSearch(keyword, limit = 30) {
    keyword = String(keyword || '').trim();
    if (!keyword) return { code: 400, msg: '请输入搜索关键词' };
    limit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Math.trunc(Number(limit)))) : 30;

    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=0`;
    const res = await httpGet(searchUrl);

    try {
        const data = JSON.parse(res.body);
        if (data.code !== 200) {
            return { code: Number(data.code) || 502, msg: data.message || data.msg || '网易云搜索服务暂时不可用' };
        }
        if (!data.result || !Array.isArray(data.result.songs)) {
            return { code: 200, data: [], total: 0 };
        }

        const songs = data.result.songs.map((s, idx) => {
            const artists = (s.artists || []).map(a => ({ id: a.id, name: a.name }));
            const album = s.album || {};
            let picUrl = album.picUrl || '';
            if (picUrl.startsWith('http://')) picUrl = picUrl.replace('http://', 'https://');

            return {
                index: idx + 1,
                id: s.id,
                name: s.name,
                artists: artists,
                artistNames: artists.map(a => a.name).join(' / '),
                album: {
                    id: album.id,
                    name: album.name || '',
                    picUrl: picUrl
                },
                duration: formatDuration(s.duration),
                duration_ms: s.duration,
                fee: s.fee === 1 ? 1 : 0
            };
        });

        return {
            code: 200,
            data: songs,
            total: data.result.songCount || songs.length
        };
    } catch (e) {
        return { code: 500, msg: '解析搜索结果异常: ' + e.message };
    }
}

// API 实现：解析单曲详情与播放直链
async function handleSongParse(songInput, level = 'lossless', { officialOnly = false } = {}) {
    if (!['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster', 'dolby'].includes(level)) {
        return { code: 400, msg: '不支持的音质选项' };
    }
    let resolvedStr = String(songInput || '').trim();
    if (/163cn\.tv|163\.lu|y\.music\.163\.com/i.test(resolvedStr)) {
        resolvedStr = await resolveShortLink(resolvedStr);
    }

    // 智能检测：如果用户在单曲解析面板粘贴了歌单链接，自动引导跳转
    if (/playlist\?id=|\/playlist\//.test(resolvedStr)) {
        const plMatch = resolvedStr.match(/(?:playlist\?id=|\/playlist\/)(\d+)/);
        if (plMatch) {
            return {
                code: 302,
                is_playlist: true,
                playlist_id: plMatch[1],
                msg: `检测到您输入的是歌单链接 (歌单ID: ${plMatch[1]})，已为您自动跳转到“歌单解析”面板！`
            };
        }
    }

    const songId = await extractSongId(resolvedStr);
    if (!songId) return { code: 400, msg: '未识别到有效的网易云歌曲ID或链接，支持输入单曲ID、网页链接及 163cn.tv 分享短链' };

    // 1. 获取歌曲基础信息 (歌曲名、歌手、专辑、封面)
    const detailUrl = `https://music.163.com/api/song/detail/?id=${songId}&ids=%5B${songId}%5D`;
    const detailRes = await httpGet(detailUrl);
    
    let songName = '未知歌曲';
    let arName = '未知歌手';
    let alName = '未知专辑';
    let picUrl = '';
    let isVip = false;

    try {
        const detailJson = JSON.parse(detailRes.body);
        if (detailJson.code !== 200) {
            return { code: Number(detailJson.code) || 502, msg: detailJson.message || detailJson.msg || '网易云歌曲信息服务暂时不可用' };
        }
        if (detailJson.songs && detailJson.songs[0]) {
            const s = detailJson.songs[0];
            songName = s.name;
            arName = (s.artists || []).map(a => a.name).join(' / ');
            alName = s.album ? s.album.name : '';
            picUrl = s.album ? (s.album.picUrl || '') : '';
            if (picUrl.startsWith('http://')) picUrl = picUrl.replace('http://', 'https://');
            isVip = s.fee === 1;
        } else {
            return { code: 404, msg: '未找到该歌曲，请检查歌曲ID或分享链接' };
        }
    } catch (e) {
        return { code: 502, msg: '歌曲信息响应格式异常，请稍后重试' };
    }

    // 2. 获取并处理歌词 (原文 + 翻译合并)
    const lyricUrl = `https://music.163.com/api/song/lyric?os=pc&id=${songId}&lv=-1&kv=-1&tv=-1`;
    let origLyric = '';
    let transLyric = '';
    let processedLyrics = '';

    try {
        const lyricRes = await httpGet(lyricUrl);
        const lyricJson = JSON.parse(lyricRes.body);
        origLyric = lyricJson.lrc ? (lyricJson.lrc.lyric || '') : '';
        transLyric = lyricJson.tlyric ? (lyricJson.tlyric.lyric || '') : '';
        processedLyrics = mergeLyrics(origLyric, transLyric);
    } catch (e) {}

    // 3. 多策略解析音频下载直链
    let finalAudioUrl = '';
    let audioSize = 0;
    let resolvedLevel = level;
    let audioExt = 'mp3';
    let isTrial = false;
    let trialNotice = '';

    // 策略 A: 网易云官方 EAPI 播放接口 (支持高码率、VIP、无损FLAC解析)
    if (true) {
        try {
            const eapiPath = '/api/song/enhance/player/url/v1';
            const isFlac = ['lossless', 'hires', 'jymaster', 'jyeffect', 'sky', 'dolby'].includes(level);
            const payload = {
                ids: JSON.stringify([parseInt(songId, 10)]),
                level: level,
                encodeType: isFlac ? 'flac' : 'mp3'
            };
            const paramsHex = eapiEncrypt(eapiPath, payload);

            let cookieHeader = 'os=pc; appver=8.9.70; channel=netease;';
            if (!officialOnly && appConfig.vipCookie) {
                cookieHeader += ' ' + appConfig.vipCookie;
            } else {
                cookieHeader += ' osver=Microsoft-Windows-10-Professional-build-19045-64bit;';
            }

            const postRes = await httpPost('https://interface.music.163.com/eapi/song/enhance/player/url/v1', 
                `params=${encodeURIComponent(paramsHex)}`, 
                {
                    'Cookie': cookieHeader,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }, 4000
            );

            let jsonText = postRes.body;
            if (/^[0-9a-fA-F]+$/.test(jsonText.trim())) {
                jsonText = eapiDecrypt(jsonText.trim());
            }

            const eapiData = JSON.parse(jsonText);
            if (eapiData.data && eapiData.data[0] && eapiData.data[0].url) {
                const item = eapiData.data[0];
                finalAudioUrl = item.url;
                audioSize = item.size || 0;
                resolvedLevel = item.level || level;
                audioExt = item.type ? item.type.toLowerCase() : (finalAudioUrl.includes('.flac') ? 'flac' : 'mp3');
                if (item.freeTrialInfo || (item.freeTrialPrivilege && item.freeTrialPrivilege.cannotListenReason === 1)) {
                    isTrial = true;
                    trialNotice = '当前为30秒官方试听片段（该歌曲为网易云黑胶VIP专享曲目）';
                }
                console.log(`[VIP-EAPI] 成功解析歌曲 ${songName} (${resolvedLevel})`);
            }
        } catch (e) {
            console.warn('[VIP-EAPI] 解析异常:', e.message);
        }
    }

    // 策略 B: 官方外链音频兜底 (严格校验是否被重定向到 404)
    if (!finalAudioUrl) {
        try {
            const outerUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
            const checkRes = await fetch(outerUrl, {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(4000)
            });
            const outerLoc = checkRes.headers.get('location');
            if (outerLoc && !outerLoc.includes('404')) {
                if (officialOnly && !isPlatformMediaUrl(outerLoc, 'netease')) throw new Error('音频地址不属于网易云');
                finalAudioUrl = outerLoc;
                audioExt = 'mp3';
                resolvedLevel = '标准';
                // 重定向响应通常没有音频大小，应读取最终音频的 HEAD。
                const mediaHead = await fetch(finalAudioUrl, {
                    method: 'HEAD',
                    headers: { 'Referer': 'https://music.163.com/' },
                    signal: AbortSignal.timeout(4000),
                    redirect: officialOnly ? 'error' : 'follow'
                }).catch(() => null);
                const cl = mediaHead?.headers.get('content-length');
                if (cl) {
                    audioSize = parseInt(cl, 10);
                    if (audioSize > 0 && audioSize < 1000000 && isVip) {
                        isTrial = true;
                        trialNotice = '当前为30秒官方试听片段（该歌曲为网易云黑胶VIP专享曲目）';
                        resolvedLevel = '30秒试听版';
                    }
                }
            }
        } catch (e) {}
    }

    // 策略 C: 原有公共 Meting 聚合通道解析 (精准 302 重定向直链提取，支持目标码率)
    if (!finalAudioUrl && !officialOnly) {
        const brMap = {
            'standard': 128000,
            'higher': 192000,
            'exhigh': 320000,
            'lossless': 999000,
            'hires': 999000,
            'jyeffect': 999000,
            'jymaster': 999000,
            'sky': 999000,
            'dolby': 999000
        };
        const targetBr = brMap[level] || 999000;
        const metingChannels = [
            `https://api.injahow.cn/meting/?type=url&id=${songId}&br=${targetBr}`,
            `https://api.injahow.cn/meting/?type=url&id=${songId}`,
            `https://meting.qjqq.cn/?type=url&id=${songId}`
        ];
        for (const mUrl of metingChannels) {
            try {
                const mRes = await fetch(mUrl, {
                    redirect: 'manual',
                    signal: AbortSignal.timeout(6000)
                });
                const loc = mRes.headers.get('location');
                if (loc && loc.startsWith('http') && !loc.includes('404')) {
                    finalAudioUrl = loc;
                    audioExt = finalAudioUrl.includes('.flac') ? 'flac' : (finalAudioUrl.includes('.m4a') ? 'm4a' : 'mp3');
                    resolvedLevel = '极高/标准';

                    // 快速探针检查真实音频大小与是否试听
                    try {
                        const checkHead = await fetch(finalAudioUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
                        const cl = checkHead.headers.get('content-length');
                        if (cl) {
                            audioSize = parseInt(cl, 10);
                            if (audioSize > 0 && audioSize < 1000000 && isVip) {
                                isTrial = true;
                                trialNotice = '当前为30秒官方试听片段（该歌曲为网易云黑胶VIP专享曲目）';
                                resolvedLevel = '30秒试听版';
                            }
                        }
                    } catch (probeErr) {}

                    console.log(`[Meting通道] 成功解析歌曲 ${songName}${isTrial ? ' [30秒试听版]' : ''}`);
                    break;
                }
            } catch (e) {
                console.warn('[Meting通道] 尝试异常:', e.message);
            }
        }
    }

    finalAudioUrl = finalAudioUrl.replace(/^http:\/\//i, 'https://');

    if (!finalAudioUrl) {
        if (officialOnly) {
            return { code: 200, id: songId, name: songName, ar_name: arName, al_name: alName,
                pic: picUrl, lyric: origLyric, fee: isVip ? 1 : 0 };
        }
        return {
            code: 403,
            msg: `未能获取歌曲《${songName}》的可播放音频。可能受账号权限、版权或上游网络影响，请在网易云官方客户端确认可播放权限后重试。`
        };
    }

    const levelMap = {
        'standard': '标准音质 (128kbps)',
        'higher': '较高音质 (192kbps)',
        'exhigh': '极高音质 (320kbps HQ)',
        'lossless': '无损音质 (FLAC SQ)',
        'hires': '高解析度无损 (Hi-Res)',
        'jyeffect': '高清臻音 (Spatial Audio)',
        'sky': '沉浸环绕声 (Surround)',
        'jymaster': '超清母带 (Master)',
        'dolby': '杜比全景声 (Dolby Atmos)',
        '30秒试听版': '30秒官方试听片段'
    };

    return {
        code: 200,
        id: songId,
        name: songName,
        ar_name: arName,
        al_name: alName,
        pic: picUrl,
        level: levelMap[resolvedLevel] || resolvedLevel,
        raw_level: resolvedLevel,
        size: formatSize(audioSize),
        size_bytes: audioSize,
        url: finalAudioUrl,
        ext: audioExt,
        is_trial: isTrial,
        trial_notice: trialNotice,
        lyric: origLyric,
        tlyric: transLyric,
        processedLyrics: processedLyrics,
        fee: isVip ? 1 : 0
    };
}

// API 实现：解析歌单详情与歌曲列表
async function handlePlaylistParse(playlistInput) {
    const playlistId = await extractPlaylistId(playlistInput);
    if (!playlistId) return { code: 400, msg: '未识别到有效的歌单ID或链接，支持输入歌单ID、网易云网页链接及 163cn.tv 歌单分享短链' };

    const playlistUrl = `https://music.163.com/api/playlist/detail?id=${playlistId}&n=1000&s=0`;
    const res = await httpGet(playlistUrl);

    try {
        const data = JSON.parse(res.body);
        if (data.code !== 200 || !data.result) {
            return { code: 404, msg: '未找到该歌单或歌单为私密状态' };
        }

        const p = data.result;
        const tracks = (p.tracks || []).map((t, idx) => {
            const artists = (t.artists || []).map(a => ({ id: a.id, name: a.name }));
            const album = t.album || {};
            let cover = album.picUrl || p.coverImgUrl || '';
            if (cover.startsWith('http://')) cover = cover.replace('http://', 'https://');
            return {
                index: idx + 1,
                id: t.id,
                name: t.name,
                ar: artists,
                artistNames: artists.map(a => a.name).join(' / '),
                al: { id: album.id, name: album.name || '', picUrl: cover },
                duration: formatDuration(t.duration),
                fee: t.fee === 1 ? 1 : 0
            };
        });

        let coverImgUrl = p.coverImgUrl || '';
        if (coverImgUrl.startsWith('http://')) coverImgUrl = coverImgUrl.replace('http://', 'https://');

        return {
            code: 200,
            playlist: {
                id: p.id,
                name: p.name,
                coverImgUrl: coverImgUrl,
                creator: {
                    nickname: p.creator ? p.creator.nickname : '官方',
                    avatarUrl: p.creator ? p.creator.avatarUrl : ''
                },
                trackCount: p.trackCount || tracks.length,
                returnedTrackCount: tracks.length,
                tracksComplete: !p.trackCount || tracks.length >= p.trackCount,
                playCount: p.playCount || 0,
                createTime: p.createTime || Date.now(),
                description: p.description || '',
                tracks: tracks
            }
        };
    } catch (e) {
        return { code: 500, msg: '解析歌单数据失败: ' + e.message };
    }
}

// API 实现：解析 B 站视频 (Bilibili)
async function handleBilibiliParse(input, { officialOnly = false, page = 1, resolution = 'best', session, signal } = {}) {
    if (!input) return { code: 400, msg: '请输入B站视频链接或BV号' };

    let rawStr = String(input).trim();

    // 1. 如果包含短链接 b23.tv，追踪重定向
    const shortMatch = rawStr.match(/b23\.tv\/[a-zA-Z0-9]+/);
    if (shortMatch) {
        try {
            const redirectRes = await fetch(`https://${shortMatch[0]}`, {
                redirect: 'manual',
                signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const loc = redirectRes.headers.get('location');
            if (loc) rawStr = loc;
        } catch (e) {}
    }

    // 2. 提取 BV号 或 av号
    let bvid = '';
    let aid = '';
    const bvMatch = rawStr.match(/(BV[a-zA-Z0-9]{10})/i);
    if (bvMatch) {
        bvid = bvMatch[1];
    } else {
        const avMatch = rawStr.match(/av(\d+)/i);
        if (avMatch) aid = avMatch[1];
    }

    if (!bvid && !aid) {
        return { code: 400, msg: '未能从输入中识别到有效的 B 站视频 BV号 或 av号' };
    }

    const realBvid = bvid || ('av' + aid);

    // 策略 A: mir6 开放解析引擎 (极速直接返回完整 MP4 及音频)
    if (!officialOnly) try {
        const fullVideoUrl = `https://www.bilibili.com/video/${realBvid}`;
        const mirRes = await fetch(`https://api.mir6.com/api/bzjiexi?url=${encodeURIComponent(fullVideoUrl)}&type=json`, {
            signal: AbortSignal.timeout(5000),
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (mirRes.ok) {
            const mirData = await mirRes.json();
            if (mirData.code === 200 && mirData.data && mirData.data.length > 0) {
                const item = mirData.data[0];
                let cover = mirData.imgurl || '';
                if (cover.startsWith('http://')) cover = cover.replace('http://', 'https://');
                let authorName = 'B站UP主';
                let authorFace = '';
                if (mirData.user) {
                    if (typeof mirData.user === 'object') {
                        authorName = mirData.user.name || 'B站UP主';
                        authorFace = mirData.user.user_img || '';
                    } else if (typeof mirData.user === 'string') {
                        authorName = mirData.user;
                    }
                }
                return {
                    code: 200,
                    platform: 'bilibili',
                    platform_name: '哔哩哔哩 (B站)',
                    id: realBvid,
                    title: mirData.title || 'B站视频',
                    author: authorName,
                    author_face: authorFace,
                    cover: cover,
                    video_url: item.video_url || '',
                    audio_url: item.video_url || '',
                    quality: (item.accept && item.accept[0]) || '高清 1080P/720P',
                    duration: item.durationFormat || (item.duration ? formatDuration(item.duration * 1000) : '完整视频'),
                    size: '完整高清 MP4',
                    size_bytes: 0
                };
            }
        }
    } catch (e) {
        console.warn('[B站] mir6 引擎未命中:', e.message);
    }

    // 策略 B: 官方接口兜底解析
    try {
        const viewApi = bvid 
            ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}` 
            : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;

        const viewRes = await httpGet(viewApi, {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.bilibili.com/'
        }, 4000, { signal });

        const json = JSON.parse(viewRes.body);
        if (json.code === 0 && json.data) {
            const viewData = json.data;
            const pages = viewData.pages || [];
            if (officialOnly && page > (pages.length || 1)) return { code: 404, msg: '视频没有该分 P' };
            const cid = officialOnly ? (pages[page - 1]?.cid || viewData.cid) : viewData.cid;
            const title = viewData.title;
            const author = viewData.owner ? viewData.owner.name : 'B站UP主';
            const authorFace = viewData.owner ? viewData.owner.face : '';
            let cover = viewData.pic || '';
            if (cover.startsWith('http://')) cover = cover.replace('http://', 'https://');
            const durationStr = formatDuration((officialOnly ? (pages[page - 1]?.duration ?? viewData.duration) : viewData.duration) * 1000);

            const videoParameter = officialOnly && !bvid ? `avid=${aid}` : `bvid=${realBvid}`;
            const playApi = `https://api.bilibili.com/x/player/playurl?${videoParameter}&cid=${cid}`;
            const playHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://www.bilibili.com/'
            };
            if (officialOnly && session) playHeaders.Cookie = session;
            const readPlayback = async (qn, fnval, extra = '') => {
                const response = await httpGet(`${playApi}&qn=${qn}&fnval=${fnval}${extra}`, playHeaders, 4000,
                    { redirect: officialOnly ? 'error' : 'follow', signal });
                const { code, data } = JSON.parse(response.body);
                return code === 0 ? data : null;
            };
            if (officialOnly) {
                const { videoStreams, audio } = await readBilibiliStreams(readPlayback, resolution, Boolean(session), signal);
                return {
                    code: 200, platform: 'bilibili', platform_name: '哔哩哔哩 (B站)', id: realBvid,
                    title, author, author_face: authorFace, cover, duration: durationStr,
                    page, pageCount: pages.length || 1, pageTitle: pages[page - 1]?.part || '',
                    videoStreams, dashAudio: audio
                };
            }

            const play = await readPlayback(80, 0);
            const videoUrl = play?.durl?.[0]?.url;
            const sizeBytes = play?.durl?.[0]?.size || 0;
            const qualityId = play?.quality;
            let quality = '高清 1080P/720P';
            if (qualityId >= 80) quality = '超清 1080P';
            else if (qualityId >= 64) quality = '高清 720P';
            else if (qualityId >= 32) quality = '清晰 480P';
            else if (qualityId >= 16) quality = '流畅 360P';

            if (videoUrl) {
                return {
                    code: 200,
                    platform: 'bilibili',
                    platform_name: '哔哩哔哩 (B站)',
                    id: realBvid,
                    title: title,
                    author: author,
                    author_face: authorFace,
                    cover: cover,
                    video_url: videoUrl,
                    audio_url: videoUrl,
                    quality: quality,
                    duration: durationStr,
                    size: formatSize(sizeBytes),
                    size_bytes: sizeBytes
                };
            }
        }
    } catch (e) {
        signal?.throwIfAborted();
        console.warn('[B站] 官方接口异常:', e.message);
        if (officialOnly) return { code: 502, msg: '无法连接 B 站服务，请检查网络后重试。' };
    }

    return { code: 404, msg: '未能解析到可用的 B 站视频直链，该视频可能需要登录或为大会员专享' };
}

function selectVideoStream(streams, requestedResolution) {
    // The short side works for both landscape and portrait media.
    streams.sort((a, b) => (b.pixels || 0) - (a.pixels || 0) || (b.qualityId || 0) - (a.qualityId || 0) ||
        (b.preference || 0) - (a.preference || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0));
    const availableResolutions = [...new Set(streams.filter(stream => stream.pixels).map(stream => `${stream.pixels}p`))];
    const selected = requestedResolution === 'best' ? streams[0] :
        streams.find(stream => `${stream.pixels}p` === requestedResolution);
    return {
        video_url: selected?.url || '',
        resolution: selected?.pixels ? `${selected.pixels}p` : null,
        width: selected?.width,
        height: selected?.height,
        availableResolutions,
        size_bytes: selected?.bytes || 0,
        size: formatSize(selected?.bytes || 0),
        quality: selected?.quality || (selected?.pixels ? `${selected.pixels}P` : undefined),
        selected
    };
}

const bilibiliQualityLabels = {
    6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
    80: '1080P', 112: '1080P 高码率', 116: '1080P60',
    120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K'
};

async function readBilibiliStreams(readPlayback, resolution, hasSession, signal) {
    const progressiveQualities = { '240p': 6, '360p': 16, '480p': 32, '720p': 64, '1080p': 80, '2160p': 120, '4320p': 127 };
    const requested = progressiveQualities[resolution] ?? 80;
    const dash = 16;
    const allow4k = 128;
    const extendedDash = dash | 64 | allow4k | 256 | 512 | 1024 | 2048;
    const tryPlayback = (qn, flags) => readPlayback(qn, flags, '&fourk=1').catch(() => {
        signal?.throwIfAborted();
        return null;
    });
    const [progressive, extendedPlayback] = await Promise.all([
        tryPlayback(requested, 0), tryPlayback(127, extendedDash)
    ]);
    const playbacks = [extendedPlayback];
    const extendedVideos = extendedPlayback?.dash?.video || [];
    if (!extendedVideos.length || (hasSession && !extendedVideos.some(stream => Number(stream.id) === 120))) {
        // Some responses only expose the 4K tier when requested with the mobile client's flags.
        const standardPlayback = await tryPlayback(hasSession ? 120 : 116, hasSession ? dash | allow4k : dash);
        playbacks.push(standardPlayback);
        if (!extendedVideos.length && !standardPlayback?.dash?.video?.length) playbacks.push(await tryPlayback(80, dash));
    }
    const { videoStreams, audio } = bilibiliStreams(progressive, {
        video: playbacks.flatMap(playback => playback?.dash?.video || []),
        audio: playbacks.flatMap(playback => playback?.dash?.audio || [])
    });
    const returned = new Set(videoStreams.map(stream => stream.qualityId));
    const advertised = new Set([progressive, ...playbacks].flatMap(playback => playback?.accept_quality || []).map(Number));
    const extraQualities = [64, 32, 16].filter(id => id !== requested && advertised.has(id) && !returned.has(id));
    if (requested < 80 && !returned.has(80)) extraQualities.push(80);
    const additional = await Promise.all(extraQualities.map(async id => {
        const playback = await tryPlayback(id, 0);
        return Number(playback?.quality) === id ? bilibiliStreams(playback).videoStreams : [];
    }));
    videoStreams.push(...additional.flat());
    return { videoStreams, audio };
}

function bilibiliStreams(progressive, dash) {
    const mediaUrl = stream => [stream.baseUrl, stream.base_url, ...(stream.backupUrl || stream.backup_url || [])]
        .find(url => isPlatformMediaUrl(url, 'bilibili'));
    const audio = (dash?.audio || []).filter(stream => !stream.codecs || stream.codecs.startsWith('mp4a'))
        .map(stream => ({ url: mediaUrl(stream), bandwidth: stream.bandwidth || 0 }))
        .filter(stream => stream.url).sort((a, b) => b.bandwidth - a.bandwidth)[0]?.url;
    const streams = (dash?.video || []).map(stream => ({
        url: mediaUrl(stream), pixels: Math.min(stream.width, stream.height),
        quality: bilibiliQualityLabels[stream.id], qualityId: Number(stream.id), dash: true,
        width: stream.width, height: stream.height, audio, bitrate: stream.bandwidth,
        preference: stream.codecid === 7 ? 2 : 0
    })).filter(stream => stream.url);
    const durl = progressive?.durl;
    if (durl?.length === 1 && isPlatformMediaUrl(durl[0].url, 'bilibili')) {
        streams.push({ url: durl[0].url, quality: bilibiliQualityLabels[progressive.quality],
            qualityId: Number(progressive.quality), bytes: durl[0].size, preference: 1 });
    }
    return { videoStreams: streams, audio };
}

function douyinStreams(video) {
    const candidates = [{ play_addr: video?.play_addr }, ...(Array.isArray(video?.bit_rate) ? video.bit_rate : [])];
    return candidates.map(({ play_addr: address, bit_rate: bitrate }) => {
        const width = Number(address?.width) || undefined;
        const height = Number(address?.height) || undefined;
        const url = address?.url_list?.find(value => isPlatformMediaUrl(value, 'douyin'));
        return { url, width, height, pixels: Math.min(width, height), bytes: Number(address?.data_size) || 0, bitrate };
    }).filter(stream => stream.url);
}

// 抖音 ttwid 凭据缓存
let cachedTtwid = null;
let ttwidExpireTime = 0;

// 获取字节跳动 / 抖音官方游客标识 ttwid
async function getDouyinTtwid() {
    if (cachedTtwid && Date.now() < ttwidExpireTime) {
        return cachedTtwid;
    }
    try {
        const postData = JSON.stringify({
            region: "cn",
            aid: 1768,
            needFid: "false",
            service: "www.ixigua.com",
            migrate_info: { ticket: "", src: "uc" },
            cbUrlProtocol: "https",
            union: "true"
        });
        const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: postData,
            signal: AbortSignal.timeout(5000)
        });
        const setCookie = res.headers.get('set-cookie');
        const m = setCookie && setCookie.match(/ttwid=([^;]+)/);
        if (m) {
            cachedTtwid = m[1];
            ttwidExpireTime = Date.now() + 3600 * 1000 * 12; // 缓存 12 小时
            return cachedTtwid;
        }
    } catch (e) {
        console.warn('[抖音] 获取官方游客标识 ttwid 异常:', e.message);
    }
    return null;
}

// API 实现：解析抖音视频与图集 (Douyin)
async function handleDouyinParse(input, { officialOnly = false } = {}) {
    if (!input) return { code: 400, msg: '请输入抖音分享文案或链接' };

    let rawStr = String(input).trim();
    let targetUrl = '';

    const matchUrl = rawStr.match(/https?:\/\/(?:[a-zA-Z0-9.-]+\.)?douyin\.com\/[^\s]+/);
    if (matchUrl) {
        targetUrl = matchUrl[0];
    } else if (/^\d{16,21}$/.test(rawStr)) {
        targetUrl = `https://www.douyin.com/video/${rawStr}`;
    } else {
        return { code: 400, msg: '未在输入内容中识别到有效的抖音分享链接或视频ID' };
    }

    // 1. 如果是短链接 v.douyin.com，追踪 302 重定向获取长链接
    if (targetUrl.includes('v.douyin.com')) {
        let cur = targetUrl;
        for (let hop = 0; hop < 4; hop++) {
            try {
                const redirectRes = await fetch(cur, {
                    redirect: 'manual',
                    signal: AbortSignal.timeout(4000),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
                    }
                });
                const loc = redirectRes.headers.get('location');
                if (loc) {
                    cur = loc.startsWith('http') ? loc : new URL(loc, cur).href;
                    if (cur.includes('/video/') || cur.includes('/share/video/')) break;
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
        }
        targetUrl = cur;
    }

    // 2. 提取视频 ID (aweme_id)
    let awemeId = '';
    const idMatch = targetUrl.match(/\/video\/(\d+)/) || targetUrl.match(/\/share\/video\/(\d+)/) || targetUrl.match(/modal_id=(\d+)/) || targetUrl.match(/\b\d{18,21}\b/);
    if (idMatch) {
        awemeId = idMatch[1] || idMatch[0];
    }

    // 策略 A: 官方原生移动端分享协议 + 游客凭据直析 (首选，无水印1080P/720P原画)
    if (awemeId) {
        try {
            const ttwid = await getDouyinTtwid();
            const shareUrls = [
                `https://www.douyin.com/share/video/${awemeId}`,
                `https://www.iesdouyin.com/share/video/${awemeId}`
            ];

            const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

            for (const shareUrl of shareUrls) {
                try {
                    const reqHeaders = {
                        'User-Agent': mobileUa,
                        'Referer': 'https://www.douyin.com/'
                    };
                    if (ttwid) {
                        reqHeaders['Cookie'] = `ttwid=${ttwid}; passport_csrf_token=none`;
                    }

                    const shareRes = await fetch(shareUrl, {
                        headers: reqHeaders,
                        signal: AbortSignal.timeout(5000)
                    });

                    const html = await shareRes.text();
                    const idx = html.indexOf('_ROUTER_DATA = ');
                    if (idx !== -1) {
                        const endIdx = html.indexOf('</script>', idx);
                        let jsonStr = html.slice(idx + 15, endIdx).trim();
                        if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
                        const routerData = JSON.parse(jsonStr);

                        let item = null;
                        if (routerData.loaderData) {
                            for (const k of Object.keys(routerData.loaderData)) {
                                const val = routerData.loaderData[k];
                                if (val && val.videoInfoRes && val.videoInfoRes.item_list && val.videoInfoRes.item_list[0]) {
                                    item = val.videoInfoRes.item_list[0];
                                    break;
                                }
                            }
                        }

                        if (item) {
                            // 提取原画视频地址并去除官方 playwm 水印
                            let rawPlayUrl = '';
                            if (item.video && item.video.play_addr && item.video.play_addr.url_list && item.video.play_addr.url_list.length > 0) {
                                rawPlayUrl = item.video.play_addr.url_list[0];
                            }
                            const cleanPlayUrl = officialOnly ? rawPlayUrl : (rawPlayUrl ? rawPlayUrl.replace('/playwm/', '/play/') : '');

                            // 跟随 302 重定向获取无水印 CDN 直链及文件大小
                            let directVideoUrl = cleanPlayUrl;
                            let videoBytes = 0;
                            if (cleanPlayUrl && !officialOnly) {
                                try {
                                    const redirectRes = await fetch(cleanPlayUrl, {
                                        redirect: 'manual',
                                        headers: { 'User-Agent': mobileUa },
                                        signal: AbortSignal.timeout(4000)
                                    });
                                    const realLoc = redirectRes.headers.get('location');
                                    if (realLoc) {
                                        directVideoUrl = realLoc;
                                        try {
                                            const head = await fetch(directVideoUrl, {
                                                method: 'HEAD',
                                                headers: { 'User-Agent': mobileUa, 'Referer': 'https://www.douyin.com/' },
                                                signal: AbortSignal.timeout(3000)
                                            });
                                            const cl = head.headers.get('content-length');
                                            if (cl) videoBytes = parseInt(cl, 10);
                                        } catch (e) {}
                                    }
                                } catch (e) {}
                            }

                            // 提取背景音乐 / 原声音频
                            let audioUrl = '';
                            if (item.music && item.music.play_url && item.music.play_url.url_list && item.music.play_url.url_list.length > 0) {
                                audioUrl = item.music.play_url.url_list[0];
                            }
                            if (!audioUrl) audioUrl = directVideoUrl;

                            // 提取封面
                            let cover = '';
                            if (item.video && item.video.cover && item.video.cover.url_list && item.video.cover.url_list.length > 0) {
                                cover = item.video.cover.url_list[0];
                            } else if (item.video && item.video.origin_cover && item.video.origin_cover.url_list) {
                                cover = item.video.origin_cover.url_list[0];
                            }

                            // 提取创作者信息
                            let author = '抖音创作者';
                            let authorFace = '';
                            if (item.author) {
                                author = item.author.nickname || item.author.name || '抖音创作者';
                                if (item.author.avatar_thumb && item.author.avatar_thumb.url_list) {
                                    authorFace = item.author.avatar_thumb.url_list[0];
                                }
                            }

                            return {
                                code: 200,
                                platform: 'douyin',
                                platform_name: '抖音 (Douyin)',
                                id: awemeId,
                                title: item.desc || '抖音短视频',
                                author: author,
                                author_face: authorFace,
                                cover: cover,
                                audio_url: audioUrl,
                                duration: formatDuration((item.duration || 0) * 1000),
                                ...(officialOnly ? { videoStreams: douyinStreams(item.video) } : {
                                    video_url: directVideoUrl, quality: '无水印原画 1080P/720P',
                                    size: formatSize(videoBytes), size_bytes: videoBytes
                                })
                            };
                        }
                    }
                } catch (e) {
                    console.warn(`[抖音] 移动端协议 ${shareUrl} 尝试未命中:`, e.message);
                }
            }
        } catch (e) {
            console.warn('[抖音] 官方移动端分享协议异常:', e.message);
        }
    }

    if (officialOnly) return { code: 404, msg: '未取得抖音公开分享视频，链接可能已失效或当前网络无法访问' };

    // 策略 B: DevTool 开放接口兜底
    try {
        const dtRes = await fetch(`https://www.devtool.top/api/douyin/parse?url=${encodeURIComponent(targetUrl)}`, {
            signal: AbortSignal.timeout(4000)
        });
        if (dtRes.ok) {
            const dtData = await dtRes.json();
            if (dtData.code === 200 && dtData.data) {
                const d = dtData.data;
                const vUrl = (d.video && d.video.url) || d.url || '';
                if (vUrl) {
                    return {
                        code: 200,
                        platform: 'douyin',
                        platform_name: '抖音 (Douyin)',
                        id: awemeId || 'douyin_video',
                        title: d.title || '抖音短视频',
                        author: d.author ? (d.author.name || d.author) : '抖音创作者',
                        author_face: d.avatar || (d.author && d.author.avatar) || '',
                        cover: d.cover || (d.video && d.video.cover) || '',
                        video_url: vUrl,
                        audio_url: (d.music && d.music.url) || vUrl,
                        quality: '无水印原画',
                        duration: '短视频',
                        size: '无水印 MP4',
                        size_bytes: 0
                    };
                }
            }
        }
    } catch (e) {
        console.warn('[抖音] DevTool 策略未命中:', e.message);
    }

    // 策略 C: 开放免费通道兜底
    try {
        const pubRes = await fetch(`https://api.pearktrue.cn/api/douyin/?url=${encodeURIComponent(targetUrl)}`, {
            signal: AbortSignal.timeout(3000)
        });
        if (pubRes.ok) {
            const pubJson = await pubRes.json();
            if (pubJson.code === 200 && pubJson.data) {
                const d = pubJson.data;
                return {
                    code: 200,
                    platform: 'douyin',
                    platform_name: '抖音 (Douyin)',
                    id: awemeId || 'douyin_video',
                    title: d.title || '抖音短视频',
                    author: d.author || '抖音创作者',
                    author_face: d.avatar || '',
                    cover: d.cover || '',
                    video_url: d.url || d.video,
                    audio_url: d.music || '',
                    quality: '无水印原画',
                    duration: '短视频',
                    size: '无水印 MP4',
                    size_bytes: 0
                };
            }
        }
    } catch (e) {}

    return { code: 404, msg: '未能成功解析抖音视频，请检查视频是否为私密状态或已下架' };
}

// 静态文件 MIME 字典
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.js': 'application/javascript; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.lrc': 'text/plain; charset=UTF-8'
};

// 启动 HTTP 服务
const server = http.createServer(async (req, res) => {
    // 跨域 CORS 支持
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Range');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ code: 200, service: 'music-extractor', netease: 'local' }));
        return;
    }

    // API 路由分发
    if (pathname.startsWith('/api/')) {
        let postData = '';
        if (req.method === 'POST') {
            const bodyChunks = [];
            req.on('data', c => bodyChunks.push(c));
            await new Promise(resolve => req.on('end', () => {
                postData = Buffer.concat(bodyChunks).toString('utf-8');
                resolve();
            }));
        }

        // 解析 POST 数据（支持 JSON 或 x-www-form-urlencoded）
        let params = { ...parsedUrl.query };
        if (postData) {
            try {
                if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
                    params = { ...params, ...JSON.parse(postData) };
                } else {
                    const q = new URLSearchParams(postData);
                    for (const [k, v] of q.entries()) params[k] = v;
                }
            } catch (e) {}
        }

        const sendJson = (data) => {
            // 恢复的页面同时使用 msg（歌曲）和 error（歌单）读取错误。
            if (data.code !== 200 && data.msg && !data.error) data = { ...data, error: data.msg };
            res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify(data));
        };

        try {
            // 本地重建的网易云接口，不依赖原站 PHP 服务或其签名协议。
            const action = params.action || pathname.replace('/api/', '');

            if (pathname === '/api/netease.php' && !['search', 'music', 'playlist'].includes(action)) {
                return sendJson({ code: 404, msg: '未知网易云请求' });
            }

            if (action === 'search') {
                const keyword = params.name || params.keyword || params.s;
                const limit = parseInt(params.limit || '30', 10);
                const result = await handleSearch(keyword, limit);
                return sendJson(result);
            }

            if (action === 'music' || action === 'song') {
                const songInput = params.url || params.id;
                const level = params.level || 'lossless';
                const result = await handleSongParse(songInput, level);
                return sendJson(result);
            }

            if (action === 'playlist') {
                const playlistInput = params.id || params.url;
                const result = await handlePlaylistParse(playlistInput);
                return sendJson(result);
            }

            if (action === 'bilibili') {
                const videoInput = params.url || params.bvid || params.id;
                const result = await handleBilibiliParse(videoInput);
                return sendJson(result);
            }

            if (action === 'douyin') {
                const videoInput = params.url || params.id;
                const result = await handleDouyinParse(videoInput);
                return sendJson(result);
            }

            // 获取或更新配置
            if (action === 'config') {
                if (req.method === 'POST') {
                    if (params.vipCookie !== undefined) {
                        let raw = String(params.vipCookie || '').trim();
                        if (raw && !raw.includes('=')) {
                            raw = 'MUSIC_U=' + raw;
                        }
                        appConfig.vipCookie = raw;
                    }
                    if (params.defaultQuality !== undefined) appConfig.defaultQuality = params.defaultQuality;
                    saveConfig();
                    return sendJson({ code: 200, msg: '配置已保存', config: { hasVipCookie: !!appConfig.vipCookie, defaultQuality: appConfig.defaultQuality } });
                } else {
                    return sendJson({ code: 200, config: { hasVipCookie: !!appConfig.vipCookie, defaultQuality: appConfig.defaultQuality } });
                }
            }

            // 音频/视频/图片流转发代理，彻底解决浏览器跨域与防盗链
            if (action === 'proxy') {
                const targetStreamUrl = params.url;
                if (!targetStreamUrl) {
                    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                    return res.end('Missing url');
                }

                const targetParsed = url.parse(targetStreamUrl);

                // 智能根据域名设置防盗链 Referer 与 User-Agent
                let referer = '';
                let proxyUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
                const host = (targetParsed.hostname || '').toLowerCase();

                if (host.includes('bilibili.com') || host.includes('bilivideo.com') || host.includes('bilivideo.cn') || host.includes('hdslb.com') || host.includes('akamaized.net') || host.includes('szbdyd.com')) {
                    referer = 'https://www.bilibili.com/';
                } else if (host.includes('douyin') || host.includes('snssdk.com') || host.includes('amemv.com') || host.includes('bytecdn') || host.includes('zijieapi') || host.includes('zjcdn') || host.includes('bytedance') || host.includes('bytetos') || host.includes('volccdn')) {
                    referer = 'https://www.douyin.com/';
                    proxyUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
                } else if (host.includes('163.com') || host.includes('126.net') || host.includes('163cn.tv')) {
                    referer = 'https://music.163.com/';
                }

                try {
                    const proxyHeaders = {
                        'User-Agent': proxyUa
                    };
                    if (referer) {
                        proxyHeaders['Referer'] = referer;
                    }
                    if (req.headers['range']) {
                        proxyHeaders['Range'] = req.headers['range'];
                    }

                    const streamRes = await fetch(targetStreamUrl, {
                        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                        headers: proxyHeaders
                    });

                    const responseHeaders = {};
                    for (const [k, v] of streamRes.headers.entries()) {
                        const lk = k.toLowerCase();
                        if (!['content-encoding', 'transfer-encoding', 'connection', 'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods'].includes(lk)) {
                            responseHeaders[k] = v;
                        }
                    }

                    // 强制覆盖跨域头，确保前端无论任何情况均能正常读取流数据
                    responseHeaders['Access-Control-Allow-Origin'] = '*';
                    responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, HEAD, OPTIONS';
                    responseHeaders['Access-Control-Allow-Headers'] = '*';
                    responseHeaders['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges';

                    res.writeHead(streamRes.status, responseHeaders);

                    if (req.method === 'HEAD' || !streamRes.body) {
                        res.end();
                        return;
                    }

                    const nodeStream = Readable.fromWeb(streamRes.body);
                    nodeStream.on('error', (err) => {
                        console.warn('代理流读取异常:', err.message);
                        if (!res.headersSent) {
                            res.writeHead(502, { 'Content-Type': 'text/plain; charset=UTF-8', 'Access-Control-Allow-Origin': '*' });
                            res.end('流传输中断: ' + err.message);
                        } else {
                            res.destroy();
                        }
                    });

                    req.on('close', () => {
                        nodeStream.destroy();
                    });

                    nodeStream.pipe(res);
                    return;
                } catch (proxyErr) {
                    res.writeHead(502, { 
                        'Content-Type': 'text/plain; charset=UTF-8',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
                        'Access-Control-Allow-Headers': '*'
                    });
                    res.end('代理拉取流媒体失败: ' + proxyErr.message);
                    return;
                }
            }

            return sendJson({ code: 404, msg: '未知 API 请求: ' + action });
        } catch (err) {
            console.error('API 处理异常:', err);
            return sendJson({ code: 500, msg: '服务器内部错误: ' + err.message });
        }
    }

    // 静态文件服务
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = '/index.html';
    let filePath = path.join(PUBLIC_DIR, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // 如果不存在，回退到 index.html
            filePath = path.join(PUBLIC_DIR, 'index.html');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (readErr, content) => {
            if (readErr) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
                res.end('无法读取文件: ' + readErr.message);
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            }
        });
    });
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(` 🎵 音乐音视频提取器已就绪！`);
    console.log(` 本地服务地址: http://127.0.0.1:${PORT}`);
    console.log(`=================================================`);
});

const mediaDomains = {
    netease: ['music.126.net', 'music.163.com', 'music.163yun.com'],
    bilibili: ['bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'hdslb.com', 'upos-hz-mirrorakam.akamaized.net'],
    douyin: ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'iesdouyin.com', 'bytevcloudcdn.com', 'bytecdn.cn', 'byteimg.com',
        'douyinstatic.com', 'douyincdn.com', 'amemv.com', 'snssdk.com', 'pstatp.com', 'zjcdn.com', 'zijieapi.com']
};

function isPlatformMediaUrl(value, platform) {
    try {
        const address = new URL(value);
        return address.protocol === 'https:' && !address.username && !address.password && !address.port &&
            mediaDomains[platform]?.some(domain => address.hostname === domain || address.hostname.endsWith('.' + domain));
    } catch {
        return false;
    }
}

module.exports = { server, handleSearch, handleSongParse, handlePlaylistParse, handleBilibiliParse, handleDouyinParse,
    extractSongId, extractPlaylistId, mergeLyrics, isPlatformMediaUrl, selectVideoStream };
