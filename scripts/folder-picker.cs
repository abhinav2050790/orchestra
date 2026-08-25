// Instant folder picker for the Orchestra hub - no PowerShell overhead.
// Build: scripts\build-picker.ps1
// Prints the selected path to stdout; exit 1 on cancel/error.
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class P
{
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    [STAThread]
    static int Main()
    {
        try
        {
            // offscreen 1x1 owner breaks the hidden-window inheritance from CreateNoWindow parents
            var o = new Form
            {
                TopMost = true,
                StartPosition = FormStartPosition.Manual,
                Location = new Point(-32000, -32000),
                Size = new Size(1, 1),
                ShowInTaskbar = false,
            };
            o.Show();
            Application.DoEvents();
            // a background-spawned process loses the foreground battle to the active
            // browser, leaving the modal dialog painted behind it — steal focus back
            for (var i = 0; i < 10 && GetForegroundWindow() != o.Handle; i++)
            {
                SetForegroundWindow(o.Handle);
                o.Activate();
                Application.DoEvents();
                System.Threading.Thread.Sleep(50);
            }
            using (var d = new FolderBrowserDialog { Description = "Assign ORCHESTRA workspace folder" })
            {
                if (d.ShowDialog(o) == DialogResult.OK) { Console.Out.Write(d.SelectedPath); return 0; }
            }
            return 1;
        }
        catch { return 2; }
    }
}
