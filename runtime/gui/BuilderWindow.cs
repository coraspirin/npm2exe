// npm2exe.exe'nin pencereli arayüzü: proje klasörünü seç (veya sürükle), "Exe oluştur"a bas.
//
// Runtime/sfx/Sfx.cs ile birlikte /define:TOOLGUI ile derlenir (src/packager/sfx.js compileStub toolGui).
// Explorer'dan çift tıklandığında veya exe'nin üzerine klasör bırakıldığında açılır; terminalden argümanla
// çalıştırıldığında stub doğrudan CLI'yi çalıştırır. Build, gömülü node.exe ile `cli.js --gui-protocol` alt
// süreci olarak yapılır: "@@NPM2EXE {json}" satırları ilerleme/sonuç, diğer satırlar log olarak gösterilir.
#if TOOLGUI
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

sealed class BuilderWindow : Form
{
    const string Prefix = "@@NPM2EXE ";

    readonly string nodeExe;
    readonly string cliPrefix;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();

    readonly TextBox projectBox = new TextBox();
    readonly TextBox outBox = new TextBox();
    readonly CheckBox exeCheck = new CheckBox();
    readonly CheckBox folderCheck = new CheckBox();
    readonly CheckBox zipCheck = new CheckBox();
    readonly Button browseButton = new Button();
    readonly Button outButton = new Button();
    readonly Button buildButton = new Button();
    readonly Button openButton = new Button();
    readonly Button runButton = new Button();
    readonly Label statusLabel = new Label();
    readonly Label summaryLabel = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly TextBox logBox = new TextBox();

    Process child;
    bool closingAfterCancel;
    string resultExe;
    string resultDir;
    string lastError;
    readonly List<string> preflightErrors = new List<string>();

    public static int Run(string title, string nodeExe, string cliPrefix, string initialPath, string defaultOut)
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var w = new BuilderWindow(title, nodeExe, cliPrefix, defaultOut);
        if (!string.IsNullOrEmpty(initialPath))
        {
            w.projectBox.Text = initialPath;
            w.Shown += (s, e) => w.StartBuild();
        }
        Application.Run(w);
        return 0;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    BuilderWindow(string title, string nodeExe, string cliPrefix, string defaultOut)
    {
        this.nodeExe = nodeExe;
        this.cliPrefix = cliPrefix;

        Text = title + " — Node.js projesini exe'ye dönüştür";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(640, 520);
        MinimumSize = new Size(560, 420);
        Font = new Font("Segoe UI", 9f);
        AllowDrop = true;
        try { Icon = Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetEntryAssembly().Location); } catch { }

        var projectLabel = new Label();
        projectLabel.Text = "Node.js proje klasörü (package.json olan klasörü buraya sürükleyebilirsiniz):";
        projectLabel.AutoSize = true;
        projectLabel.Location = new Point(16, 14);

        projectBox.SetBounds(16, 36, 508, 24);
        projectBox.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        projectBox.AllowDrop = true;
        browseButton.Text = "Gözat...";
        browseButton.SetBounds(532, 35, 92, 26);
        browseButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        browseButton.Click += (s, e) => BrowseProject();

        var outLabel = new Label();
        outLabel.Text = "Çıktı klasörü:";
        outLabel.AutoSize = true;
        outLabel.Location = new Point(16, 72);
        outBox.SetBounds(16, 94, 508, 24);
        outBox.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        outBox.Text = defaultOut;
        outButton.Text = "Değiştir...";
        outButton.SetBounds(532, 93, 92, 26);
        outButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        outButton.Click += (s, e) => BrowseOut();

        exeCheck.Text = "Tek exe (önerilen)";
        exeCheck.Checked = true;
        exeCheck.AutoSize = true;
        exeCheck.Location = new Point(16, 130);
        folderCheck.Text = "Klasör (Başlat.bat)";
        folderCheck.AutoSize = true;
        folderCheck.Location = new Point(190, 130);
        zipCheck.Text = "Zip";
        zipCheck.AutoSize = true;
        zipCheck.Location = new Point(360, 130);

        buildButton.Text = "Exe oluştur";
        buildButton.Font = new Font(Font.FontFamily, 11f, FontStyle.Bold);
        buildButton.SetBounds(16, 162, 608, 40);
        buildButton.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        buildButton.Click += (s, e) => { if (child == null) StartBuild(); else CancelBuild(); };

