// computer-use 的 Windows 原生能力层:两段内嵌 PowerShell 脚本。
//
// 为什么内嵌成字符串而不是放 .ps1 资源文件:
// - 桌面端只把 server/ 源码与 node_modules 打进安装包(见 scripts/build.mjs),新增资源目录
//   还要同步改打包脚本,容易漏;
// - 内嵌后脚本随 server 代码一起走,开发(npm run dev)与打包运行都只有一条路径;
// - 运行时写进系统临时目录执行,不依赖 Tauri、不依赖安装目录可写。
//
// 两个进程各司其职:
// - WORKER_PS1:常驻进程,stdin 收 JSON 行命令、stdout 回 JSON 行结果。常驻是因为
//   Add-Type 编译 Win32 声明要 ~1s,每次动作现起一个进程会让点击延迟到不可用。
// - OVERLAY_PS1:独立进程,在每个显示器上画一圈高亮边框 + 顶部「AI 操控中」悬浮条
//   (带「停止」按钮)。停止按钮回调本机 HTTP 急停接口;同时轮询 /api/health,
//   后端一旦不在就自行退出,避免留下孤儿窗口。
export const WORKER_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)] public struct TFPoint { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct TFRect { public int Left; public int Top; public int Right; public int Bottom; }

public class TFNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out TFPoint p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out TFRect lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  // 把窗口强制切到前台。直接用 SetForegroundWindow 经常无效:Windows 有"前台锁定",
  // 后台进程不能随便抢前台(实测:调完 activate 前台窗口仍是别的应用,后续 OCR/截图全抓错)。
  // 这里用 AttachThreadInput 把当前线程挂到前台线程的输入队列上,再 SetForegroundWindow,
  // 最后用 SwitchToThisWindow 兜底。返回是否真的成功。
  public static bool ForceForeground(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = fg == IntPtr.Zero ? 0u : GetWindowThreadProcessId(fg, out dummy);
    uint cur = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != cur) attached = AttachThreadInput(cur, fgThread, true);
    try {
      BringWindowToTop(h);
      // TOPMOST -> NOTOPMOST:把窗口提到最前再放回去,常能突破前台锁定
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
      SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
      SetForegroundWindow(h);
      SetActiveWindow(h);
    } finally {
      if (attached) AttachThreadInput(cur, fgThread, false);
    }
    if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
    return GetForegroundWindow() == h;
  }
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int w, int h, IntPtr hdcSrc, int xSrc, int ySrc, int rop);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("wtsapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool WTSQuerySessionInformationW(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytesReturned);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
  // WTSINFOEXW 的内存布局(不要用 PtrToStructure 定义结构体,联合体对齐很容易算错):
  //   [0] ULONG Level
  //   [4] 填充(因为 WTSINFOEX_LEVEL_W 联合体里含 8 字节对齐成员,Data 被对齐到偏移 8)
  //   [8] ULONG SessionId
  //   [12] WTS_CONNECTSTATE_CLASS SessionState
  //   [16] LONG SessionFlags   <- 0=已锁定, 1=未锁定, -1(0xFFFFFFFF)=未知
  // 用显式字节偏移读,并对 Level / SessionId 做校验:布局不符就返回 -1(未知),
  // 由调用方按"未锁定"处理——误封会让功能完全不可用,漏报最多白点几下,方向必须偏后者。
  public static int SessionFlags(int expectedSessionId) {
    IntPtr buf; int n;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, -1, 25, out buf, out n)) return -1;
    try {
      if (n < 20) return -1;
      if (Marshal.ReadInt32(buf, 0) != 1) return -1;
      if (expectedSessionId >= 0 && Marshal.ReadInt32(buf, 8) != expectedSessionId) return -1;
      return Marshal.ReadInt32(buf, 16);
    } finally { WTSFreeMemory(buf); }
  }
}
'@

# 必须在任何 Screen/Bitmap 查询之前调用:让进程按物理像素工作,
# 这样截图坐标与 SetCursorPos 坐标处于同一坐标系(否则高 DPI 下会整体偏移)。
[TFNative]::SetProcessDPIAware() | Out-Null

$MOUSEEVENTF_LEFTDOWN   = 0x0002
$MOUSEEVENTF_LEFTUP     = 0x0004
$MOUSEEVENTF_RIGHTDOWN  = 0x0008
$MOUSEEVENTF_RIGHTUP    = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP   = 0x0040
$MOUSEEVENTF_WHEEL      = 0x0800
$KEYEVENTF_KEYUP        = 0x0002
$KEYEVENTF_UNICODE      = 0x0004

$VK = @{
  'enter' = 0x0D; 'return' = 0x0D; 'esc' = 0x1B; 'escape' = 0x1B; 'tab' = 0x09
  'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
  'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91; 'printscreen' = 0x2C
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
  '-' = 0xBD; '=' = 0xBB; '[' = 0xDB; ']' = 0xDD; '\' = 0xDC; ';' = 0xBA
  "'" = 0xDE; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF
}
# 反引号/波浪键:字面反引号会破坏本文件的模板字符串,改用字符码注册
$VK[[string][char]0x60] = 0xC0

function Get-VirtualBounds {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return [ordered]@{ x = $vs.X; y = $vs.Y; w = $vs.Width; h = $vs.Height }
}

