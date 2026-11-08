# SlopMaxxer tray companion (Windows only, spawned by src/tray.mjs).
# Shows a NotifyIcon; clicking it pops a small borderless window with the dashboard's
# verdict (Speed up. / Slow down. / ...) and the remaining
# allowance per account, styled after the dashboard's phosphor theme. Data comes
# from the local /api/slop endpoint; this script never sees a credential.
param(
  [string]$ApiUrl = 'http://127.0.0.1:4747/api/slop',
  [string]$DashboardUrl = 'http://127.0.0.1:4747',
  [int]$ParentPid = 0,
  [string]$IconPath = '',
  [string]$RenderTo = '',
  [int]$RenderAfterMs = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function C([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
$script:cBg = C '#0B1410'; $script:cBorder = C '#1A3A2B'; $script:cTxt = C '#B8F5CF'
$script:cMuted = C '#78B892'; $script:cFaint = C '#1F4231'; $script:cAccent = C '#3DFF8C'
$script:cRed = C '#FF5C5C'; $script:cWarn = C '#FFE066'; $script:cPink = C '#FF6BB5'
# Verdict tones from the dashboard's phosphor tokens (--pink/--ok/--warn/--red/--muted).
$script:toneColor = @{ pink = $script:cPink; ok = $script:cAccent; warn = $script:cWarn; red = $script:cRed; muted = $script:cMuted }
$script:providerColor = @{ claude = (C '#FFB86B'); codex = (C '#6BE3FF'); muse = (C '#C792FF') }
$script:dot = [char]0x00B7
$script:arrowR = [char]0x2192
$script:fontTitle = New-Object System.Drawing.Font('Consolas', 10, [System.Drawing.FontStyle]::Bold)
$script:fontVerdict = New-Object System.Drawing.Font('Consolas', 14, [System.Drawing.FontStyle]::Bold)
# The dashboard's triangles stand ~0.9x the verdict cap height; at the word's own size
# Consolas' fallback triangles only reach ~0.7x, so the arrow gets a larger font.
$script:fontVerdictArrow = New-Object System.Drawing.Font('Consolas', 18, [System.Drawing.FontStyle]::Bold)
$script:fontHead = New-Object System.Drawing.Font('Consolas', 9, [System.Drawing.FontStyle]::Bold)
$script:fontBody = New-Object System.Drawing.Font('Consolas', 8.5)
$script:fontSmall = New-Object System.Drawing.Font('Consolas', 8)
$script:lastData = $null
$script:lastFetch = [DateTime]::MinValue
$script:lastHover = [DateTime]::MinValue
$script:downPos = $null
$script:downAt = [DateTime]::MinValue
$script:notifyIcon = $null
$script:width = 400
$script:verdictPanel = $null
$script:verdictArrowText = ''
$script:verdictWordText = ''
$script:verdictTone = $null
$script:nodPx = 0
$script:animStart = [DateTime]::MinValue
# Windows' "show animations" toggle is the tray's prefers-reduced-motion: off means no nod.
$script:reducedMotion = $false
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SlopNative { [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint p, ref bool v, uint w); }' -ErrorAction Stop
  $clientAnim = $true
  if ([SlopNative]::SystemParametersInfo(0x1042, 0, [ref]$clientAnim, 0)) { $script:reducedMotion = -not $clientAnim }
} catch { }

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.BackColor = $script:cBorder
$form.Width = $script:width
$form.Height = 120

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = $script:cBg
$panel.Margin = New-Object System.Windows.Forms.Padding(1)
$panel.Padding = New-Object System.Windows.Forms.Padding(1)
$form.Controls.Add($panel)
# 1px border effect: shrink the panel inside the form by the form padding.
$form.Padding = New-Object System.Windows.Forms.Padding(1)

# Like the dashboard's urgent verdict: the arrow nods on a 1.5s cycle, rising 2px
# (the dashboard's 5px at ~60px verdict text, scaled to tray size). No fade.
$script:animTimer = New-Object System.Windows.Forms.Timer
$script:animTimer.Interval = 40
$script:animTimer.Add_Tick({
  if (-not $form.Visible -or -not $script:verdictPanel) { $script:animTimer.Stop(); return }
  $phase = (((Get-Date) - $script:animStart).TotalMilliseconds % 1500) / 1500
  $lift = [math]::Sin([math]::PI * $phase)
  $px = [int][math]::Round(2 * $lift)
  if ($px -ne $script:nodPx) { $script:nodPx = $px; $script:verdictPanel.Invalidate() }
})

function Start-VerdictNod {
  if ($script:reducedMotion -or -not $script:verdictPanel) { return }
  if (-not $script:animTimer.Enabled) { $script:animStart = Get-Date; $script:animTimer.Start() }
}

# The verdict headline is owner-drawn in one panel: measuring and drawing with the
# same GDI+ calls keeps the arrow/word gap exact at any display scaling, where two
# Labels placed by measured widths overlapped. Placement uses glyph ink bounds
# (GraphicsPath), baselines aligned, with a fixed ink gap between arrow and word.
function Text-InkBounds([string]$text, $font, [double]$dpi, $fmt) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  try {
    $path.AddString($text, $font.FontFamily, [int]$font.Style, [float]($font.SizeInPoints * $dpi / 72), (New-Object System.Drawing.PointF(0, 0)), $fmt)
    return $path.GetBounds()
  } finally { $path.Dispose() }
}

function Draw-VerdictHeadline($g, $client) {
  if (-not $script:verdictWordText) { return }
  $scale = $g.DpiX / 96.0
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  $brush = New-Object System.Drawing.SolidBrush($script:verdictTone)
  try {
    $aFont = $script:fontVerdictArrow; $wFont = $script:fontVerdict
    $ab = Text-InkBounds $script:verdictArrowText $aFont $g.DpiY $fmt
    $wb = Text-InkBounds $script:verdictWordText $wFont $g.DpiY $fmt
    $aAsc = ($aFont.SizeInPoints * $g.DpiY / 72) * $aFont.FontFamily.GetCellAscent($aFont.Style) / $aFont.FontFamily.GetEmHeight($aFont.Style)
    $wAsc = ($wFont.SizeInPoints * $g.DpiY / 72) * $wFont.FontFamily.GetCellAscent($wFont.Style) / $wFont.FontFamily.GetEmHeight($wFont.Style)
    $base = $client.Height - 6 * $scale
    $ax = 5 * $scale - $ab.X
    $wx = $ax + $ab.Right + 5 * $scale - $wb.X
    $g.DrawString($script:verdictArrowText, $aFont, $brush, [float]$ax, [float]($base - $aAsc - $script:nodPx * $scale), $fmt)
    $g.DrawString($script:verdictWordText, $wFont, $brush, [float]$wx, [float]($base - $wAsc), $fmt)
  } finally { $brush.Dispose(); $fmt.Dispose() }
}

function Add-Label([string]$text, $font, $color, [int]$x, [int]$y, [int]$w, [int]$h = 15) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Font = $font; $l.ForeColor = $color; $l.BackColor = $script:cBg
  $l.AutoSize = $false; $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($w, $h)
  $panel.Controls.Add($l)
  return $l
}