        statusLabel.Text = "Hazır.";
        statusLabel.AutoEllipsis = true;
        statusLabel.SetBounds(16, 212, 608, 20);
        statusLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        bar.SetBounds(16, 234, 608, 14);
        bar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        bar.Style = ProgressBarStyle.Continuous;

        summaryLabel.SetBounds(16, 254, 608, 36);
        summaryLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        summaryLabel.ForeColor = SystemColors.GrayText;

        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Both;
        logBox.WordWrap = false;
        logBox.Font = new Font("Consolas", 8.5f);
        logBox.BackColor = SystemColors.Window;
        logBox.SetBounds(16, 294, 608, 176);
        logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;

        openButton.Text = "Klasörü aç";
        openButton.SetBounds(16, 480, 120, 28);
        openButton.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
        openButton.Enabled = false;
        openButton.Click += (s, e) => OpenResultFolder();
        runButton.Text = "Exe'yi çalıştır";
        runButton.SetBounds(144, 480, 120, 28);
        runButton.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
        runButton.Enabled = false;
        runButton.Click += (s, e) => RunResult();

        Controls.AddRange(new Control[] {
            projectLabel, projectBox, browseButton, outLabel, outBox, outButton,
            exeCheck, folderCheck, zipCheck, buildButton, statusLabel, bar, summaryLabel, logBox, openButton, runButton
        });

