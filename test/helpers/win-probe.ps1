# This file MUST stay UTF-8 with BOM: Windows PowerShell 5.1 reads BOM-less scripts as ANSI (GBK), and a lone
# trailing byte of a Chinese character then swallows the following line break, breaking the param() block below.
# 对指定窗口做命中测试(WM_NCHITTEST)、按需截图与调整大小。供 test/titlebar-runtime.js 调用,验证无边框窗口。
# -Points: "x,y;x,y" 以 CSS 像素表示、相对页面视口左上角;输出 "x,y=<命中码>"
#   命中码:1=页面内容 2=标题栏(可拖拽区) 8=最小化 9=最大化 20=关闭
# -Shot:  保存 PNG 的路径(可空)。只截这个窗口自身(PrintWindow),不会截到别的窗口
# -Size:  "w,h" 以 CSS 像素表示的外框尺寸(可空),用于验证窄窗口下的布局
# 只发窗口消息、不抢前台、不移动鼠标,不干扰用户正在操作的其他窗口。
param(
  [Parameter(Mandatory=$true)][int]$Hwnd,
  [string]$Points = '',
  [string]$Shot = '',
  [string]$Size = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int L; public int T; public int R; public int B; }
}
'@
# 以物理像素工作:缩放比例、窗口坐标、截图尺寸三者一致
[W]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = [IntPtr]$Hwnd
$scale = [W]::GetDpiForWindow($h) / 96.0

if ($Size) {
  $wh = $Size.Split(',')
  # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE:只改大小,不移动、不抢前台
  [W]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, [int]([double]$wh[0] * $scale), [int]([double]$wh[1] * $scale), 0x0016) | Out-Null
  Start-Sleep -Milliseconds 500
}

$origin = New-Object 'W+POINT'
[W]::ClientToScreen($h, [ref]$origin) | Out-Null

foreach ($p in $Points.Split(';')) {
  if (-not $p) { continue }
  $xy = $p.Split(',')
  $x = $origin.X + [int]([double]$xy[0] * $scale)
  $y = $origin.Y + [int]([double]$xy[1] * $scale)
  $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
  $hit = [W]::SendMessage($h, 0x0084, [IntPtr]::Zero, $lp)
  Write-Output ("{0},{1}={2}" -f $xy[0], $xy[1], $hit.ToInt64())
}

$r = New-Object 'W+RECT'
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L
$hgt = $r.B - $r.T

if ($Shot) {
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [W]::PrintWindow($h, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc)
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}
Write-Output ("RECT {0}x{1} origin {2},{3} scale {4}" -f $w, $hgt, $origin.X, $origin.Y, $scale)