# A label as tall as its wrapped text needs (the verdict's "why" runs long).
function Add-WrappedLabel([string]$text, $font, $color, [int]$x, [int]$y, [int]$w) {
  $flags = [System.Windows.Forms.TextFormatFlags]::WordBreak
  $sz = [System.Windows.Forms.TextRenderer]::MeasureText($text, $font, (New-Object System.Drawing.Size($w, 1000)), $flags)
  return Add-Label $text $font $color $x $y $w ([math]::Max(15, $sz.Height))
}

function Text-Width([string]$text, $font) {
  return [System.Windows.Forms.TextRenderer]::MeasureText($text, $font).Width
}

function Format-Reset($resetsAt) {
  if (-not $resetsAt) { return 'not started' }
  try { $mins = ([DateTime]::Parse($resetsAt).ToLocalTime() - (Get-Date)).TotalMinutes } catch { return '' }
  if ($mins -le 0) { return 'reset due' }
  if ($mins -ge 1440) { return ('resets {0}d {1}h' -f [math]::Floor($mins / 1440), [math]::Floor(($mins % 1440) / 60)) }
  if ($mins -ge 60) { return ('resets {0}h {1}m' -f [math]::Floor($mins / 60), [math]::Floor($mins % 60)) }
  return ('resets {0}m' -f [math]::Ceiling($mins))
}