function Get-Monitors {
  $out = @()
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $out += [ordered]@{
      index = $i; name = $s.DeviceName; primary = [bool]$s.Primary
      x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height
    }
    $i++
  }
  return ,$out
}

function Get-Cursor {
  $p = New-Object TFPoint
  [TFNative]::GetCursorPos([ref]$p) | Out-Null
  return [ordered]@{ x = $p.X; y = $p.Y }
}

function Get-Foreground {
  $h = [TFNative]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [TFNative]::GetWindowTextW($h, $sb, 512) | Out-Null
  $r = New-Object TFRect
  [TFNative]::GetWindowRect($h, [ref]$r) | Out-Null
  $procId = 0
  [TFNative]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  return [ordered]@{
    title = $sb.ToString(); process = $name
    x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top)
  }
}

# 会话是否锁屏:锁屏时屏幕帧不再更新(截到的永远是锁屏画面),键鼠输入也到不了目标应用。
# 这是截图式 computer-use 的固有限制,必须让模型知道"现在操作无效",而不是对着锁屏瞎点。
# 注意 WTSINFOEX 的 SessionFlags 语义反直觉:0=已锁定,1=未锁定(未知=-1)。
# 读不到/布局不符/会话号对不上时一律返回"未锁定"(宁可漏报,也不要误封把功能整个锁死)。
function Test-Locked {
  try {
    $sid = (Get-Process -Id $PID).SessionId
    $flags = [TFNative]::SessionFlags([int]$sid)
    if ($flags -lt 0) { return $false }
    return ($flags -eq 0)
  } catch { return $false }
}

# ---------------- UI Automation(元素级操作,点得准的根本手段)----------------
# 为什么要有这一层:靠"看图估坐标"点击,误差必然存在(整屏拼图缩放后 1px 误差会被放大
# 2~3 倍)。UIA 能按控件名/类型直接拿到元素并调用其动作(Invoke/Value/Select…),
# 完全不需要坐标,而且返回的是**文字结构**——不支持视觉的模型照样能用。
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PATS = @(
  @{ n = 'Invoke'; p = [System.Windows.Automation.InvokePattern]::Pattern },
  @{ n = 'Value'; p = [System.Windows.Automation.ValuePattern]::Pattern },
  @{ n = 'SelectionItem'; p = [System.Windows.Automation.SelectionItemPattern]::Pattern },
  @{ n = 'Toggle'; p = [System.Windows.Automation.TogglePattern]::Pattern },
  @{ n = 'ExpandCollapse'; p = [System.Windows.Automation.ExpandCollapsePattern]::Pattern },
  @{ n = 'ScrollItem'; p = [System.Windows.Automation.ScrollItemPattern]::Pattern },
  @{ n = 'Text'; p = [System.Windows.Automation.TextPattern]::Pattern }
)

# 元素引用表:每次 uia_tree / uia_find 重建。ref 只在"最近一次结果"里有效,
# 拿到过期 ref 会被明确拒绝并提示重新获取,而不是点到一个已经消失的元素上。
$script:refs = @{}
$script:refSeq = 0

function Get-Patterns($e) {
  $kinds = @()
  foreach ($x in $PATS) {
    $o = $null
    try { if ($e.TryGetCurrentPattern($x.p, [ref]$o)) { $kinds += $x.n } } catch { }
  }
  return ,$kinds
}

function Test-Actionable($desc) {
  foreach ($k in $desc.patterns) {
    if ($k -eq 'Invoke' -or $k -eq 'Value' -or $k -eq 'SelectionItem' -or $k -eq 'Toggle' -or $k -eq 'ExpandCollapse') { return $true }
  }
  return $false
}

function Uia-Desc($e) {
  $r = $e.Current.BoundingRectangle
  $kinds = Get-Patterns $e
  return [ordered]@{
    name = [string]$e.Current.Name
    type = $e.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
    autoId = [string]$e.Current.AutomationId
    cls = [string]$e.Current.ClassName
    hwnd = [int64]$e.Current.NativeWindowHandle
    x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y)
    w = [int][Math]::Round($r.Width); h = [int][Math]::Round($r.Height)
    enabled = [bool]$e.Current.IsEnabled
    offscreen = [bool]$e.Current.IsOffscreen
    patterns = $kinds
  }
}

# 按 hwnd / pid / title 找最合适的顶层窗口(多个同名时取面积最大的那个)
function Find-RootWindow($sel) {
  $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $best = $null
  $bestArea = -1
  foreach ($w in $wins) {
    try {
      if ($sel.hwnd -and ([int64]$w.Current.NativeWindowHandle) -ne [int64]$sel.hwnd) { continue }
      if ($sel.pid -and $w.Current.ProcessId -ne [int]$sel.pid) { continue }
      if ($sel.title) {
        $t = [string]$w.Current.Name
        if (-not $t -or -not $t.ToLower().Contains(([string]$sel.title).ToLower())) { continue }
      }
      $r = $w.Current.BoundingRectangle
      $area = [int]$r.Width * [int]$r.Height
      if ($area -gt $bestArea) { $bestArea = $area; $best = $w }
    } catch { }
  }
  return $best
}

