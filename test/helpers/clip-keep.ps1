param([string]$Action, [string]$Dir, [string]$Marker = '')
# Save / restore the clipboard around a runtime test, so the test does not leave its own data in the user's clipboard.
#   save    -> put the current image (PNG) and text into $Dir (UTF-8 files), report which existed
#   restore -> put them back, but ONLY if the clipboard still holds what the test wrote (text equals one of the
#              comma-separated -Marker values, or the image is the test's 1x1 pixel). If the user copied something
#              else in the meantime, nothing is touched.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as GBK and non-ASCII text breaks the parser.
# No clipboard content is printed.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$png = Join-Path $Dir 'clip.png'
$txt = Join-Path $Dir 'clip.txt'
if ($Action -eq 'save') {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($img) { $img.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose() }
  if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    [System.IO.File]::WriteAllText($txt, [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding($false)))
  }
  'saved: image=' + (Test-Path $png) + ' text=' + (Test-Path $txt)
} elseif ($Action -eq 'restore') {
  $ours = $false
  $markers = $Marker.Split(',') | Where-Object { $_ }
  if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    $cur = [System.Windows.Forms.Clipboard]::GetText()
    $ours = [bool]($markers | Where-Object { $_ -eq $cur })
  }
  if (-not $ours) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img) { $ours = ($img.Width -le 1 -and $img.Height -le 1); $img.Dispose() }
  }
  if (-not $ours) { 'not restored: clipboard no longer holds test data'; exit 0 }
  if (-not (Test-Path $png) -and -not (Test-Path $txt)) { 'nothing was saved'; exit 0 }
  $d = New-Object -TypeName System.Windows.Forms.DataObject
  if (Test-Path $png) { $d.SetImage([System.Drawing.Image]::FromFile($png)) }
  if (Test-Path $txt) { $d.SetText([System.IO.File]::ReadAllText($txt, [System.Text.Encoding]::UTF8)) }
  [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)
  'restored'
} else { 'unknown action'; exit 1 }