function Build-Popup {
  $panel.Controls.Clear()
  $script:verdictPanel = $null; $script:nodPx = 0
  $y = 8
  $null = Add-Label '> slopmaxxer' $script:fontTitle $script:cAccent 12 $y 200
  $stamp = if ($script:lastFetch -ne [DateTime]::MinValue) { $script:lastFetch.ToString('HH:mm:ss') } else { '' }
  $t = Add-Label $stamp $script:fontSmall $script:cMuted 290 $y 96
  $t.TextAlign = 'MiddleRight'
  $y += 24

  # The dashboard's nagging, ready-made by the server (guidance in /api/slop):
  # arrow + word in the verdict tone, the why underneath, then where to go next.
  $g = if ($script:lastData) { $script:lastData.guidance } else { $null }
  if ($g -and $g.verdict -and $g.verdict.word) {
    $v = $g.verdict
    $tone = $script:toneColor[[string]$v.tone]; if (-not $tone) { $tone = $script:cTxt }
    $null = Add-Label '> slop verdict' $script:fontSmall $script:cMuted 12 $y 376; $y += 16
    $script:verdictArrowText = [string]$v.arrow; $script:verdictWordText = [string]$v.word; $script:verdictTone = $tone
    $head = New-Object System.Windows.Forms.Panel
    $head.BackColor = $script:cBg
    $head.Location = New-Object System.Drawing.Point(12, $y)
    $head.Size = New-Object System.Drawing.Size(376, 26)
    try { $head.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance, NonPublic').SetValue($head, $true) } catch { }
    $head.Add_Paint({ param($sender, $e) Draw-VerdictHeadline $e.Graphics $sender.ClientSize })
    $panel.Controls.Add($head)
    if ($g.next -and $g.next.status -eq 'expiring') {
      $script:verdictPanel = $head
      Start-VerdictNod
    }
    $y += 28
    if ($v.why) { $why = Add-WrappedLabel ([string]$v.why) $script:fontSmall $script:cTxt 12 $y 376; $y += $why.Height + 4 }
    if ($g.next) {
      $lead = "next task $script:arrowR "
      $null = Add-Label $lead $script:fontHead $script:cMuted 12 $y 376
      $nc = $script:providerColor[[string]$g.next.provider]; if (-not $nc) { $nc = $script:cTxt }
      $nx = 12 + (Text-Width $lead $script:fontHead)
      $null = Add-Label ("{0} {1}" -f $g.next.slug, $g.next.label) $script:fontHead $nc $nx $y (388 - $nx)
      $y += 18
    }
    $rule = New-Object System.Windows.Forms.Panel
    $rule.BackColor = $script:cFaint
    $rule.Location = New-Object System.Drawing.Point(12, $y)
    $rule.Size = New-Object System.Drawing.Size(376, 1)
    $panel.Controls.Add($rule)
    $y += 9
  }

  $accounts = @()
  if ($script:lastData -and $script:lastData.accounts) { $accounts = @($script:lastData.accounts) }
  if (-not $script:lastData) {
    $null = Add-Label 'SlopMaxxer is not reachable.' $script:fontBody $script:cRed 12 $y 330; $y += 18
  } elseif ($accounts.Count -eq 0) {
    $null = Add-Label 'No logins found yet.' $script:fontBody $script:cMuted 12 $y 330; $y += 18
  }

  foreach ($a in $accounts) {
    $color = $script:providerColor[[string]$a.provider]
    if (-not $color) { $color = $script:cTxt }
    $null = Add-Label ("{0}/{1} {2}" -f $a.provider, $a.planSlug, $a.label) $script:fontHead $color 12 $y 336
    $y += 17
    if ($a.error) {
      $err = [string]$a.error; if ($err.Length -gt 52) { $err = $err.Substring(0, 52) }
      $null = Add-Label $err $script:fontSmall $script:cRed 12 $y 336; $y += 15
    } elseif ($a.stale) {
      $null = Add-Label 'stale - last known values' $script:fontSmall $script:cMuted 12 $y 336; $y += 15
    }
    $wins = @($a.windows | Where-Object { $_.kind -eq 'session' -or $_.kind -eq 'weekly' })
    if ($wins.Count -eq 0) {
      # Demo/reference snapshots carry fiveHour/weekly aliases instead of a windows array.
      foreach ($pair in @(@($a.fiveHour, '5-hour'), @($a.weekly, 'Weekly'))) {
        $w0 = $pair[0]
        if ($w0) {
          $act = $w0.active; if ($null -eq $act) { $act = [bool]$w0.resetsAt }
          $wins += [pscustomobject]@{ label = $(if ($w0.label) { $w0.label } else { $pair[1] }); usedPct = $w0.usedPct; resetsAt = $w0.resetsAt; active = $act }
        }
      }
    }
    if ($wins.Count -eq 0 -and -not $a.error) {
      $null = Add-Label 'no limits reported' $script:fontSmall $script:cMuted 12 $y 336; $y += 15
    }
    foreach ($w in $wins) {
      $null = Add-Label ([string]$w.label) $script:fontSmall $script:cMuted 12 ($y + 1) 58
      $track = New-Object System.Windows.Forms.Panel
      $track.BackColor = $script:cFaint
      $track.Location = New-Object System.Drawing.Point(72, ($y + 3))
      $track.Size = New-Object System.Drawing.Size(112, 9)
      $panel.Controls.Add($track)
      $textColor = $script:cTxt
      if ($null -ne $w.usedPct) {
        $left = [math]::Max(0, [math]::Min(100, 100 - [double]$w.usedPct))
        $fill = New-Object System.Windows.Forms.Panel
        $fill.BackColor = $color
        $fill.Location = New-Object System.Drawing.Point(0, 0)
        $fill.Size = New-Object System.Drawing.Size([int][math]::Round(112 * $left / 100), 9)
        $track.Controls.Add($fill)
        if ($left -le 0) { $textColor = $script:cRed } elseif ($left -le 10) { $textColor = $script:cWarn }
        $when = Format-Reset $w.resetsAt
        $txt = if (-not $w.active -and [double]$w.usedPct -eq 0) { '100% left, not started' }
               else { "{0}% left {1} {2}" -f [math]::Round($left), $script:dot, $when }
      } else { $txt = 'unknown' }
      $null = Add-Label $txt $script:fontSmall $textColor 190 ($y + 1) 202
      $y += 16
    }
    $y += 7
  }

  $foot = Add-Label 'open dashboard: click here or double-click icon' $script:fontSmall $script:cMuted 12 $y 376
  $foot.Cursor = [System.Windows.Forms.Cursors]::Hand
  $foot.Add_Click({ Start-Process $DashboardUrl })
  $y += 22
  $form.Height = $y
}

function Place-Popup {
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 8), ($area.Bottom - $form.Height - 8))
}