function Window-Selector($req) {
  $sel = @{}
  if ($req.hwnd) { $sel.hwnd = [int64]$req.hwnd }
  if ($req.pid) { $sel.pid = [int]$req.pid }
  if ($req.title) { $sel.title = [string]$req.title }
  return $sel
}

function Walk-Uia($e, $depth, $maxDepth, $maxNodes, $interactiveOnly) {
  if ($script:walkCount -ge $maxNodes) { return }
  $script:walkCount++
  $kids = $null
  try { $kids = $e.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { }
  $desc = Uia-Desc $e
  $desc['depth'] = $depth
  $actionable = Test-Actionable $desc
  $desc['actionable'] = $actionable
  $isLeaf = (-not $kids) -or ($kids.Count -eq 0)
  # 默认只回"可操作元素 + 有名字的叶子",否则一个浏览器窗口能吐出上万条匿名容器
  if ((-not $interactiveOnly) -or $actionable -or (($desc.name -ne '') -and $isLeaf)) {
    $script:refSeq++
    $desc['ref'] = 'e' + $script:refSeq
    $script:refs[$desc['ref']] = $e
    $script:walkOut += , $desc
  }
  if ($depth -ge $maxDepth -or (-not $kids)) { return }
  foreach ($k in $kids) { Walk-Uia $k ($depth + 1) $maxDepth $maxNodes $interactiveOnly }
}

function Invoke-UiaTree($req) {
  $sel = Window-Selector $req
  $root = $null
  if ($sel.Count -gt 0) { $root = Find-RootWindow $sel }
  if (-not $root) { $root = $AE::FromHandle([TFNative]::GetForegroundWindow()) }
  if (-not $root) { throw '未找到目标窗口(可先用 windows 操作列出当前窗口)' }
  $script:refs = @{}
  $script:refSeq = 0
  $script:walkOut = @()
  $script:walkCount = 0
  $maxDepth = 6; if ($req.max_depth) { $maxDepth = [Math]::Min(12, [int]$req.max_depth) }
  $maxNodes = 120; if ($req.max_nodes) { $maxNodes = [Math]::Min(400, [int]$req.max_nodes) }
  $interactiveOnly = ($req.interactive_only -ne $false)
  Walk-Uia $root 0 $maxDepth $maxNodes $interactiveOnly
  return [ordered]@{
    ok = $true; root = (Uia-Desc $root); nodes = $script:walkOut
    count = $script:walkOut.Count; truncated = ($script:walkCount -ge $maxNodes)
  }
}

function Invoke-UiaFind($req) {
  $sel = Window-Selector $req
  $root = $null
  if ($sel.Count -gt 0) { $root = Find-RootWindow $sel }
  if (-not $root) { $root = $AE::FromHandle([TFNative]::GetForegroundWindow()) }
  if (-not $root) { throw '未找到目标窗口' }
  $q = [string]$req.query
  if (-not $q) { throw 'find 需要 query(控件名/文本,子串匹配,忽略大小写)' }
  $needle = $q.ToLower()
  $limit = 30; if ($req.limit) { $limit = [Math]::Min(200, [int]$req.limit) }
  $script:refs = @{}
  $script:refSeq = 0
  $out = @()
  $all = $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    if ($out.Count -ge $limit) { break }
    $nm = ''
    try { $nm = [string]$e.Current.Name } catch { continue }
    if (-not $nm) { continue }
    if (-not $nm.ToLower().Contains($needle)) { continue }
    $d = Uia-Desc $e
    $d['actionable'] = Test-Actionable $d
    $script:refSeq++
    $d['ref'] = 'e' + $script:refSeq
    $script:refs[$d['ref']] = $e
    $out += , $d
  }
  return [ordered]@{ ok = $true; query = $q; matches = $out; count = $out.Count; scanned = $all.Count }
}

