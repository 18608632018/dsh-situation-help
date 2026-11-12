<#
  test-sensor.ps1 - verification harness for sense.ps1 (Windows PowerShell 5.1).

  Run:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File test-sensor.ps1
        powershell.exe ... -Stage 1          # single stage: 1..6
        powershell.exe ... -Hotkey "Ctrl+Alt+V"

  Stages:
    1  self-test: ready + sample with real OCR text, every line parses as JSON
    2  live 15 s with window switching: >=3 samples with different app/title, JPEG opens
    3  hotkey: PostMessage WM_HOTKEY to ready.hwnd, expect a "hotkey" line
    4  control: paused:true stops frames (paused samples appear), stop:true exits with "bye"
    5  cost: 60 s run -> CPU seconds, frame count, total frame bytes
    6  tutor watch: whole-screen mode installs the click hook, writes no JPEG, then uninstalls it

  Exit code 0 when every check passes, 1 otherwise.
#>
[CmdletBinding()]
param(
  [string]$SensorPath = '',
  [string]$WorkDir = $(Join-Path $env:TEMP 'situation-sensor-test'),
  [string]$Hotkey = 'Ctrl+Alt+V',
  [int]$Stage = 0,
  [int]$LiveSeconds = 15,
  [int]$CostSeconds = 60,
  [int]$IntervalMs = 1200
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SensorPath)) {
  $here = $null
  try { $here = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { }
  if (-not $here) { $here = (Get-Location).ProviderPath }
  $SensorPath = Join-Path $here 'sense.ps1'
}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$script:Pass = 0
$script:Fail = 0
$script:Results = New-Object System.Collections.Generic.List[string]

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) {
    $script:Pass++
    $line = 'PASS  ' + $name
    if ($detail) { $line += '   [' + $detail + ']' }
    Write-Host $line -ForegroundColor Green
  } else {
    $script:Fail++
    $line = 'FAIL  ' + $name
    if ($detail) { $line += '   [' + $detail + ']' }
    Write-Host $line -ForegroundColor Red
  }
  [void]$script:Results.Add($line)
}

function Info([string]$text) { Write-Host $text -ForegroundColor Cyan }

if (-not (Test-Path $SensorPath)) { Write-Host "sensor not found: $SensorPath" -ForegroundColor Red; exit 1 }
# ---------------------------------------------------------------------------
# interop for the harness
# ---------------------------------------------------------------------------
$cs = @'
using System;
using System.Runtime.InteropServices;
public static class TestWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    public static int ForePid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return (int)pid; }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll')

function Read-JsonLines([string]$path) {
  if (-not (Test-Path $path)) { return @() }
  $text = ''
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $text = $sr.ReadToEnd()
    $sr.Dispose()
    $fs.Dispose()
  } catch { return @() }
  $res = New-Object System.Collections.Generic.List[object]
  foreach ($l in ($text -split "`r?`n")) {
    $t = $l.Trim()
    if ($t -eq '') { continue }
    try { [void]$res.Add(($t | ConvertFrom-Json)) }
    catch { [void]$res.Add([pscustomobject]@{ type = 'PARSE_FAIL'; raw = $t }) }
  }
  return $res
}

function Set-Control([string]$dir, [hashtable]$obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress
  [System.IO.File]::WriteAllText((Join-Path $dir 'control.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Start-Sensor([string]$dir, [string]$hotkey, [int]$interval) {
  if (-not (Test-Path $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
  $ctl = Join-Path $dir 'control.json'
  if (Test-Path $ctl) { Remove-Item $ctl -Force }
  $frames = Join-Path $dir 'frames'
  if (Test-Path $frames) { Remove-Item $frames -Recurse -Force }
  $stdout = Join-Path $dir 'stdout.log'
  $stderr = Join-Path $dir 'stderr.log'
  if (Test-Path $stdout) { Remove-Item $stdout -Force }
  if (Test-Path $stderr) { Remove-Item $stderr -Force }
  $args = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $SensorPath,
    '-OutDir', $dir, '-IntervalMs', "$interval", '-FrameMaxWidth', '1280',
    '-JpegQuality', '62', '-Ocr', '1', '-Clipboard', '0',
    '-IdleSkipSeconds', '240', '-FrameRetentionMinutes', '30',
    '-Hotkey', $hotkey, '-SelfTest', '0'
  )
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  return [pscustomobject]@{ Process = $p; Out = $stdout; Err = $stderr; Dir = $dir; Frames = $frames }
}

function Wait-Ready($run, [int]$timeoutMs = 20000) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    foreach ($o in (Read-JsonLines $run.Out)) {
      if ($o.type -eq 'ready') { return $o }
    }
    if ($run.Process.HasExited) { return $null }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

function Stop-Sensor($run, [int]$timeoutMs = 8000) {
  try {
    if (-not $run.Process.HasExited) {
      Set-Control $run.Dir @{ stop = $true }
      if (-not $run.Process.WaitForExit($timeoutMs)) { $run.Process.Kill() }
    }
  } catch { }
}

function Close-App($proc) {
  try { if ($proc -and -not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit(3000) | Out-Null } } catch { }
}

function Activate-Pid([int]$procId) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $ok = $ws.AppActivate($procId)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
    return [bool]$ok
  } catch { return $false }
}

function Wait-MainWindow($proc, [int]$timeoutMs = 8000) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    try { $proc.Refresh() } catch { return 0 }
    if ($proc.MainWindowHandle -ne 0) { return [int64]$proc.MainWindowHandle }
    if ($proc.HasExited) { return 0 }
    Start-Sleep -Milliseconds 150
  }
  return 0
}

