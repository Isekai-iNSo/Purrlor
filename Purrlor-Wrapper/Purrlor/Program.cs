using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Purrlor;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => MessageBox.Show(
            $"Purrlor encountered an unexpected error.\n\n{e.Exception.Message}",
            "Purrlor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            try { File.AppendAllText(AppPaths.ErrorLog, $"{DateTime.Now:u} {e.ExceptionObject}\n"); } catch { }
        };
        Application.Run(new MainForm());
    }
}

internal static class AppPaths
{
    public static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Purrlor");
    public static readonly string Settings = Path.Combine(Root, "settings.json");
    public static readonly string ErrorLog = Path.Combine(Root, "errors.log");
    public static readonly string WebView = Path.Combine(Root, "WebView2");
}

internal sealed class AppSettings
{
    public Rectangle? Bounds { get; set; }
    public bool Maximized { get; set; }
    public bool StartWithWindows { get; set; }
}

internal sealed class WindowButton : Control
{
    private bool hover;
    private bool pressed;
    public string Glyph { get; set; } = "";
    public Color HoverColor { get; set; } = Color.FromArgb(30, 33, 39);
    public Color PressedColor { get; set; } = Color.FromArgb(42, 45, 52);

    public WindowButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        SetStyle(ControlStyles.Selectable, false);
        TabStop = false;
        Cursor = Cursors.Default;
        BackColor = MainForm.ChromeColor;
        ForeColor = Color.White;
        Width = 46;
        Height = 38;
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { pressed = true; Invalidate(); }
        base.OnMouseDown(e);
    }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        bool shouldClick = e.Button == MouseButtons.Left && pressed && ClientRectangle.Contains(e.Location);
        pressed = false; Invalidate(); base.OnMouseUp(e);
        if (shouldClick) PerformClick();
    }
    public void PerformClick() => OnClick(EventArgs.Empty);

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(BackColor);
        if (pressed) using (var b = new SolidBrush(PressedColor)) e.Graphics.FillRectangle(b, ClientRectangle);
        else if (hover) using (var b = new SolidBrush(HoverColor)) e.Graphics.FillRectangle(b, ClientRectangle);
        using var pen = new Pen(ForeColor, 1.2f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        float cx = Width / 2f, cy = Height / 2f;
        if (Glyph == "min") e.Graphics.DrawLine(pen, cx - 6, cy + 4, cx + 6, cy + 4);
        else if (Glyph == "max") e.Graphics.DrawRectangle(pen, cx - 5, cy - 5, 10, 10);
        else if (Glyph == "restore") { e.Graphics.DrawRectangle(pen, cx - 3, cy - 5, 8, 8); e.Graphics.DrawRectangle(pen, cx - 6, cy - 2, 8, 8); }
        else if (Glyph == "close") { e.Graphics.DrawLine(pen, cx - 5, cy - 5, cx + 5, cy + 5); e.Graphics.DrawLine(pen, cx + 5, cy - 5, cx - 5, cy + 5); }
    }
}

public sealed class MainForm : Form
{
    public static readonly Color ChromeColor = Color.FromArgb(13, 15, 19);
    private static readonly Color CloseHover = Color.FromArgb(190, 45, 39);
    private const int TitleBarHeight = 40;
    private const string StartUrl = "https://purr.meowops.net";
    private const int ResizeGrip = 12;
    private const int WM_NCHITTEST = 0x0084;
    private const int WM_QUERYENDSESSION = 0x0011;
    private const int WM_ENDSESSION = 0x0016;
    private const int WS_THICKFRAME = 0x00040000;
    private const int WS_MINIMIZEBOX = 0x00020000;
    private const int WS_MAXIMIZEBOX = 0x00010000;
    private const int WS_SYSMENU = 0x00080000;
    private const int HTCLIENT = 1, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14,
        HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWA_CAPTION_COLOR = 35;
    private const int DWMWA_TEXT_COLOR = 36;