function Invoke-UiaAction($req) {
  $ref = [string]$req.ref
  if (-not $ref -or -not $script:refs.ContainsKey($ref)) {
    throw ('元素引用 ' + $ref + ' 不存在或已失效:请先调用 computer_ui 重新获取(ref 只在最近一次结果里有效)')
  }
  $e = $script:refs[$ref]
  $action = [string]$req.action
  $r = $e.Current.BoundingRectangle
  switch ($action) {
    'invoke' { ([System.Windows.Automation.InvokePattern]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() }
    'set_value' { ([System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue([string]$req.value) }
    'select' { ([System.Windows.Automation.SelectionItemPattern]$e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() }
    'toggle' { ([System.Windows.Automation.TogglePattern]$e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Toggle() }
    'expand' { ([System.Windows.Automation.ExpandCollapsePattern]$e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand() }
    'collapse' { ([System.Windows.Automation.ExpandCollapsePattern]$e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Collapse() }
    'focus' { $e.SetFocus() }
    'scroll_into_view' { ([System.Windows.Automation.ScrollItemPattern]$e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)).ScrollIntoView() }
    'click_center' {
      Move-To ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2))
      Mouse-Click 'left'
    }
    default { throw ('未知 UIA 动作: ' + $action + '(可用 invoke/set_value/select/toggle/expand/collapse/focus/scroll_into_view/click_center)') }
  }
  Start-Sleep -Milliseconds 150
  return [ordered]@{
    ok = $true; action = $action
    element = [ordered]@{ name = [string]$e.Current.Name; type = $e.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') }
    foreground = (Get-Foreground)
  }
}

# 坐标点下"到底是什么元素":点击后回报它,模型就能立刻发现自己点错了(而不是傻等下一张图)
function Invoke-ElementAt($req) {
  $pt = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
  $e = $AE::FromPoint($pt)
  if (-not $e) { return [ordered]@{ ok = $true; element = $null } }
  $d = Uia-Desc $e
  $d['actionable'] = Test-Actionable $d
  return [ordered]@{ ok = $true; element = $d }
}

function Get-AppWindows {
  $out = @()
  $fg = [TFNative]::GetForegroundWindow()
  $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    try {
      $r = $w.Current.BoundingRectangle
      $ww = [int][Math]::Round($r.Width); $hh = [int][Math]::Round($r.Height)
      if ($ww -le 60 -or $hh -le 40) { continue }   # 过滤不可见的辅助窗口
      $p2 = $w.Current.ProcessId
      $pname = ''
      try { $pname = (Get-Process -Id $p2 -ErrorAction Stop).ProcessName } catch { }
      $hw = [int64]$w.Current.NativeWindowHandle
      $out += , ([ordered]@{
          hwnd = $hw; pid = $p2; process = $pname
          title = [string]$w.Current.Name
          type = $w.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
          x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y); w = $ww; h = $hh
          minimized = ([TFNative]::IsIconic([IntPtr]$hw) -eq $true)
          foreground = ($hw -eq [int64]$fg)
        })
    } catch { }
  }
  return , $out
}

function Invoke-Activate($req) {
  $sel = Window-Selector $req
  if ($sel.Count -eq 0) { throw 'activate 需要 hwnd / pid / title 之一' }
  $w = Find-RootWindow $sel
  if (-not $w) { throw '未找到匹配窗口(可先用 windows 操作列出)' }
  $h = [IntPtr][int64]$w.Current.NativeWindowHandle
  $ok = [TFNative]::ForceForeground($h)
  Start-Sleep -Milliseconds 300
  return [ordered]@{
    ok = $true; hwnd = [int64]$h; title = [string]$w.Current.Name
    activated = [bool]$ok; foreground = (Get-Foreground)
  }
}

# 启动应用:优先用完整路径;否则在开始菜单里按名字找快捷方式。
# 注意:"应用已经在跑就不要再启一个"的判断放在上层工具里(先 windows 查,再决定)。
function Invoke-Launch($req) {
  $target = [string]$req.target
  if (-not $target) { throw 'launch 需要 target(完整路径,或开始菜单里的应用名)' }
  $path = $null
  if (Test-Path -LiteralPath $target) { $path = (Resolve-Path -LiteralPath $target).Path }
  else {
    $roots = @()
    if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') }
    if ($env:ProgramData) { $roots += (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs') }
    $needle = $target.ToLower()
    foreach ($r in $roots) {
      if (-not (Test-Path -LiteralPath $r)) { continue }
      $hit = Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName.ToLower().Contains($needle) } | Select-Object -First 1
      if ($hit) { $path = $hit.FullName; break }
    }
  }
  if (-not $path) { throw ('未找到可启动的目标「' + $target + '」:请传完整路径,或与开始菜单里一致的应用名') }
  $p = Start-Process -FilePath $path -PassThru
  return [ordered]@{ ok = $true; launched = $path; pid = $p.Id }
}

# ---------------- OCR(自绘应用的兜底:微信这类 UIA 只暴露外壳)----------------
$script:ocrReady = $false
function Init-Ocr {
  if ($script:ocrReady) { return }
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
    })[0]
  $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $script:ocrEngine) { throw 'OCR 引擎不可用(系统缺少 OCR 语言包)' }
  $script:ocrReady = $true
}

function Await-Op($op, $type) {
  $t = $script:asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(30000)
  if ($t.IsFaulted) { throw $t.Exception.GetBaseException() }
  return $t.Result
}

function Invoke-Ocr($req) {
  if ($req.rect) {
    $vx = [int]$req.rect.x; $vy = [int]$req.rect.y
    $vw = [int]$req.rect.w; $vh = [int]$req.rect.h
  } elseif ($req.hwnd -or $req.pid -or $req.title) {
    $sel = Window-Selector $req
    $w = Find-RootWindow $sel
    if (-not $w) { throw '未找到要识别的窗口(可先用 windows 操作列出)' }
    $r = $w.Current.BoundingRectangle
    $vx = [int][Math]::Round($r.X); $vy = [int][Math]::Round($r.Y)
    $vw = [int][Math]::Round($r.Width); $vh = [int][Math]::Round($r.Height)
  } else {
    $v = Get-VirtualBounds
    $vx = [int]$v.x; $vy = [int]$v.y; $vw = [int]$v.w; $vh = [int]$v.h
  }
  if ($vw -le 0 -or $vh -le 0) { throw 'OCR 区域为空' }

  # 先按 1:1 抓取,再按 scale 放大后交给 OCR:小字放大 2 倍识别率明显更高
  $scale = 1.0
  if ($req.scale) { $scale = [Math]::Min(4.0, [Math]::Max(1.0, [double]$req.scale)) }
  $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdcDst = $g.GetHdc()
  $hdcSrc = [TFNative]::GetDC([IntPtr]::Zero)
  try {
    [void][TFNative]::BitBlt($hdcDst, 0, 0, $vw, $vh, $hdcSrc, $vx, $vy, (0x00CC0020 -bor 0x40000000))
  } finally {
    $g.ReleaseHdc($hdcDst)
    [void][TFNative]::ReleaseDC([IntPtr]::Zero, $hdcSrc)
  }
  $g.Dispose()
  $save = $bmp
  if ($scale -gt 1.001) {
    $dw = [int][Math]::Max(1, [Math]::Round($vw * $scale))
    $dh = [int][Math]::Max(1, [Math]::Round($vh * $scale))
    $dst = New-Object System.Drawing.Bitmap($dw, $dh)
    $g2 = [System.Drawing.Graphics]::FromImage($dst)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $dw, $dh)
    $g2.Dispose()
    $save = $dst
  }
  $save.Save($req.path, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($save -ne $bmp) { $save.Dispose() }
  $bmp.Dispose()

  Init-Ocr
  $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($req.path)) ([Windows.Storage.StorageFile])
  $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await-Op ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await-Op ($script:ocrEngine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])

  $out = @()
  foreach ($line in @($res.Lines)) {
    $words = @($line.Words)
    if ($words.Length -eq 0) { continue }
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($wd in $words) {
      $b = $wd.BoundingRect
      if ($b.X -lt $minX) { $minX = $b.X }
      if ($b.Y -lt $minY) { $minY = $b.Y }
      if (($b.X + $b.Width) -gt $maxX) { $maxX = $b.X + $b.Width }
      if (($b.Y + $b.Height) -gt $maxY) { $maxY = $b.Y + $b.Height }
    }
    $txt = [string]$line.Text
    $out += , ([ordered]@{
        text = $txt
        compact = ($txt -replace '\s+', '')
        x = [int][Math]::Round($minX / $scale + $vx); y = [int][Math]::Round($minY / $scale + $vy)
        w = [int][Math]::Round(($maxX - $minX) / $scale); h = [int][Math]::Round(($maxY - $minY) / $scale)
      })
  }
  return [ordered]@{
    ok = $true
    rect = [ordered]@{ x = $vx; y = $vy; w = $vw; h = $vh }
    lines = $out; count = $out.Count; scale = $scale
    language = $script:ocrEngine.RecognizerLanguage.LanguageTag
  }
}

