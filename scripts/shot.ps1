param([string]$Out = (Join-Path $PSScriptRoot "..\_tmp\shot.png"))
# 临时产物统一落 _tmp/（已 gitignore），目录不存在则创建
$OutDir = Split-Path $Out -Parent
if ($OutDir -and -not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PW2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (IsWindowVisible(h)) {
        StringBuilder t = new StringBuilder(256);
        GetWindowText(h, t, 256);
        if (t.ToString().Contains(needle)) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$hwnd = [PW2]::Find("WorkspaceCleaner")
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "WINDOW NOT FOUND"; exit 1 }
[PW2]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300
$rect = New-Object PW2+RECT
[PW2]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[PW2]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $Out"
