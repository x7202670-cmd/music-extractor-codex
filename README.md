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

- 网易云支持搜索、单曲和歌单解析。未配置 Cookie 时按访客权限访问（VIP 歌曲通常返回 30 秒试听并标记 `isPreview`）；导入本人网易云 `MUSIC_U` Cookie 后，可按账号权限下载完整音频与无损/高码率音质（如 `lossless`、`hires` 等）。
- B 站支持 BV/AV 号、分享链接和分 P。插件通过官方播放接口查询 DASH 和经实际请求确认的直出档位。平台提供分离的视频流和音轨时，插件可以把两者封装成 MP4。
- 抖音支持公开视频和分享文案，分辨率取决于官方分享页提供的媒体流。
- 本地音频提取在电脑上运行。支持 MP3、FLAC、WAV。

## 账号 Cookie 导入（网易云音乐与 B 站高画质）

本插件支持在本机分别导入**网易云音乐**和 **B 站**账号凭据。每次解析都会自动读取配置，**请只在本机保存，切勿粘贴到对话中或提交到代码仓库**。

### 1. 网易云音乐 Cookie（`MUSIC_U`，用于下载完整 VIP 歌曲与无损音质）

1. 在电脑浏览器登录网页版网易云音乐 `https://music.163.com`。
2. 按 `F12` 打开开发者工具，进入 **应用程序（Application）→ 存储 → Cookie → `https://music.163.com`**，找到 `MUSIC_U` 并复制它的**值（Value）**。
3. 将该值（或包含 `MUSIC_U=...` 的 Cookie）单独保存到 `%USERPROFILE%\.music-extractor\netease-session.txt`，或者设置环境变量 `MUSIC_EXTRACTOR_NETEASE_SESSION`。

可在 Windows PowerShell 运行以下命令创建并打开配置文件：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.music-extractor" | Out-Null
notepad "$env:USERPROFILE\.music-extractor\netease-session.txt"
```

### 2. B 站高画质 Cookie（`SESSDATA`，用于下载 1080p / 4K / 8K 视频）

游客可直接查询基础画质。需要登录才能获取的档位（如 1080p、4K `2160p`、8K `4320p`，具体取决于视频本身与 B 站授予当前账号的权限）：

1. 在电脑浏览器登录 `https://www.bilibili.com`。
2. 按 `F12` 打开开发者工具，进入 **应用程序（Application）→ 存储 → Cookie → `https://www.bilibili.com`**，找到 `SESSDATA` 并复制它的**值（Value）**。
3. 将 `SESSDATA` 原始值单独保存到 `%USERPROFILE%\.music-extractor\bilibili-session.txt`，或者设置环境变量 `MUSIC_EXTRACTOR_BILIBILI_SESSION`。

可在 Windows PowerShell 运行以下命令创建并打开配置文件：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.music-extractor" | Out-Null
notepad "$env:USERPROFILE\.music-extractor\bilibili-session.txt"
```

可以先问「这个 B 站视频最高能下载多少分辨率」，然后指定实际列出的档位。

### 3. 隐私说明

上述 `netease-session.txt` 与 `bilibili-session.txt` 均存放在用户本机主目录 `%USERPROFILE%\.music-extractor\` 下，位于插件目录与项目仓库之外。插件仅在解析对应平台时，将凭据分别发送给网易云官方播放接口或 B 站官方播放接口。