function Move-To([int]$x, [int]$y) {
  [TFNative]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 12
}

function Mouse-Down([string]$button) {
  switch ($button) {
    'right'  { [TFNative]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero) }
    'middle' { [TFNative]::mouse_event($MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, [IntPtr]::Zero) }
    default  { [TFNative]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero) }
  }
}

function Mouse-Up([string]$button) {
  switch ($button) {
    'right'  { [TFNative]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, [IntPtr]::Zero) }
    'middle' { [TFNative]::mouse_event($MOUSEEVENTF_MIDDLEUP, 0, 0, 0, [IntPtr]::Zero) }
    default  { [TFNative]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero) }
  }
}

function Mouse-Click([string]$button) {
  Mouse-Down $button
  Start-Sleep -Milliseconds 35
  Mouse-Up $button
}

function Get-VKCode([string]$name) {
  $n = $name.ToLower().Trim()
  if ($VK.ContainsKey($n)) { return [byte]$VK[$n] }
  if ($n.Length -eq 1) {
    $c = [char]$n
    if ($c -ge 'a' -and $c -le 'z') { return [byte]([int][char]::ToUpper($c)) }
    if ($c -ge '0' -and $c -le '9') { return [byte]([int]$c) }
  }
  throw "未知按键: $name"
}

function Send-Hotkey([string[]]$keys) {
  $mods = @()
  $main = @()
  foreach ($k in $keys) {
    switch ($k.ToLower().Trim()) {
      'ctrl'    { $mods += 0x11 }
      'control' { $mods += 0x11 }
      'shift'   { $mods += 0x10 }
      'alt'     { $mods += 0x12 }
      'win'     { $mods += 0x5B }
      'cmd'     { $mods += 0x5B }
      'meta'    { $mods += 0x5B }
      default   { if ($k.Trim() -ne '') { $main += $k.Trim() } }
    }
  }
  foreach ($m in $mods) { [TFNative]::keybd_event([byte]$m, 0, 0, [IntPtr]::Zero) }
  Start-Sleep -Milliseconds 20
  foreach ($k in $main) {
    $vk = Get-VKCode $k
    [TFNative]::keybd_event($vk, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [TFNative]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
  }
  [array]::Reverse($mods)
  foreach ($m in $mods) { [TFNative]::keybd_event([byte]$m, 0, $KEYEVENTF_KEYUP, [IntPtr]::Zero) }
}

# 任意 Unicode 文本输入:用 KEYEVENTF_UNICODE 逐字符注入,不经过键盘布局,
# 中文/emoji 之外的全部字符都能原样送入(不受 SendKeys 特殊字符转义影响)。
function Send-UnicodeText([string]$text) {
  foreach ($ch in $text.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -eq 10 -or $code -eq 13) { Send-Hotkey @('enter'); continue }
    if ($code -eq 9) { Send-Hotkey @('tab'); continue }
    [TFNative]::keybd_event(0, [byte]($code -band 0xFF), $KEYEVENTF_UNICODE, [IntPtr]::Zero)
    [TFNative]::keybd_event(0, [byte](($code -shr 8) -band 0xFF), $KEYEVENTF_UNICODE, [IntPtr]::Zero)
    [TFNative]::keybd_event(0, [byte]($code -band 0xFF), ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP), [IntPtr]::Zero)
    [TFNative]::keybd_event(0, [byte](($code -shr 8) -band 0xFF), ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP), [IntPtr]::Zero)
    Start-Sleep -Milliseconds 8
  }
}