function Test-Jpeg([string]$path) {
  try {
    $img = [System.Drawing.Image]::FromFile($path)
    $fmt = 'unknown'
    try { if ($img.RawFormat.Guid -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid) { $fmt = 'JPEG' } else { $fmt = $img.RawFormat.ToString() } } catch { }
    $r = @{ Ok = $true; Width = $img.Width; Height = $img.Height; Format = $fmt }
    $img.Dispose()
    return $r
  } catch { return @{ Ok = $false; Width = 0; Height = 0; Format = '' } }
}

# ---------------------------------------------------------------------------
# stage 1 - self test
# ---------------------------------------------------------------------------
function Stage-SelfTest {
  Info '=== Stage 1: -SelfTest 1 ==='
  $dir = Join-Path $WorkDir 'selftest'
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SensorPath -SelfTest 1 -OutDir $dir 2>$null
  $code = $LASTEXITCODE
  $sw.Stop()
  $objs = @()
  $bad = 0
  foreach ($l in $raw) {
    if ([string]::IsNullOrWhiteSpace($l)) { continue }
    try { $objs += ($l | ConvertFrom-Json) } catch { $bad++; Write-Host ('  unparsable: ' + $l) -ForegroundColor Red }
  }
  $ready = $objs | Where-Object { $_.type -eq 'ready' } | Select-Object -First 1
  $sample = $objs | Where-Object { $_.type -eq 'sample' } | Select-Object -First 1
  Check 'selftest exit code 0' ($code -eq 0) "exit=$code ms=$($sw.ElapsedMilliseconds)"
  Check 'every stdout line parses as JSON' ($bad -eq 0) "lines=$($objs.Count)"
  Check 'ready line present' ($null -ne $ready)
  Check 'ready.protocol = 1' ($ready -and $ready.protocol -eq 1)
  Check 'ready has hwnd field' ($ready -and ($ready.PSObject.Properties.Name -contains 'hwnd')) "hwnd=$($ready.hwnd)"
  Check 'ready.ocr is a language tag' ($ready -and $ready.ocr) "ocr=$($ready.ocr)"
  Check 'sample line present' ($null -ne $sample)
  if ($sample) {
    $reportedTime = [DateTimeOffset]::Parse([string]$sample.ts).ToUnixTimeMilliseconds()
    $clockDifference = [math]::Abs([long]$sample.epoch - $reportedTime)
    Check 'sample epoch agrees with timestamp and UTC offset' ($clockDifference -lt 1000) "differenceMs=$clockDifference"
  }
  Check 'sample.ocr.text non-empty' ($sample -and $sample.ocr -and $sample.ocr.text.Length -gt 20) "len=$(if($sample.ocr){$sample.ocr.text.Length}else{0})"
  Check 'sample.ocr.hash is sha1 hex' ($sample -and $sample.ocr -and ($sample.ocr.hash -match '^[0-9a-f]{40}$'))
  Check 'sample.frame written' ($sample -and $sample.frame) "frame=$($sample.frame)"
  if ($sample -and $sample.frame) {
    $full = Join-Path $dir ($sample.frame -replace '/', '\')
    $j = Test-Jpeg $full
    Check 'frame opens as image' $j.Ok "$($j.Width)x$($j.Height) $($j.Format)"
  }
  if ($sample -and $sample.ocr) {
    Info ('  OCR text: ' + $sample.ocr.text.Substring(0, [math]::Min(160, $sample.ocr.text.Length)))
  }
  return $sample
}

# ---------------------------------------------------------------------------
# stage 2 - live run with window switching
# ---------------------------------------------------------------------------
function Stage-Live {
  Info '=== Stage 2: live run, window switching ==='
  $dir = Join-Path $WorkDir 'live'
  $run = Start-Sensor $dir $Hotkey $IntervalMs
  $ready = Wait-Ready $run
  Check 'live: ready within 20 s' ($null -ne $ready) "hotkey=$($ready.hotkey) ok=$($ready.hotkeyOk)"

  $origPid = 0
  try { $origPid = [TestWin]::ForePid() } catch { }
  $app = Start-Process -FilePath 'notepad.exe' -PassThru
  $hw = Wait-MainWindow $app
  Check 'notepad window created' ($hw -ne 0) "hwnd=$hw"
  $paint = Start-Process -FilePath 'mspaint.exe' -PassThru
  $hw2 = Wait-MainWindow $paint
  Check 'mspaint window created' ($hw2 -ne 0) "hwnd=$hw2"

  # cycle three different windows so at least three distinct app|title pairs must appear
  $cycle = New-Object System.Collections.Generic.List[int]
  if ($origPid -gt 0) { [void]$cycle.Add($origPid) }
  [void]$cycle.Add($app.Id)
  if ($hw2 -ne 0) { [void]$cycle.Add($paint.Id) }
  $t0 = [System.Diagnostics.Stopwatch]::StartNew()
  $i = 0
  while ($t0.Elapsed.TotalSeconds -lt $LiveSeconds) {
    $target = $cycle[$i % $cycle.Count]
    [void](Activate-Pid $target)
    $i++
    Start-Sleep -Milliseconds 2300
  }
  $objs = Read-JsonLines $run.Out
  $samples = @($objs | Where-Object { $_.type -eq 'sample' })
  $frames = @($objs | Where-Object { $_.frame })
  $keys = @($samples | ForEach-Object { '' + $_.app + '|' + $_.title } | Sort-Object -Unique)
  $apps = @($samples | ForEach-Object { $_.app } | Sort-Object -Unique)
  $ocrs = @($samples | Where-Object { $_.ocr })
  $parse_fail = @($objs | Where-Object { $_.type -eq 'PARSE_FAIL' }).Count

  Check 'live: every stdout line parses' ($parse_fail -eq 0) "lines=$($objs.Count)"
  Check 'live: >= 5 samples' ($samples.Count -ge 5) "samples=$($samples.Count)"
  Check 'live: >= 3 distinct app|title' ($keys.Count -ge 3) ($keys -join ' / ')
  Check 'live: >= 2 distinct apps' ($apps.Count -ge 2) ($apps -join ',')
  Check 'live: >= 1 OCR result' ($ocrs.Count -ge 1) "ocrs=$($ocrs.Count)"

  $lastJpeg = $null
  if ($frames.Count -gt 0) {
    $rel = $frames[$frames.Count - 1].frame
    $full = Join-Path $dir ($rel -replace '/', '\')
    $lastJpeg = Test-Jpeg $full
    Check 'live: frame file opens as JPEG' $lastJpeg.Ok "$rel $($lastJpeg.Width)x$($lastJpeg.Height) $([math]::Round((Get-Item $full).Length/1024,1)) KB"
  } else {
    Check 'live: frame file opens as JPEG' $false 'no frames at all'
  }

  # interval jitter: emit-time deltas (what the host sees) and tick-start deltas
  # (loop honesty; a sample is emitted after its own OCR, so emit time wobbles).
  if ($samples.Count -ge 3) {
    $starts = @()
    foreach ($s in $samples) {
      $w = 0
      if ($s.ocr) { $w = [int]$s.ocr.ms }
      $starts += ([int64]$s.epoch - $w)
    }
    $deltas = @()
    for ($i = 2; $i -lt $starts.Count; $i++) { $deltas += [double]($starts[$i] - $starts[$i - 1]) }
    $emitDeltas = @()
    for ($i = 1; $i -lt $samples.Count; $i++) { $emitDeltas += [double]($samples[$i].epoch - $samples[$i - 1].epoch) }
    $avg = ($deltas | Measure-Object -Average).Average
    $max = ($deltas | Measure-Object -Maximum).Maximum
    $min = ($deltas | Measure-Object -Minimum).Minimum
    $sd = 0.0
    if ($deltas.Count -gt 1) {
      $v = 0.0
      foreach ($d in $deltas) { $v += [math]::Pow($d - $avg, 2) }
      $sd = [math]::Sqrt($v / $deltas.Count)
    }
    Info ("  tick-start deltas: avg={0:N0}ms min={1:N0} max={2:N0} sd={3:N0} (interval={4})" -f $avg, $min, $max, $sd, $IntervalMs)
    Info ("  emit deltas:       min={0:N0} max={1:N0}" -f (($emitDeltas | Measure-Object -Minimum).Minimum), (($emitDeltas | Measure-Object -Maximum).Maximum))
    Check 'live: mean tick interval within 15% of IntervalMs' ([math]::Abs($avg - $IntervalMs) -lt ($IntervalMs * 0.15)) ("{0:N0}ms vs {1}ms" -f $avg, $IntervalMs)
  }
  if ($ocrs.Count -ge 1) {
    $ms = ($ocrs | ForEach-Object { $_.ocr.ms } | Measure-Object -Average -Maximum)
    Info ("  OCR ms: avg={0:N0} max={1:N0} on {2} frames" -f $ms.Average, $ms.Maximum, $ocrs.Count)
  }
  foreach ($s in ($samples | Select-Object -Last 3)) {
    Info ('  sample: app=' + $s.app + ' title=' + $s.title + ' changed=' + $s.changed + ' score=' + $s.score + ' frame=' + $s.frame)
  }

  Stop-Sensor $run
  Close-App $app
  Close-App $paint
  return $dir
}

# ---------------------------------------------------------------------------
# stage 3 - hotkey
# ---------------------------------------------------------------------------
function Stage-Hotkey {
  Info '=== Stage 3: global hotkey (PostMessage WM_HOTKEY) ==='
  $dir = Join-Path $WorkDir 'hotkey'
  $run = Start-Sensor $dir $Hotkey $IntervalMs
  $ready = Wait-Ready $run
  Check 'hotkey: ready within 20 s' ($null -ne $ready) "hotkey=$($ready.hotkey)"
  Check 'hotkey: hotkeyOk true' ($ready -and $ready.hotkeyOk) "error=$((Read-JsonLines $run.Out | Where-Object { $_.type -eq 'error' } | Select-Object -First 1).message)"
  Check 'hotkey: hwnd non-zero' ($ready -and $ready.hwnd -ne 0) "hwnd=$($ready.hwnd)"
  if ($ready -and $ready.hwnd) {
    $h = [IntPtr][int64]$ready.hwnd
    Check 'hotkey: window handle is live' ([TestWin]::IsWindow($h)) "hwnd=$($ready.hwnd)"
    $posted = [TestWin]::PostMessage($h, 0x0312, [IntPtr]1, [IntPtr]::Zero)
    Check 'hotkey: PostMessage WM_HOTKEY accepted' $posted
    Start-Sleep -Milliseconds 900
    $objs = Read-JsonLines $run.Out
    $hk = @($objs | Where-Object { $_.type -eq 'hotkey' })
    Check 'hotkey: hotkey line emitted' ($hk.Count -ge 1) "count=$($hk.Count)"
    if ($hk.Count -ge 1) {
      Check 'hotkey: id = toggle' ($hk[0].id -eq 'toggle')
      Check 'hotkey: hwnd matches ready' ([int64]$hk[0].hwnd -eq [int64]$ready.hwnd)
      Info ('  hotkey line: ' + (ConvertTo-Json -InputObject $hk[0] -Compress))
    }
  }
  Stop-Sensor $run
}

# ---------------------------------------------------------------------------
# stage 4 - control file
# ---------------------------------------------------------------------------
function Stage-Control {
  Info '=== Stage 4: control.json (paused / stop) ==='
  $dir = Join-Path $WorkDir 'control'
  $run = Start-Sensor $dir $Hotkey $IntervalMs
  $ready = Wait-Ready $run
  Check 'control: ready' ($null -ne $ready)
  Start-Sleep -Milliseconds 3500
  $before = 0
  if (Test-Path $run.Frames) { $before = @(Get-ChildItem $run.Frames -Filter '*.jpg').Count }
  Check 'control: frames captured before pause' ($before -ge 1) "frames=$before"

  Set-Control $dir @{ paused = $true; capture = $true; ocr = $true; clipboard = $false; stop = $false }
  Start-Sleep -Milliseconds 1500
  $pausedCount = 0
  if (Test-Path $run.Frames) { $pausedCount = @(Get-ChildItem $run.Frames -Filter '*.jpg').Count }
  Start-Sleep -Milliseconds 6000
  $after = 0
  if (Test-Path $run.Frames) { $after = @(Get-ChildItem $run.Frames -Filter '*.jpg').Count }
  Check 'control: no new frames while paused' ($after -eq $pausedCount) "before=$before afterPause=$pausedCount after6s=$after"

  $objs = Read-JsonLines $run.Out
  $pausedSamples = @($objs | Where-Object { $_.type -eq 'sample' -and $_.paused })
  $statusLines = @($objs | Where-Object { $_.type -eq 'status' })
  Check 'control: paused samples emitted' ($pausedSamples.Count -ge 1) "count=$($pausedSamples.Count)"
  Check 'control: status line emitted' ($statusLines.Count -ge 1) "count=$($statusLines.Count)"
  if ($pausedSamples.Count -ge 1) {
    Check 'control: paused sample has no frame' (-not ($pausedSamples[0].PSObject.Properties.Name -contains 'frame'))
    Info ('  paused sample: ' + (ConvertTo-Json -InputObject $pausedSamples[0] -Compress))
  }

  Set-Control $dir @{ paused = $true; stop = $true }
  $exited = $run.Process.WaitForExit(6000)
  Check 'control: process exits on stop' $exited "exitCode=$($run.Process.ExitCode)"
  Start-Sleep -Milliseconds 200
  $objs = Read-JsonLines $run.Out
  $bye = $objs | Where-Object { $_.type -eq 'bye' } | Select-Object -Last 1
  Check 'control: bye line emitted' ($null -ne $bye)
  if ($bye) { Check 'control: bye.reason = control-stop' ($bye.reason -eq 'control-stop') "reason=$($bye.reason)" }
  if (-not $exited) { Stop-Sensor $run }
}

# ---------------------------------------------------------------------------
# stage 5 - cost
# ---------------------------------------------------------------------------
function Stage-Cost {
  Info "=== Stage 5: $CostSeconds s cost run ==="
  $dir = Join-Path $WorkDir 'cost'
  $run = Start-Sensor $dir $Hotkey $IntervalMs
  $ready = Wait-Ready $run
  Check 'cost: ready' ($null -ne $ready)
  $cpu0 = [double]0
  try { $run.Process.Refresh(); $cpu0 = $run.Process.TotalProcessorTime.TotalSeconds } catch { }
  Start-Sleep -Seconds $CostSeconds
  $cpu1 = [double]0
  $peakWs = [int64]0
  try {
    $run.Process.Refresh()
    $cpu1 = $run.Process.TotalProcessorTime.TotalSeconds
    $peakWs = $run.Process.WorkingSet64
  } catch { }
  $frames = 0
  $bytes = [int64]0
  if (Test-Path $run.Frames) {
    $fi = @(Get-ChildItem $run.Frames -Filter '*.jpg')
    $frames = $fi.Count
    if ($frames -gt 0) { $bytes = ($fi | Measure-Object -Property Length -Sum).Sum }
  }
  $objs = Read-JsonLines $run.Out
  $samples = @($objs | Where-Object { $_.type -eq 'sample' })
  $ocrs = @($samples | Where-Object { $_.ocr })
  $cpuUsed = $cpu1 - $cpu0
  $pct = 100.0 * $cpuUsed / $CostSeconds
  Info ("  CPU={0:N2}s over {1}s wall = {2:N1}% of one core; samples={3}; frames={4}; frame bytes={5:N0} ({6:N1} KB avg)" -f `
      $cpuUsed, $CostSeconds, $pct, $samples.Count, $frames, $bytes, $(if ($frames -gt 0) { $bytes / $frames / 1024 } else { 0 }))
  if ($ocrs.Count -ge 1) {
    $ms = ($ocrs | ForEach-Object { $_.ocr.ms } | Measure-Object -Average -Maximum)
    Info ("  OCR: count={0} avg={1:N0}ms max={2:N0}ms" -f $ocrs.Count, $ms.Average, $ms.Maximum)
  }
  Info ("  working set = {0:N1} MB" -f ($peakWs / 1MB))
  $ocrShare = 0.0
  if ($ocrs.Count -ge 1) { $ocrShare = (($ocrs | ForEach-Object { $_.ocr.ms } | Measure-Object -Sum).Sum) / 1000.0 }
  Info ("  OCR engine time = {0:N2}s of the {1:N2}s CPU ({2:N0}% of the total)" -f $ocrShare, $cpuUsed, $(if ($cpuUsed -gt 0) { 100 * $ocrShare / $cpuUsed } else { 0 }))
  Check 'cost: CPU under 25% of one core' ($pct -lt 25.0) ("{0:N2}% " -f $pct)
  Check 'cost: frames written' ($frames -ge 1) "frames=$frames"
  Check 'cost: every line parses' (@($objs | Where-Object { $_.type -eq 'PARSE_FAIL' }).Count -eq 0)
  Stop-Sensor $run
}

function Wait-TutorWatch($run, [bool]$active, [int]$timeoutMs = 8000) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $hit = @(Read-JsonLines $run.Out | Where-Object { $_.type -eq 'tutor-watch' -and $_.active -eq $active })
    if ($hit.Count -ge 1) { return $hit[-1] }
    if ($run.Process.HasExited) { return $null }
    Start-Sleep -Milliseconds 150
  }
  return $null
}

# ---------------------------------------------------------------------------
# stage 6 - tutor click hook is installed only while tutoring, and frames stay in memory
# ---------------------------------------------------------------------------
function Stage-TutorWatch {
  Info '=== Stage 6: tutor click hook ==='
  $dir = Join-Path $WorkDir 'tutor-watch'
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  $run = Start-Sensor $dir $Hotkey $IntervalMs
  $ready = Wait-Ready $run
  Check 'tutor: ready' ($null -ne $ready)
  $framesBefore = 0
  if (Test-Path $run.Frames) { $framesBefore = @(Get-ChildItem $run.Frames -Filter '*.jpg').Count }
  Set-Control $dir @{
    paused = $false; capture = $true; ocr = $true; clipboard = $false; stop = $false
    tutorId = 'tutor-test'; tutorOverlayPid = 0
  }
  $on = Wait-TutorWatch $run $true
  Check 'tutor: click hook installed' ($null -ne $on -and $on.clickHook -eq $true) ("hook=$($on.clickHook)")
  Check 'tutor: keyboard hook installed' ($null -ne $on -and $on.keyHook -eq $true) ("keyHook=$($on.keyHook)")
  $sawTutor = $false
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 8000) {
    $hit = @(Read-JsonLines $run.Out | Where-Object { $_.tutorId -eq 'tutor-test' -and ($_.type -eq 'sample' -or $_.type -eq 'window' -or $_.type -eq 'click') })
    if ($hit.Count -ge 1) { $sawTutor = $true; break }
    Start-Sleep -Milliseconds 200
  }
  Check 'tutor: window or fullscreen sample emitted' $sawTutor
  $framesAfter = 0
  if (Test-Path $run.Frames) { $framesAfter = @(Get-ChildItem $run.Frames -Filter '*.jpg').Count }
  Check 'tutor: fullscreen frames are not written to disk' ($framesAfter -eq $framesBefore) "before=$framesBefore after=$framesAfter"
  Set-Control $dir @{
    paused = $false; capture = $true; ocr = $true; clipboard = $false; stop = $false
    tutorId = ''; tutorOverlayPid = 0
  }
  $off = Wait-TutorWatch $run $false
  Check 'tutor: click hook uninstalled' ($null -ne $off -and $off.clickHook -eq $false)
  Check 'tutor: keyboard hook uninstalled' ($null -ne $off -and $off.keyHook -eq $false)
  Stop-Sensor $run
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if (-not (Test-Path $WorkDir)) { [void][System.IO.Directory]::CreateDirectory($WorkDir) }
Info ('sensor = ' + $SensorPath)
Info ('work   = ' + $WorkDir)
Info ('hotkey = ' + $Hotkey + '  interval=' + $IntervalMs + 'ms')

try {
  if ($Stage -eq 0 -or $Stage -eq 1) { [void](Stage-SelfTest) }
  if ($Stage -eq 0 -or $Stage -eq 2) { [void](Stage-Live) }
  if ($Stage -eq 0 -or $Stage -eq 3) { [void](Stage-Hotkey) }
  if ($Stage -eq 0 -or $Stage -eq 4) { [void](Stage-Control) }
  if ($Stage -eq 0 -or $Stage -eq 5) { [void](Stage-Cost) }
  if ($Stage -eq 0 -or $Stage -eq 6) { [void](Stage-TutorWatch) }
} catch {
  Write-Host ('HARNESS ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  $script:Fail++
}

Info ("=== {0} passed, {1} failed ===" -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0