        DragEventHandler enter = (s, e) => { e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) && child == null ? DragDropEffects.Copy : DragDropEffects.None; };
        DragEventHandler drop = (s, e) =>
        {
            var paths = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (paths == null || paths.Length == 0 || child != null) return;
            string p = paths[0];
            if (File.Exists(p)) p = Path.GetDirectoryName(p); // package.json bırakıldıysa klasörü
            projectBox.Text = p;
        };
        DragEnter += enter;
        DragDrop += drop;
        projectBox.DragEnter += enter;
        projectBox.DragDrop += drop;
        FormClosing += OnClosingWindow;

        using (var g = CreateGraphics())
        {
            float factor = g.DpiX / 96f;
            if (Math.Abs(factor - 1f) > 0.01f) Scale(new SizeF(factor, factor));
        }
    }

    // ------------------------------------------------------------------ seçimler

    void BrowseProject()
    {
        using (var dlg = new FolderBrowserDialog())
        {
            dlg.Description = "package.json bulunan Node.js proje klasörünü seçin";
            dlg.ShowNewFolderButton = false;
            if (Directory.Exists(projectBox.Text)) dlg.SelectedPath = projectBox.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) projectBox.Text = dlg.SelectedPath;
        }
    }

    void BrowseOut()
    {
        using (var dlg = new FolderBrowserDialog())
        {
            dlg.Description = "Çıktının yazılacağı klasörü seçin";
            if (Directory.Exists(outBox.Text)) dlg.SelectedPath = outBox.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) outBox.Text = dlg.SelectedPath;
        }
    }

    // ------------------------------------------------------------------ build

    void StartBuild()
    {
        string project = projectBox.Text.Trim().Trim('"');
        if (project.Length == 0)
        {
            MessageBox.Show(this, "Önce proje klasörünü seçin veya pencereye sürükleyin.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        bool isUrl = project.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || project.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || project.StartsWith("git@");
        if (!isUrl && !File.Exists(Path.Combine(project, "package.json")))
        {
            bool sub = false;
            foreach (string d in new[] { "server", "backend", "api", "app" })
                if (File.Exists(Path.Combine(Path.Combine(project, d), "package.json"))) sub = true;
            if (!sub)
            {
                MessageBox.Show(this, "Bu klasörde package.json yok:\n" + project + "\n\nNode.js projesinin kök klasörünü seçin.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }
        var formats = new List<string>();
        if (exeCheck.Checked) formats.Add("exe");
        if (folderCheck.Checked) formats.Add("klasor");
        if (zipCheck.Checked) formats.Add("zip");
        if (formats.Count == 0)
        {
            MessageBox.Show(this, "En az bir çıktı türü seçin.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        string outDir = outBox.Text.Trim().Trim('"');

        var args = new StringBuilder(cliPrefix);
        args.Append(' ').Append(Quote(project));
        args.Append(" --format ").Append(string.Join(",", formats.ToArray()));
        if (outDir.Length > 0) args.Append(" --out ").Append(Quote(outDir));
        args.Append(" --gui-protocol");

        var psi = new ProcessStartInfo(nodeExe, args.ToString());
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.WorkingDirectory = Directory.Exists(outDir) ? outDir : Environment.CurrentDirectory;
        psi.EnvironmentVariables["FORCE_COLOR"] = "0";
        psi.EnvironmentVariables["NO_COLOR"] = "1";

        logBox.Clear();
        summaryLabel.Text = "";
        preflightErrors.Clear();
        resultExe = null;
        resultDir = null;
        lastError = null;
        openButton.Enabled = false;
        runButton.Enabled = false;
        SetInputsEnabled(false);
        buildButton.Text = "İptal";
        statusLabel.ForeColor = SystemColors.ControlText;
        SetStatus("Başlatılıyor...");
        bar.Style = ProgressBarStyle.Marquee;

        try
        {
            child = new Process();
            child.StartInfo = psi;
            child.EnableRaisingEvents = true;
            child.OutputDataReceived += (s, e) => { if (e.Data != null) Post(() => OnLine(e.Data)); };
            child.ErrorDataReceived += (s, e) => { if (e.Data != null) Post(() => AppendLog(e.Data)); };
            // Exited, yönlendirilmiş çıktının son satırlarından önce gelebilir; WaitForExit() okuyucuların bitmesini bekler.
            child.Exited += (s, e) =>
            {
                try { ((Process)s).WaitForExit(); } catch { }
                Post(OnExited);
            };
            child.Start();
            child.StandardInput.Close();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            child = null;
            Finish(false, "Build başlatılamadı: " + ex.Message);
        }
    }

    void OnLine(string line)
    {
        if (!line.StartsWith(Prefix))
        {
            AppendLog(line);
            return;
        }
        Dictionary<string, object> msg;
        try { msg = json.Deserialize<Dictionary<string, object>>(line.Substring(Prefix.Length)); }
        catch { AppendLog(line); return; }

        if (msg.ContainsKey("step"))
        {
            SetStatus(Convert.ToString(msg["step"]));
            bar.Style = ProgressBarStyle.Marquee;
        }
        if (msg.ContainsKey("progress"))
        {
            var p = msg["progress"] as Dictionary<string, object>;
            if (p != null && p["total"] != null)
            {
                double received = Convert.ToDouble(p["received"]);
                double total = Convert.ToDouble(p["total"]);
                if (total > 0)
                {
                    bar.Style = ProgressBarStyle.Continuous;
                    bar.Value = Math.Max(0, Math.Min(100, (int)(received * 100 / total)));
                    SetStatus("DB indiriliyor: " + p["key"] + "  " + (int)(received / 1048576) + " / " + (int)(total / 1048576) + " MB");
                }
            }
        }
        if (msg.ContainsKey("preflight"))
        {
            var pf = msg["preflight"] as Dictionary<string, object>;
            if (pf != null) ShowPreflight(pf);
        }
        if (msg.ContainsKey("error"))
        {
            lastError = Convert.ToString(msg["error"]);
        }
        if (msg.ContainsKey("done"))
        {
            resultExe = msg["exe"] as string;
            string folder = msg["folder"] as string;
            string zip = msg["zip"] as string;
            resultDir = resultExe != null ? Path.GetDirectoryName(resultExe) : folder != null ? Path.GetDirectoryName(folder) : zip != null ? Path.GetDirectoryName(zip) : null;
        }
    }

    void ShowPreflight(Dictionary<string, object> pf)
    {
        var parts = new List<string>();
        if (pf["app"] != null) parts.Add("Uygulama: " + pf["app"] + (pf["port"] != null ? " (port " + pf["port"] + ")" : ""));
        var dbs = pf["databases"] as ArrayList;
        if (dbs != null && dbs.Count > 0)
        {
            var names = new List<string>();
            foreach (object o in dbs)
            {
                var d = o as Dictionary<string, object>;
                if (d != null) names.Add(d["type"] + " " + d["version"]);
            }
            parts.Add("Gömülecek veritabanları: " + string.Join(", ", names.ToArray()));
        }
        else
        {
            parts.Add("Veritabanı gömülmeyecek");
        }
        summaryLabel.Text = string.Join("   •   ", parts.ToArray());
        var errs = pf["errors"] as ArrayList;
        if (errs != null) foreach (object e in errs) preflightErrors.Add(Convert.ToString(e));
    }

    void OnExited()
    {
        if (child == null) return;
        int code;
        try { code = child.ExitCode; } catch { code = -1; }
        child.Dispose();
        child = null;
        if (closingAfterCancel)
        {
            Close();
            return;
        }
        if (code == 0 && resultDir != null)
        {
            Finish(true, resultExe != null ? "Tamamlandı: " + resultExe : "Tamamlandı: " + resultDir);
        }
        else
        {
            string msg = lastError ?? ("Build başarısız (çıkış kodu " + code + ")");
            Finish(false, msg);
            if (preflightErrors.Count > 0)
            {
                MessageBox.Show(this, "Proje paketlenemedi:\n\n• " + string.Join("\n• ", preflightErrors.ToArray()), Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }

    void Finish(bool ok, string message)
    {
        bar.Style = ProgressBarStyle.Continuous;
        bar.Value = ok ? 100 : 0;
        statusLabel.ForeColor = ok ? Color.FromArgb(0, 128, 0) : Color.FromArgb(192, 0, 0);
        SetStatus(message);
        buildButton.Text = "Exe oluştur";
        SetInputsEnabled(true);
        openButton.Enabled = ok && resultDir != null;
        runButton.Enabled = ok && resultExe != null;
        if (ok) Activate();
    }

    void CancelBuild()
    {
        if (child == null) return;
        if (MessageBox.Show(this, "Build iptal edilsin mi?", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        lastError = "İptal edildi";
        KillTree();
    }

    void KillTree()
    {
        try
        {
            var kill = new ProcessStartInfo("taskkill.exe", "/T /F /PID " + child.Id);
            kill.CreateNoWindow = true;
            kill.UseShellExecute = false;
            using (var p = Process.Start(kill)) p.WaitForExit(15000);
        }
        catch { }
    }

    void OnClosingWindow(object sender, FormClosingEventArgs e)
    {
        if (child == null || closingAfterCancel) return;
        if (MessageBox.Show(this, "Build devam ediyor. İptal edip kapatılsın mı?", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
        {
            e.Cancel = true;
            return;
        }
        e.Cancel = true;
        closingAfterCancel = true;
        KillTree();
    }

    // ------------------------------------------------------------------ sonuç

    void OpenResultFolder()
    {
        if (resultDir == null) return;
        if (resultExe != null) Process.Start("explorer.exe", "/select," + Quote(resultExe));
        else Process.Start("explorer.exe", Quote(resultDir));
    }

    void RunResult()
    {
        if (resultExe == null || !File.Exists(resultExe)) return;
        var psi = new ProcessStartInfo(resultExe);
        psi.UseShellExecute = true;
        psi.WorkingDirectory = Path.GetDirectoryName(resultExe);
        Process.Start(psi);
    }

    // ------------------------------------------------------------------ yardımcılar

    void SetInputsEnabled(bool on)
    {
        projectBox.Enabled = on;
        outBox.Enabled = on;
        browseButton.Enabled = on;
        outButton.Enabled = on;
        exeCheck.Enabled = on;
        folderCheck.Enabled = on;
        zipCheck.Enabled = on;
    }

    void SetStatus(string text)
    {
        statusLabel.Text = text;
    }

    void AppendLog(string line)
    {
        if (logBox.TextLength > 400000) logBox.Text = logBox.Text.Substring(logBox.TextLength - 200000);
        logBox.AppendText(line + Environment.NewLine);
    }

    void Post(Action a)
    {
        if (IsDisposed) return;
        try { BeginInvoke(a); } catch (InvalidOperationException) { }
    }

    static string Quote(string s)
    {
        // CommandLineToArgvW kuralı: sondaki ters bölüler kapanış tırnağından önce ikilenir
        string trimmed = s.TrimEnd('\\');
        int slashes = s.Length - trimmed.Length;
        return "\"" + trimmed + new string('\\', slashes * 2) + "\"";
    }
}
#endif