function Invoke-Capture($req) {
  $monitors = Get-Monitors
  if ($req.rect) {
    # 区域截图:用于把一小块放大到 1:1 看清细节(整屏缩放后看不清小字/小图标)
    $vx = [int]$req.rect.x; $vy = [int]$req.rect.y
    $vw = [int]$req.rect.w; $vh = [int]$req.rect.h
    if ($vw -le 0 -or $vh -le 0) { throw '截图区域为空' }
  } else {
  $idx = $req.monitor
  $useMonitor = $false
  if ($null -ne $idx) {
    $n = [int]$idx
    if ($n -ge 0 -and $n -lt $monitors.Count) { $useMonitor = $true }
  }
  if ($useMonitor) {
    $m = $monitors[[int]$idx]
    $vx = [int]$m.x; $vy = [int]$m.y; $vw = [int]$m.w; $vh = [int]$m.h
  } else {
    $v = Get-VirtualBounds
    $vx = [int]$v.x; $vy = [int]$v.y; $vw = [int]$v.w; $vh = [int]$v.h
  }
  }

  $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # 用 BitBlt + CAPTUREBLT,而不是 Graphics.CopyFromScreen:
  # 后者的 CopyPixelOperation 重载在 PowerShell 里传不了组合标志位(枚举成员校验直接抛
  # "值对枚举类型无效"),而不带标志位的重载抓不到部分分层窗口(黑块);BitBlt 的 rop
  # 是 int 参数,可以自由组合 SRCCOPY|CAPTUREBLT,负坐标(左侧副屏)也验证可用。
  $hdcDst = $g.GetHdc()
  $hdcSrc = [TFNative]::GetDC([IntPtr]::Zero)
  try {
    [void][TFNative]::BitBlt($hdcDst, 0, 0, $vw, $vh, $hdcSrc, $vx, $vy, (0x00CC0020 -bor 0x40000000))
  } finally {
    $g.ReleaseHdc($hdcDst)
    [void][TFNative]::ReleaseDC([IntPtr]::Zero, $hdcSrc)
  }
  $g.Dispose()

  $maxDim = 2560
  if ($null -ne $req.max_width -and [int]$req.max_width -gt 0) { $maxDim = [int]$req.max_width }
  $longest = [Math]::Max($vw, $vh)
  $scale = 1.0
  if ($longest -gt $maxDim) { $scale = $maxDim / $longest }

  $img = $bmp
  if ($scale -lt 0.999) {
    $nw = [int][Math]::Max(1, [Math]::Round($vw * $scale))
    $nh = [int][Math]::Max(1, [Math]::Round($vh * $scale))
    $dst = New-Object System.Drawing.Bitmap($nw, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($dst)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    $g2.Dispose()
    $img = $dst
  }

  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
  $img.Save($req.path, $enc, $ps)

  $iw = $img.Width; $ih = $img.Height
  if ($img -ne $bmp) { $img.Dispose() }
  $bmp.Dispose()

  return [ordered]@{
    ok = $true; path = $req.path; width = $iw; height = $ih; scale = $scale
    virtual = [ordered]@{ x = $vx; y = $vy; w = $vw; h = $vh }
    monitors = $monitors; cursor = (Get-Cursor); foreground = (Get-Foreground); locked = (Test-Locked)
  }
}

function Invoke-Op($req) {
  $op = [string]$req.op
  switch ($op) {
    'ping' { return [ordered]@{ ok = $true; pid = $PID } }
    'monitors' {
      return [ordered]@{ ok = $true; monitors = (Get-Monitors); virtual = (Get-VirtualBounds); cursor = (Get-Cursor); foreground = (Get-Foreground); locked = (Test-Locked) }
    }
    'session' {
      return [ordered]@{ ok = $true; locked = (Test-Locked); foreground = (Get-Foreground); cursor = (Get-Cursor) }
    }
    'capture' { return Invoke-Capture $req }
    'windows' { return [ordered]@{ ok = $true; windows = (Get-AppWindows); locked = (Test-Locked) } }
    'window_rect' {
      $w = Find-RootWindow (Window-Selector $req)
      if (-not $w) { throw '未找到窗口(可先用 windows 操作列出)' }
      $r = $w.Current.BoundingRectangle
      return [ordered]@{
        ok = $true; hwnd = [int64]$w.Current.NativeWindowHandle; title = [string]$w.Current.Name
        x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y)
        w = [int][Math]::Round($r.Width); h = [int][Math]::Round($r.Height)
      }
    }
    'activate' { return Invoke-Activate $req }
    'launch' { return Invoke-Launch $req }
    'uia_tree' { return Invoke-UiaTree $req }
    'uia_find' { return Invoke-UiaFind $req }
    'uia_action' { return Invoke-UiaAction $req }
    'element_at' { return Invoke-ElementAt $req }
    'ocr' { return Invoke-Ocr $req }
    'mouse' {
      $action = [string]$req.action
      $button = 'left'
      if ($req.button) { $button = [string]$req.button }
      $x = $null; $y = $null
      if ($null -ne $req.x) { $x = [int]$req.x }
      if ($null -ne $req.y) { $y = [int]$req.y }
      if ($null -ne $x -and $null -ne $y) { Move-To $x $y }
      switch ($action) {
        'move'         { }
        'click'        { Mouse-Click $button }
        'double_click' { Mouse-Click 'left'; Start-Sleep -Milliseconds 70; Mouse-Click 'left' }
        'right_click'  { Mouse-Click 'right' }
        'middle_click' { Mouse-Click 'middle' }
        'down'         { Mouse-Down $button }
        'up'           { Mouse-Up $button }
        'drag' {
          if ($null -eq $x -or $null -eq $y) { throw 'drag 需要起始坐标 x/y' }
          if ($null -eq $req.to_x -or $null -eq $req.to_y) { throw 'drag 需要目标坐标 to_x/to_y' }
          $tx = [int]$req.to_x; $ty = [int]$req.to_y
          Mouse-Down 'left'
          $steps = 14
          for ($i = 1; $i -le $steps; $i++) {
            $nx = [int][Math]::Round($x + ($tx - $x) * $i / $steps)
            $ny = [int][Math]::Round($y + ($ty - $y) * $i / $steps)
            [TFNative]::SetCursorPos($nx, $ny) | Out-Null
            Start-Sleep -Milliseconds 12
          }
          Mouse-Up 'left'
        }
        default { throw "未知鼠标动作: $action" }
      }
      return [ordered]@{ ok = $true; cursor = (Get-Cursor); foreground = (Get-Foreground) }
    }
    'scroll' {
      if ($null -ne $req.x -and $null -ne $req.y) { Move-To ([int]$req.x) ([int]$req.y) }
      $amount = 3
      if ($null -ne $req.amount) { $amount = [int]$req.amount }
      [TFNative]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, ($amount * 120), [IntPtr]::Zero)
      return [ordered]@{ ok = $true; cursor = (Get-Cursor) }
    }
    'type' {
      $text = [string]$req.text
      Send-UnicodeText $text
      return [ordered]@{ ok = $true; length = $text.Length; foreground = (Get-Foreground) }
    }
    'key' {
      $keys = @()
      if ($req.keys -is [array]) { $keys = $req.keys } elseif ($null -ne $req.keys) { $keys = @([string]$req.keys) }
      if ($keys.Count -eq 0) { throw 'key 需要 keys 参数' }
      Send-Hotkey $keys
      return [ordered]@{ ok = $true; keys = $keys; foreground = (Get-Foreground) }
    }
    'foreground' { return [ordered]@{ ok = $true; foreground = (Get-Foreground); cursor = (Get-Cursor) } }
    'wait' {
      $ms = 500
      if ($null -ne $req.ms) { $ms = [Math]::Min(30000, [Math]::Max(0, [int]$req.ms)) }
      Start-Sleep -Milliseconds $ms
      return [ordered]@{ ok = $true; ms = $ms }
    }
    default { throw "未知操作: $op" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $resp = Invoke-Op $req
    if ($null -eq $resp) { $resp = [ordered]@{ ok = $true } }
    $resp['id'] = $req.id
    $json = $resp | ConvertTo-Json -Compress -Depth 10
  } catch {
    $rid = $null
    if ($null -ne $req) { $rid = $req.id }
    $json = ([ordered]@{ id = $rid; ok = $false; error = $_.Exception.Message }) | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
`;

export const OVERLAY_PS1 = String.raw`
param(
  [int]$Port = 4000,
  [string]$Text = 'AI 操控中'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TFOverlayNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@
[TFOverlayNative]::SetProcessDPIAware() | Out-Null

# 悬浮窗绝不能抢前台焦点:否则 AI 正在操作的应用会被自己的提示窗顶掉
# (实测出现过前台窗口变成 powershell + 悬浮条、Alt+Tab 里多出一个空白窗口的情况)。
# ShowWithoutActivation 让 Show() 走 SW_SHOWNOACTIVATE;Show 之后再用 SetWindowLong 补上
# WS_EX_NOACTIVATE(点击不激活)与 WS_EX_TOOLWINDOW(不进 Alt+Tab)。
# 注意必须在 Show() 之后补:WinForms 在创建/更新句柄时会按 CreateParams 重写扩展样式,
# 在 HandleCreated 里设的位会被 TransparencyKey / Opacity 的样式更新冲掉。
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System.Windows.Forms;
public class NoActivateForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}
'@

function Set-OverlayStyle([System.Windows.Forms.Form]$f) {
  try {
    $GWL_EXSTYLE = -20
    $ex = [TFOverlayNative]::GetWindowLong($f.Handle, $GWL_EXSTYLE)
    [void][TFOverlayNative]::SetWindowLong($f.Handle, $GWL_EXSTYLE, ($ex -bor 0x08000000 -bor 0x00000080))
  } catch { }
}

$script:forms = @()
$script:failCount = 0
$script:stopping = $false
$script:stopUrl = "http://127.0.0.1:$Port/api/computer-use/stop"
$script:healthUrl = "http://127.0.0.1:$Port/api/health"

function Stop-Control {
  if ($script:stopping) { return }
  $script:stopping = $true
  try {
    Invoke-WebRequest -Method Post -Uri $script:stopUrl -TimeoutSec 3 -UseBasicParsing | Out-Null
  } catch { }
  [System.Windows.Forms.Application]::ExitThread()
}

function New-Frame([object]$bounds) {
  $f = New-Object NoActivateForm
  $f.FormBorderStyle = 'None'
  $f.StartPosition = 'Manual'
  $f.Location = New-Object System.Drawing.Point([int]$bounds.X, [int]$bounds.Y)
  $f.Size = New-Object System.Drawing.Size([int]$bounds.Width, [int]$bounds.Height)
  $f.TopMost = $true
  $f.ShowInTaskbar = $false
  $f.BackColor = [System.Drawing.Color]::Magenta
  $f.TransparencyKey = [System.Drawing.Color]::Magenta
  $f.Add_Paint({
    param($sender, $e)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0, 132, 255), 6)
    $r = New-Object System.Drawing.Rectangle(3, 3, ([int]$sender.Width - 8), ([int]$sender.Height - 8))
    $e.Graphics.DrawRectangle($pen, $r)
    $pen.Dispose()
  })
  return $f
}

