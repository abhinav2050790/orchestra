// Orchestra launcher — double-click: starts the hub (hidden) if needed, opens the board.
// Build:
//   csc /nologo /target:winexe /out:Orchestra.exe /r:System.dll /r:System.Windows.Forms.dll orchestra-launcher.cs
using System;
using System.Diagnostics;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    const string Root = @"D:\ochrestra";
    const string Url = "http://127.0.0.1:8787";

    [STAThread]
    static void Main()
    {
        if (!IsUp())
        {
            try { StartHub(); }
            catch (Exception ex) { Msg("Could not start the Orchestra hub:\n\n" + ex.Message); return; }
            int waited = 0;
            while (!IsUp() && waited < 15000) { Thread.Sleep(300); waited += 300; }
            if (!IsUp()) { Msg("The Orchestra hub did not respond within 15s.\nCheck that Node.js is installed and port 8787 is free."); return; }
        }
        OpenBrowser();
    }

    static bool IsUp()
    {
        try { using (var wc = new WebClient()) { wc.DownloadString(Url + "/api/health"); return true; } }
        catch { return false; }
    }

    static void StartHub()
    {
        var psi = new ProcessStartInfo();
        psi.FileName = "node";
        psi.Arguments = "server/hub.js";
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true; // hub runs silently in the background
        Process.Start(psi);
    }

    static void OpenBrowser()
    {
        try { Process.Start(Url); }
        catch { Msg("Orchestra is running — open " + Url + " manually."); }
    }

    static void Msg(string m) { MessageBox.Show(m, "Orchestra", MessageBoxButtons.OK, MessageBoxIcon.Error); }
}