# The hover tooltip nags too, once a fetch has happened. NotifyIcon text caps at 63 chars.
function Update-Tooltip {
  if (-not $script:notifyIcon) { return }
  $text = 'SlopMaxxer'
  $v = if ($script:lastData -and $script:lastData.guidance) { $script:lastData.guidance.verdict } else { $null }
  if ($v -and $v.word) { $text = "SlopMaxxer $script:dot $($v.arrow) $($v.word)" }
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  try { $script:notifyIcon.Text = $text } catch { }
}

function Fetch-Data {
  try {
    $script:lastData = Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 20
    $script:lastFetch = Get-Date
  } catch { $script:lastData = $null }
  Update-Tooltip
}

function Show-Popup {
  $script:lastHover = Get-Date
  Build-Popup; Place-Popup
  if (-not $form.Visible) { $form.Show(); $form.Update() }
  Start-VerdictNod
  if (((Get-Date) - $script:lastFetch).TotalSeconds -gt 20) {
    Fetch-Data; Build-Popup; Place-Popup
  }
}

if ($RenderTo) {
  Fetch-Data; Build-Popup; Place-Popup
  $form.Show(); $form.Update()
  if ($RenderAfterMs -gt 0) {
    $until = (Get-Date).AddMilliseconds($RenderAfterMs)
    while ((Get-Date) -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
  }
  $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
  $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
  $bmp.Save($RenderTo, [System.Drawing.Imaging.ImageFormat]::Png)
  return
}

$notify = New-Object System.Windows.Forms.NotifyIcon
if ($IconPath -and (Test-Path $IconPath)) { $notify.Icon = New-Object System.Drawing.Icon($IconPath) }
else { $notify.Icon = [System.Drawing.SystemIcons]::Application }
$notify.Text = 'SlopMaxxer'
$notify.Visible = $true
$script:notifyIcon = $notify

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.BackColor = $script:cBg; $menu.ForeColor = $script:cTxt; $menu.Font = $script:fontBody
$itemOpen = $menu.Items.Add('Open dashboard')
$itemRefresh = $menu.Items.Add('Refresh now')
$itemQuit = $menu.Items.Add('Quit SlopMaxxer')
foreach ($i in $menu.Items) { $i.BackColor = $script:cBg; $i.ForeColor = $script:cTxt }
$notify.ContextMenuStrip = $menu

function Exit-Tray {
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$itemOpen.Add_Click({ Start-Process $DashboardUrl })
$itemRefresh.Add_Click({ Fetch-Data; Show-Popup })
$itemQuit.Add_Click({
  if ($ParentPid -gt 0) { Stop-Process -Id $ParentPid -ErrorAction SilentlyContinue }
  Exit-Tray
})

# Click toggles the popup, but only for a true click: press and release in (almost)
# the same spot. Dragging the icon out of the overflow area moves the pointer while
# held, so its release is ignored and pinning stays possible.
function Toggle-Popup {
  if ($form.Visible) { $form.Hide() } else { Show-Popup }
}

$notify.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:downPos = [System.Windows.Forms.Cursor]::Position
    $script:downAt = Get-Date
  }
})
$notify.Add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:downPos) {
    $up = [System.Windows.Forms.Cursor]::Position
    $dx = $up.X - $script:downPos.X; $dy = $up.Y - $script:downPos.Y
    $moved = [math]::Sqrt($dx * $dx + $dy * $dy)
    $heldMs = ((Get-Date) - $script:downAt).TotalMilliseconds
    $script:downPos = $null
    if ($moved -le 8 -and $heldMs -le 1000) { Toggle-Popup }
  }
})
$notify.Add_MouseDoubleClick({
  Start-Process $DashboardUrl
  $form.Hide()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Exit-Tray; return }
  if ($form.Visible) {
    $pos = [System.Windows.Forms.Cursor]::Position
    $b = $form.Bounds; $b.Inflate(28, 28)
    if ($b.Contains($pos)) { $script:lastHover = Get-Date }
    elseif (((Get-Date) - $script:lastHover).TotalMilliseconds -gt 1400) { $form.Hide() }
    elseif (((Get-Date) - $script:lastFetch).TotalSeconds -gt 30) { Fetch-Data; Build-Popup; Place-Popup }
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