function New-Banner([object]$bounds) {
  $w = 372
  $h = 68
  $x = [int]($bounds.X + (($bounds.Width - $w) / 2))
  $y = [int]($bounds.Y + 18)

  $f = New-Object NoActivateForm
  $f.FormBorderStyle = 'None'
  $f.StartPosition = 'Manual'
  $f.Location = New-Object System.Drawing.Point($x, $y)
  $f.Size = New-Object System.Drawing.Size($w, $h)
  $f.TopMost = $true
  $f.ShowInTaskbar = $false
  $f.BackColor = [System.Drawing.Color]::FromArgb(17, 20, 28)
  $f.Opacity = 0.95

  $dot = New-Object System.Windows.Forms.Label
  $dot.Text = [char]0x25CF
  $dot.ForeColor = [System.Drawing.Color]::FromArgb(0, 208, 132)
  $dot.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
  $dot.Location = New-Object System.Drawing.Point(15, 18)
  $dot.AutoSize = $true
  $f.Controls.Add($dot)

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = $Text
  $lbl.ForeColor = [System.Drawing.Color]::White
  $lbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $lbl.Location = New-Object System.Drawing.Point(40, 20)
  $lbl.AutoSize = $true
  $f.Controls.Add($lbl)

  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = '停止'
  $btn.FlatStyle = 'Flat'
  $btn.FlatAppearance.BorderSize = 0
  $btn.BackColor = [System.Drawing.Color]::FromArgb(226, 62, 74)
  $btn.ForeColor = [System.Drawing.Color]::White
  $btn.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $btn.Size = New-Object System.Drawing.Size(66, 34)
  $btn.Location = New-Object System.Drawing.Point(($w - 66 - 13), 17)
  $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btn.Add_Click({ Stop-Control })
  $f.Controls.Add($btn)

  return $f
}

