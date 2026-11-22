# 音乐提取器 · Codex 桌面插件

这个插件让 AI 在 Windows 上调用音乐提取器。需要 Windows、Node.js 24.5 或更新版本，以及独立安装的 FFmpeg。

## 安装

1. 克隆本仓库，或解压 GitHub 下载的源码 ZIP。安装 [FFmpeg](https://ffmpeg.org/download.html)，将其 `bin` 目录加入 Windows 的 `PATH`，或设置 `MUSIC_EXTRACTOR_FFMPEG` 为 `ffmpeg.exe` 的绝对路径。重启桌面版后生效。
2. 在桌面版打开 **插件 → 添加 → 添加插件市场**，填入源码根目录的绝对路径。使用 Codex CLI 时，也可以在源码根目录运行以下命令。

   ```powershell
   codex plugin marketplace add .
   ```

3. 在 **音乐提取器 · 本地插件** 中安装插件，切换到 **Codex → 此计算机**，然后在新对话中输入 `@音乐提取器`。

如果桌面版提供 **设置 → MCP 服务器**，也可以直接添加一个本地 stdio 服务器。命令填 `node`，参数填源码中的 `plugins/music-extractor/mcp-server.cjs` 的绝对路径。使用 Codex CLI 时，等效命令如下，在解压根目录执行。

```powershell
$entry = (Resolve-Path -LiteralPath './plugins/music-extractor/mcp-server.cjs').Path
codex mcp add music-extractor -- node $entry
```

本插件按 Codex 桌面本地运行方式打包。安装方式参见 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins) 和 [桌面插件文档](https://developers.openai.com/plugins/deploy/desktop-only)。

## 使用示例

- 「在网易云搜索周杰伦的《稻香》，列出前五个结果。」
- 「解析我贴的网易云歌单，先列出前 20 首。」
- 「解析这个 B 站链接的第 2 P，再把视频音轨保存成 WAV。」
- 「列出这个 B 站视频当前可用的分辨率，下载 720P 的 MP4。」
- 「下载这个抖音视频目前能取得的最高分辨率。」
- 「把 `C:/Videos/input.mp4` 的音轨提取成 MP3。」

下载和转码会返回输出文件的绝对路径。默认保存到用户目录下的 `Downloads/音乐提取器`。同名输出会自动添加编号。

`resolve_media` 和 `download_media` 的 `resolution` 参数适用于 B 站和抖音。默认 `best`，也可指定 `720p`、`1080p` 或 `2160p` 等档位。解析会列出本次取得的可选档位。指定档位不可用时，下载会报错并列出本次找到的档位。下载 MP4 时返回实际分辨率和画面宽高。分辨率以画面短边为准，例如竖屏 720×960 为 `720p`。B 站的 `quality` 字段另行报告平台档位。

## 功能范围

- 网易云支持搜索、单曲和歌单解析。插件按访客权限访问平台，下载结果会标记是否为官方试听。
- B 站支持 BV/AV 号、分享链接和分 P。插件通过官方播放接口查询 DASH 和经实际请求确认的直出档位。平台提供分离的视频流和音轨时，插件可以把两者封装成 MP4。
- 抖音支持公开视频和分享文案，分辨率取决于官方分享页提供的媒体流。
- 本地音频提取在电脑上运行。支持 MP3、FLAC、WAV。

## B 站高画质

游客可直接查询画质。需要登录才能获取的档位，可将你本人 B 站账号的 `SESSDATA` 原始值单独保存在 `%USERPROFILE%\.music-extractor\bilibili-session.txt`，或由本机环境变量 `MUSIC_EXTRACTOR_BILIBILI_SESSION` 提供。每次解析都会检查配置。请在本机配置该值，避免粘贴到对话中或纳入项目文件。插件仅向 B 站官方播放接口发送它。

可用的 1080p、4K（通常为 `2160p`）或 8K（通常为 `4320p`）取决于视频和 B 站授予当前账号的权限。可以先问「这个 B 站视频最高能下载多少分辨率」，然后指定实际列出的档位。