    private WebView2 webView = new();
    private readonly Panel titleBar = new();
    private readonly Label titleLabel = new();
    private readonly WindowButton minimizeButton = new() { Glyph = "min" };
    private readonly WindowButton maximizeButton = new() { Glyph = "max" };
    private readonly WindowButton closeButton = new() { Glyph = "close", HoverColor = CloseHover };
    private readonly Panel loadingOverlay = new();
    private readonly Label loadingLabel = new();
    private readonly NotifyIcon trayIcon;
    private readonly ContextMenuStrip trayMenu = new();
    private readonly AppSettings settings;
    private bool allowExit;
    private bool webViewReady;
    private bool restoringAfterCrash;

    public MainForm()
    {
        Directory.CreateDirectory(AppPaths.Root);
        settings = LoadSettings();
        Text = "Purrlor";
        Width = 1280; Height = 820;
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        BackColor = ChromeColor;
        Icon = LoadAppIcon();
        ApplySavedBounds();

        trayIcon = new NotifyIcon { Icon = Icon ?? SystemIcons.Application, Text = "Purrlor", Visible = true, ContextMenuStrip = trayMenu };
        trayIcon.DoubleClick += (_, _) => RestoreFromTray();
        trayIcon.BalloonTipClicked += (_, _) => RestoreFromTray();
        BuildTrayMenu();
        BuildChrome();
        BuildLoadingOverlay();
        Controls.Add(webView);
        Controls.Add(loadingOverlay);
        Controls.Add(titleBar);
        LayoutChrome();
        ApplyDarkDwmFrame();

        Load += MainForm_Load;
        Shown += (_, _) =>
        {
            if (settings.Maximized)
                BeginInvoke(new Action(() => { UpdateMaximizedBounds(); WindowState = FormWindowState.Maximized; UpdateMaximizeButton(); }));
        };
        FormClosing += MainForm_FormClosing;
        Resize += (_, _) => { LayoutChrome(); UpdateMaximizeButton(); };
        Move += (_, _) => { if (WindowState == FormWindowState.Normal) SaveWindowState(); };
        FormClosed += (_, _) => DisposeResources();
    }

    private Icon LoadAppIcon()
    {
        try
        {
            // The published EXE contains the application icon. Extracting it avoids
            // relying on the .ico being copied beside the executable for tray usage.
            var extracted = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (extracted != null) return extracted;
        }
        catch { }
        try
        {
            var path = Path.Combine(Application.StartupPath, "purrlor.ico");
            if (File.Exists(path)) return new Icon(path);
        }
        catch { }
        return SystemIcons.Application;
    }

    private void BuildChrome()
    {
        titleBar.SetBounds(0, 0, ClientSize.Width, TitleBarHeight);
        titleBar.BackColor = ChromeColor;
        titleBar.MouseDown += TitleBar_MouseDown;
        titleBar.DoubleClick += (_, _) => ToggleMaximize();

        titleLabel.Text = "Purrlor";
        titleLabel.ForeColor = Color.FromArgb(235, 238, 242);
        titleLabel.BackColor = Color.Transparent;
        titleLabel.Font = new Font("Segoe UI", 9.5f);
        titleLabel.TextAlign = ContentAlignment.MiddleLeft;
        titleLabel.Padding = new Padding(14, 0, 0, 0);
        titleLabel.Dock = DockStyle.Fill;
        titleLabel.MouseDown += TitleBar_MouseDown;
        titleLabel.DoubleClick += (_, _) => ToggleMaximize();

        ConfigureButton(minimizeButton);
        ConfigureButton(maximizeButton);
        ConfigureButton(closeButton);
        minimizeButton.Click += (_, _) => WindowState = FormWindowState.Minimized;
        maximizeButton.Click += (_, _) => ToggleMaximize();
        closeButton.Click += (_, _) => MinimizeToTray();

        // Left-to-right: Minimize, Maximize/Restore, Close.
        var buttons = new Panel { Dock = DockStyle.Right, Width = 138, Height = TitleBarHeight, BackColor = ChromeColor };
        buttons.Controls.Add(closeButton);
        buttons.Controls.Add(maximizeButton);
        buttons.Controls.Add(minimizeButton);
        closeButton.SetBounds(92, 0, 46, TitleBarHeight);
        maximizeButton.SetBounds(46, 0, 46, TitleBarHeight);
        minimizeButton.SetBounds(0, 0, 46, TitleBarHeight);
        titleBar.Controls.Add(titleLabel);
        titleBar.Controls.Add(buttons);
        titleBar.BringToFront();
    }