[System.Windows.Forms.Application]::EnableVisualStyles()

foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  $frame = New-Frame $b
  $script:forms += $frame
  $frame.Show()
  Set-OverlayStyle $frame

  $banner = New-Banner $b
  $script:forms += $banner
  $banner.Show()
  Set-OverlayStyle $banner
}

# 心跳灯:绿/蓝交替,提示这是"进行中"的状态而不是静态贴图
$pulse = New-Object System.Windows.Forms.Timer
$pulse.Interval = 700
$script:on = $true
$pulse.Add_Tick({
  $script:on = -not $script:on
  $c = if ($script:on) { [System.Drawing.Color]::FromArgb(0, 208, 132) } else { [System.Drawing.Color]::FromArgb(0, 132, 255) }
  foreach ($f in $script:forms) {
    foreach ($c2 in $f.Controls) {
      if ($c2 -is [System.Windows.Forms.Label] -and $c2.Text -eq [string][char]0x25CF) { $c2.ForeColor = $c }
    }
  }
})
$pulse.Start()

# 后端消失则自动退出,避免留下孤儿悬浮窗
$health = New-Object System.Windows.Forms.Timer
$health.Interval = 5000
$health.Add_Tick({
  try {
    Invoke-WebRequest -Method Get -Uri $script:healthUrl -TimeoutSec 3 -UseBasicParsing | Out-Null
    $script:failCount = 0
  } catch {
    $script:failCount = $script:failCount + 1
    if ($script:failCount -ge 3) { [System.Windows.Forms.Application]::ExitThread() }
  }
})
$health.Start()

[System.Windows.Forms.Application]::Run()
`;
