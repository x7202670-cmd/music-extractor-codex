param(
    [string]$TargetDir = (Join-Path $env:USERPROFILE '.gemini\config\plugins\music-extractor'),
    [string]$FfmpegPath = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

# 定位插件源目录（兼容 GitHub 仓库根目录、解压包根目录及源码 ai-plugin 目录）
$pluginSource = $null
$repoCandidate = Join-Path $PSScriptRoot 'plugins\music-extractor'
$localCandidate = Join-Path $PSScriptRoot 'music-extractor'
if (Test-Path -LiteralPath (Join-Path $repoCandidate 'mcp-server.cjs')) {
    $pluginSource = $repoCandidate
} elseif (Test-Path -LiteralPath (Join-Path $localCandidate 'mcp-server.cjs')) {
    $pluginSource = $localCandidate
} else {
    throw "未找到 plugins/music-extractor/mcp-server.cjs，请在仓库根目录或安装包根目录运行本脚本。"
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$targetFull = [IO.Path]::GetFullPath($TargetDir)
New-Item -ItemType Directory -Path $targetFull -Force | Out-Null

# 复制核心脚本
foreach ($file in @('mcp-server.cjs', 'tools.cjs', 'sources.cjs', 'files.cjs')) {
    Copy-Item -LiteralPath (Join-Path $pluginSource $file) -Destination (Join-Path $targetFull $file) -Force
}

# 复制后端逻辑（优先使用同级 backend.cjs，否则回退项目根目录 server.js）
$bundledBackend = Join-Path $pluginSource 'backend.cjs'
$rootServer = Join-Path $projectRoot 'server.js'
if (Test-Path -LiteralPath $bundledBackend) {
    Copy-Item -LiteralPath $bundledBackend -Destination (Join-Path $targetFull 'backend.cjs') -Force
} elseif (Test-Path -LiteralPath $rootServer) {
    Copy-Item -LiteralPath $rootServer -Destination (Join-Path $targetFull 'backend.cjs') -Force
} else {
    throw "未找到 backend.cjs 或 server.js。"
}

# 复制技能目录
$skillsSrc = Join-Path $pluginSource 'skills'
$skillsDst = Join-Path $targetFull 'skills'
if (Test-Path -LiteralPath $skillsDst) {
    Remove-Item -LiteralPath $skillsDst -Recurse -Force
}
if (Test-Path -LiteralPath $skillsSrc) {
    Copy-Item -LiteralPath $skillsSrc -Destination $skillsDst -Recurse -Force
}

# 复制可选的内置 FFmpeg 与第三方开源许可文件
foreach ($extra in @('ffmpeg.exe', 'THIRD_PARTY_NOTICES.md', 'licenses')) {
    $extraSrc = Join-Path $pluginSource $extra
    if (Test-Path -LiteralPath $extraSrc) {
        Copy-Item -LiteralPath $extraSrc -Destination (Join-Path $targetFull $extra) -Recurse -Force
    }
}

# 生成符合 Antigravity 规范的 plugin.json（仅使用支持的顶层字段）
$sourceManifest = Get-Content -LiteralPath (Join-Path $pluginSource 'plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$antigravityManifest = [ordered]@{
    name             = 'music-extractor'
    displayName      = '音乐提取器'
    version          = if ($sourceManifest.version) { $sourceManifest.version } else { '1.2.0' }
    description      = '搜索网易云音乐，解析B站和抖音视频/图集（含实况），并在本机下载和提取音频（MP3/FLAC/WAV）。'
    repository       = 'https://github.com/x7202670-cmd/music-extractor-codex'
    suggestedPrompts = @(
        '在网易云搜索周杰伦的《稻香》并下载',
        '解析并下载这个 B 站或抖音视频/图集',
        '把本地视频的音轨提取成 MP3 或 FLAC'
    )
}
$manifestJson = $antigravityManifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $targetFull 'plugin.json'), $manifestJson + "`n", $utf8NoBom)

# 生成 Antigravity 的 mcp_config.json（绝对路径指向本机 mcp-server.cjs）
$mcpEntry = Join-Path $targetFull 'mcp-server.cjs'
$serverEntry = [ordered]@{
    command = 'node'
    args    = @($mcpEntry)
}
if (-not [string]::IsNullOrWhiteSpace($FfmpegPath)) {
    $serverEntry.env = [ordered]@{
        MUSIC_EXTRACTOR_FFMPEG = [IO.Path]::GetFullPath($FfmpegPath)
    }
}
$mcpConfig = [ordered]@{
    mcpServers = [ordered]@{
        'music-extractor' = $serverEntry
    }
}
$mcpJson = $mcpConfig | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $targetFull 'mcp_config.json'), $mcpJson + "`n", $utf8NoBom)

Write-Host "已将「音乐提取器」安装到 Antigravity 插件目录：$targetFull"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warning "未在 PATH 中检测到 node，请先安装 Node.js 24.5 或更新版本。"
} else {
    Write-Host ("检测到 Node.js：" + (& node -v))
}

$hasBundledFfmpeg = Test-Path -LiteralPath (Join-Path $targetFull 'ffmpeg.exe')
$hasPathFfmpeg = [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue)
if (-not $hasBundledFfmpeg -and -not $hasPathFfmpeg -and [string]::IsNullOrWhiteSpace($FfmpegPath)) {
    Write-Warning "当前未检测到内置或 PATH 中的 ffmpeg。如需要转码音频或合并 B 站 4K，请安装 FFmpeg 并加入 PATH，或使用 -FfmpegPath 参数重新运行。"
}
