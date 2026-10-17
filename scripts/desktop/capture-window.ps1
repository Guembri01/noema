# Capture the running Noema desktop window to a PNG, so "does the app actually
# render" can be answered by looking at it rather than inferring from HTTP.
#
# Two strategies, because WebView2 composes through DWM:
#   1. PrintWindow(PW_RENDERFULLCONTENT) — works for most DWM-composed windows;
#   2. bring the window to the foreground and grab the screen region it occupies.
# A blank/black result from (1) is detected (near-uniform pixels) and (2) is used.
param(
    [string]$OutDir = "$env:TEMP\noema-shots",
    [int]$WaitSeconds = 60
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-NoemaWindow {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process noema-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.MainWindowHandle -ne 0) { return $proc }
        Start-Sleep -Milliseconds 800
    }
    return $null
}

function Test-Blank([System.Drawing.Bitmap]$bmp) {
    $seen = @{}
    for ($y = 0; $y -lt $bmp.Height; $y += 17) {
        for ($x = 0; $x -lt $bmp.Width; $x += 17) {
            $c = $bmp.GetPixel($x, $y)
            $key = "$($c.R),$($c.G),$($c.B)"
            $seen[$key] = 1
            if ($seen.Count -gt 6) { return $false }
        }
    }
    return $true
}

$proc = Get-NoemaWindow
if (-not $proc) { Write-Output "NO WINDOW: noema-desktop did not open a window"; exit 1 }
Write-Output "window handle: $($proc.MainWindowHandle)  title: '$($proc.MainWindowTitle)'"

# Give the webview time to paint the workspace.
Start-Sleep -Seconds 8

$rect = New-Object Win+RECT
[void][Win]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Output "window rect: ${w}x${h} at $($rect.Left),$($rect.Top)"

$target = Join-Path $OutDir "noema-window.png"

# Strategy 1: PrintWindow with PW_RENDERFULLCONTENT.
$bmp = New-Object System.Drawing.Bitmap $w, $h
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
$ok = [Win]::PrintWindow($proc.MainWindowHandle, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$blank = Test-Blank $bmp
Write-Output "PrintWindow ok=$ok blank=$blank -> $target"
$bmp.Dispose()

# Strategy 2: foreground + screen grab (only if PrintWindow gave nothing).
if ($blank -or -not $ok) {
    [void][Win]::ShowWindow($proc.MainWindowHandle, 9)   # SW_RESTORE
    [void][Win]::SetForegroundWindow($proc.MainWindowHandle)
    Start-Sleep -Seconds 2
    $rect2 = New-Object Win+RECT
    [void][Win]::GetWindowRect($proc.MainWindowHandle, [ref]$rect2)
    $w2 = $rect2.Right - $rect2.Left
    $h2 = $rect2.Bottom - $rect2.Top
    $bmp2 = New-Object System.Drawing.Bitmap $w2, $h2
    $gfx2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $gfx2.CopyFromScreen($rect2.Left, $rect2.Top, 0, 0, (New-Object System.Drawing.Size $w2, $h2))
    $gfx2.Dispose()
    $target2 = Join-Path $OutDir "noema-screen.png"
    $bmp2.Save($target2, [System.Drawing.Imaging.ImageFormat]::Png)
    $blank2 = Test-Blank $bmp2
    Write-Output "screengrab blank=$blank2 -> $target2"
    $bmp2.Dispose()
}