    private static void ConfigureButton(WindowButton button)
    {
        button.BackColor = ChromeColor;
        button.ForeColor = Color.FromArgb(235, 238, 242);
        button.Width = 46; button.Height = TitleBarHeight;
    }

    private void BuildLoadingOverlay()
    {
        loadingOverlay.BackColor = ChromeColor;
        loadingLabel.Text = "Purrlor\r\nLoading…";
        loadingLabel.ForeColor = Color.FromArgb(220, 224, 230);
        loadingLabel.Font = new Font("Segoe UI", 11f);
        loadingLabel.TextAlign = ContentAlignment.MiddleCenter;
        loadingLabel.Dock = DockStyle.Fill;
        loadingOverlay.Controls.Add(loadingLabel);
        loadingOverlay.BringToFront();
    }

    private void LayoutChrome()
    {
        var w = Math.Max(1, ClientSize.Width); var h = Math.Max(1, ClientSize.Height);
        titleBar.SetBounds(0, 0, w, TitleBarHeight);
        webView.SetBounds(0, TitleBarHeight, w, Math.Max(1, h - TitleBarHeight));
        loadingOverlay.SetBounds(0, TitleBarHeight, w, Math.Max(1, h - TitleBarHeight));
        titleBar.BringToFront();
        if (!webViewReady) loadingOverlay.BringToFront();
    }

    private void BuildTrayMenu()
    {
        var show = new ToolStripMenuItem("Show Purrlor"); show.Click += (_, _) => RestoreFromTray();
        var start = new ToolStripMenuItem("Start with Windows") { Checked = settings.StartWithWindows, CheckOnClick = true };
        start.CheckedChanged += (_, _) => { settings.StartWithWindows = start.Checked; SetStartup(start.Checked); SaveSettings(); };
        var exit = new ToolStripMenuItem("Exit Purrlor"); exit.Click += (_, _) => { allowExit = true; Close(); };
        trayMenu.Items.Add(show); trayMenu.Items.Add(new ToolStripSeparator()); trayMenu.Items.Add(start); trayMenu.Items.Add(new ToolStripSeparator()); trayMenu.Items.Add(exit);
    }

    private void MinimizeToTray() { SaveWindowState(); Hide(); WindowState = FormWindowState.Minimized; }

    private void RestoreFromTray()
    {
        Show();
        BeginInvoke(new Action(() =>
        {
            UpdateMaximizedBounds();
            WindowState = settings.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
            Activate(); BringToFront(); UpdateMaximizeButton();
        }));
    }

