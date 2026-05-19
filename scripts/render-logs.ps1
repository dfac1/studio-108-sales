# Хелпер для быстрого пулла логов Render через их REST API.
# Использует токен из .render-token в корне (.gitignore'нут).
#
# Примеры:
#   .\scripts\render-logs.ps1                       # последние 15 мин, 200 строк
#   .\scripts\render-logs.ps1 -Minutes 60           # последний час
#   .\scripts\render-logs.ps1 -Filter "/api/voice"  # только turn-запросы
#   .\scripts\render-logs.ps1 -OnlyErrors           # только 4xx/5xx и error-уровень
#   .\scripts\render-logs.ps1 -ToFile logs.txt      # сохранить в файл

param(
  [int]$Minutes = 15,
  [int]$Limit = 250,
  [string]$Filter = $null,
  [switch]$OnlyErrors,
  [string]$ToFile = $null,
  [string]$ServiceId = "srv-d85jv40g4nts7383cqo0",
  [string]$OwnerId = "tea-d85js2jrjlhs73e3e7mg"
)

$ErrorActionPreference = 'Stop'

$tokenPath = Join-Path $PSScriptRoot "..\.render-token"
if (-not (Test-Path $tokenPath)) {
  Write-Error ".render-token not found at $tokenPath"
  exit 1
}
$tok = (Get-Content $tokenPath -Raw).Trim()

$end = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$start = (Get-Date).AddMinutes(-$Minutes).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$headers = @{ Authorization = "Bearer $tok"; Accept = "application/json" }
$url = "https://api.render.com/v1/logs?ownerId=$OwnerId&resource=$ServiceId&startTime=$start&endTime=$end&limit=$Limit&direction=backward"

$resp = Invoke-RestMethod -Uri $url -Headers $headers -Method GET

$lines = $resp.logs | Sort-Object timestamp | ForEach-Object {
  $ts = ([DateTime]$_.timestamp).ToLocalTime().ToString("HH:mm:ss")
  $msg = $_.message
  # Если pino-JSON — распарсим и оставим только полезное.
  if ($msg.StartsWith('{') -and $msg -match '"level":') {
    try {
      $j = $msg | ConvertFrom-Json
      $level = switch ($j.level) { 10 {'TRC'} 20 {'DBG'} 30 {'INF'} 40 {'WRN'} 50 {'ERR'} 60 {'FTL'} default {$j.level} }
      $short = if ($j.msg) { $j.msg } else { "" }
      if ($j.req) { $short = "$($j.req.method) $($j.req.url)" }
      if ($j.res) { $short = "$short -> $($j.res.statusCode) ($([math]::Round($j.responseTime,0))ms)" }
      if ($j.err) { $short = "$short | err=$($j.err.message)" }
      "[$ts $level] $short"
    } catch {
      "[$ts] $msg"
    }
  } else {
    "[$ts] $msg"
  }
}

if ($Filter) { $lines = $lines | Where-Object { $_ -match $Filter } }
if ($OnlyErrors) { $lines = $lines | Where-Object { $_ -match ' ERR ' -or $_ -match 'WRN' -or $_ -match '-> [45]\d\d ' } }

if ($ToFile) {
  $lines | Out-File -FilePath $ToFile -Encoding utf8
  "Saved $($lines.Count) lines to $ToFile"
} else {
  $lines
}