    private void MainForm_FormClosing(object? sender, FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing || allowExit) return;
        e.Cancel = true; MinimizeToTray();
    }

    private void TitleBar_MouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        if (WindowState == FormWindowState.Maximized)
        {
            double ratio = Math.Clamp((double)e.X / Math.Max(1, titleBar.Width), 0.05, 0.95);
            ToggleMaximize();
            Left = Math.Max(0, Cursor.Position.X - (int)(Width * ratio));
            Top = Math.Max(0, Cursor.Position.Y - TitleBarHeight / 2);
        }
        ReleaseCapture(); SendMessage(Handle, 0x00A1, (IntPtr)2, IntPtr.Zero);
    }

    private void UpdateMaximizedBounds() { try { MaximizedBounds = Screen.FromControl(this).WorkingArea; } catch { } }

    private void ToggleMaximize()
    {
        bool maximize = WindowState != FormWindowState.Maximized;
        if (maximize) UpdateMaximizedBounds();
        WindowState = maximize ? FormWindowState.Maximized : FormWindowState.Normal;
        BeginInvoke(new Action(() => { settings.Maximized = WindowState == FormWindowState.Maximized; SaveWindowState(); UpdateMaximizeButton(); }));
    }

    private void UpdateMaximizeButton() => maximizeButton.Glyph = WindowState == FormWindowState.Maximized ? "restore" : "max";

    private void ApplySavedBounds()
    {
        if (settings.Bounds is Rectangle r && r.Width >= MinimumSize.Width && r.Height >= MinimumSize.Height)
        {
            var valid = Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r));
            if (valid) Bounds = r; else StartPosition = FormStartPosition.CenterScreen;
        }
        else StartPosition = FormStartPosition.CenterScreen;
    }

    private AppSettings LoadSettings()
    {
        try { if (File.Exists(AppPaths.Settings)) return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(AppPaths.Settings)) ?? new(); } catch { }
        return new();
    }

    private void SaveWindowState()
    {
        try
        {
            if (WindowState == FormWindowState.Normal)
            {
                settings.Bounds = RestoreBounds.Width >= MinimumSize.Width && RestoreBounds.Height >= MinimumSize.Height ? RestoreBounds : Bounds;
                settings.Maximized = false;
            }
            else if (WindowState == FormWindowState.Maximized)
            {
                if (RestoreBounds.Width >= MinimumSize.Width && RestoreBounds.Height >= MinimumSize.Height) settings.Bounds = RestoreBounds;
                settings.Maximized = true;
            }
            Directory.CreateDirectory(AppPaths.Root);
            File.WriteAllText(AppPaths.Settings, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    private void SaveSettings()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.Root);
            if (WindowState == FormWindowState.Normal) { settings.Bounds = Bounds; settings.Maximized = false; }
            File.WriteAllText(AppPaths.Settings, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    private void SetStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) key?.SetValue("Purrlor", $"\"{Application.ExecutablePath}\""); else key?.DeleteValue("Purrlor", false);
    }

    private void DisposeResources()
    {
        SaveSettings(); trayIcon.Visible = false; trayIcon.Dispose(); trayMenu.Dispose(); webView.Dispose();
    }

    private async void MainForm_Load(object? sender, EventArgs e) { await InitializeWebViewAsync(); }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.WebView);
            var environment = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebView);
            await webView.EnsureCoreWebView2Async(environment);
            var core = webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.NewWindowRequested += Core_NewWindowRequested;
            core.NavigationStarting += Core_NavigationStarting;
            core.DownloadStarting += Core_DownloadStarting;
            HookNotificationReceived(core);
            core.ProcessFailed += Core_ProcessFailed;
            core.DocumentTitleChanged += (_, _) => BeginInvoke(() => titleLabel.Text = "Purrlor");
            core.Navigate(StartUrl);
            webViewReady = true; loadingOverlay.Visible = false; LayoutChrome();
        }
        catch (Exception ex)
        {
            loadingLabel.Text = "Purrlor\r\nUnable to start WebView2\r\n\r\n" + ex.Message;
            loadingOverlay.Visible = true;
            File.AppendAllText(AppPaths.ErrorLog, $"{DateTime.Now:u} WebView2 init: {ex}\n");
        }
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsPurrlorUrl(e.Uri)) return; e.Cancel = true; OpenExternal(e.Uri);
    }
    private void Core_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true; if (IsPurrlorUrl(e.Uri)) webView.CoreWebView2.Navigate(e.Uri); else OpenExternal(e.Uri);
    }
    private void Core_DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(downloads);
        var name = Path.GetFileName(e.ResultFilePath); if (string.IsNullOrWhiteSpace(name)) name = "Purrlor-download";
        e.ResultFilePath = GetUniquePath(Path.Combine(downloads, name)); e.Handled = true;
        e.DownloadOperation.StateChanged += (_, _) => { if (e.DownloadOperation.State == CoreWebView2DownloadState.Completed) ShowTrayMessage("Download complete", Path.GetFileName(e.ResultFilePath)); };
    }

    private void HookNotificationReceived(CoreWebView2 core)
    {
        try
        {
            var eventInfo = core.GetType().GetEvent("NotificationReceived");
            if (eventInfo?.EventHandlerType == null) return;
            var method = GetType().GetMethod(nameof(Core_NotificationReceivedReflection), System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            if (method == null) return;
            var handler = Delegate.CreateDelegate(eventInfo.EventHandlerType, this, method, throwOnBindFailure: false);
            if (handler != null) eventInfo.AddEventHandler(core, handler);
        }
        catch { }
    }
    private void Core_NotificationReceivedReflection(object? sender, object? args)
    {
        try
        {
            if (args == null) return; var argsType = args.GetType(); argsType.GetProperty("Handled")?.SetValue(args, true);
            var notification = argsType.GetProperty("Notification")?.GetValue(args); if (notification == null) return;
            var nt = notification.GetType(); var title = nt.GetProperty("Title")?.GetValue(notification)?.ToString(); var body = nt.GetProperty("Body")?.GetValue(notification)?.ToString();
            trayIcon.BalloonTipTitle = string.IsNullOrWhiteSpace(title) ? "Purrlor" : title;
            trayIcon.BalloonTipText = string.IsNullOrWhiteSpace(body) ? "You have a new notification." : body;
            trayIcon.ShowBalloonTip(5000); nt.GetMethod("ReportShown")?.Invoke(notification, null);
        }
        catch { }
    }
    private void Core_ProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (restoringAfterCrash || allowExit) return; restoringAfterCrash = true;
        BeginInvoke(async () =>
        {
            try { loadingLabel.Text = "Purrlor\r\nWebView2 recovered after an error…"; loadingOverlay.Visible = true; Controls.Remove(webView); webView.Dispose(); webView = new WebView2 { Dock = DockStyle.None }; Controls.Add(webView); LayoutChrome(); await InitializeWebViewAsync(); }
            finally { restoringAfterCrash = false; }
        });
    }
    private static bool IsPurrlorUrl(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp) return false;
        return u.Host.Equals("purr.meowops.net", StringComparison.OrdinalIgnoreCase) || u.Host.EndsWith(".purr.meowops.net", StringComparison.OrdinalIgnoreCase);
    }
    private static void OpenExternal(string uri) { try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { } }
    private static string GetUniquePath(string path)
    {
        if (!File.Exists(path)) return path; var dir = Path.GetDirectoryName(path)!; var name = Path.GetFileNameWithoutExtension(path); var ext = Path.GetExtension(path);
        for (int i = 1; i < 1000; i++) { var candidate = Path.Combine(dir, $"{name} ({i}){ext}"); if (!File.Exists(candidate)) return candidate; }
        return Path.Combine(dir, $"{name}-{Guid.NewGuid():N}{ext}");
    }
    private void ShowTrayMessage(string title, string text) { trayIcon.BalloonTipTitle = title; trayIcon.BalloonTipText = text; trayIcon.ShowBalloonTip(3000); }

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.Style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU; return cp; }
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_QUERYENDSESSION || m.Msg == WM_ENDSESSION) allowExit = true;
        if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
        {
            base.WndProc(ref m);
            if ((int)m.Result == HTCLIENT)
            {
                var p = PointToClient(Cursor.Position);
                bool left = p.X <= ResizeGrip, right = p.X >= ClientSize.Width - ResizeGrip, top = p.Y <= ResizeGrip, bottom = p.Y >= ClientSize.Height - ResizeGrip;
                if (left && top) { m.Result = (IntPtr)HTTOPLEFT; return; } if (right && top) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                if (left && bottom) { m.Result = (IntPtr)HTBOTTOMLEFT; return; } if (right && bottom) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                if (left) { m.Result = (IntPtr)HTLEFT; return; } if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                if (top) { m.Result = (IntPtr)HTTOP; return; } if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
            }
            return;
        }
        base.WndProc(ref m);
    }
    private void ApplyDarkDwmFrame()
    {
        try
        {
            int color = ToColorRef(ChromeColor); DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref color, 4); DwmSetWindowAttribute(Handle, DWMWA_CAPTION_COLOR, ref color, 4);
            int text = ToColorRef(Color.FromArgb(235, 238, 242)); DwmSetWindowAttribute(Handle, DWMWA_TEXT_COLOR, ref text, 4);
        }
        catch { }
    }
    private static int ToColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
