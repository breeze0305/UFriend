using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace UFriend.Native
{
    internal static class Program
    {
        [STAThread]
        private static int Main()
        {
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                using (ClipboardWindow listener = new ClipboardWindow())
                {
                    Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs args)
                    {
                        args.Cancel = true;
                        listener.RequestStop();
                    };

                    JsonOutput.Write("{\"type\":\"ready\"}");

                    // A pipe lets the parent unregister cleanly; EOF also means stop.
                    Thread controlThread = new Thread(delegate()
                    {
                        try
                        {
                            string command;
                            while ((command = Console.ReadLine()) != null)
                            {
                                if (String.Equals(command.Trim(), "stop", StringComparison.OrdinalIgnoreCase))
                                    break;
                            }
                        }
                        catch (Exception exception)
                        {
                            Environment.ExitCode = 2;
                            JsonOutput.TryError("Control pipe failed: " + exception.Message);
                        }
                        finally
                        {
                            listener.RequestStop();
                        }
                    });
                    controlThread.IsBackground = true;
                    controlThread.Name = "UFriend clipboard control";
                    controlThread.Start();

                    Application.Run();
                }
                return Environment.ExitCode;
            }
            catch (Exception exception)
            {
                JsonOutput.TryError(exception.Message);
                return 1;
            }
        }
    }

    internal sealed class ClipboardWindow : NativeWindow, IDisposable
    {
        private const int WmClipboardUpdate = 0x031D;
        private const int WmStop = 0x8001;
        private const uint CfBitmap = 2;
        private const uint CfDib = 8;
        private const uint CfDibV5 = 17;
        private bool registered;
        private uint lastSequence;

        internal ClipboardWindow()
        {
            CreateParams parameters = new CreateParams();
            parameters.Caption = "UFriend.ClipboardListener";
            parameters.Parent = new IntPtr(-3); // HWND_MESSAGE: no visible window.
            CreateHandle(parameters);

            // Read only the sequence, never current clipboard data or formats.
            lastSequence = GetClipboardSequenceNumber();
            if (!AddClipboardFormatListener(Handle))
            {
                int error = Marshal.GetLastWin32Error();
                DestroyHandle();
                throw new Win32Exception(error, "Could not register clipboard notifications.");
            }
            registered = true;
        }

        internal void RequestStop()
        {
            IntPtr handle = Handle;
            if (handle != IntPtr.Zero)
                PostMessage(handle, WmStop, IntPtr.Zero, IntPtr.Zero);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmStop)
            {
                Application.ExitThread();
                message.Result = IntPtr.Zero;
                return;
            }

            if (message.Msg == WmClipboardUpdate)
            {
                try
                {
                    NotifyImageChange();
                }
                catch (Exception exception)
                {
                    Environment.ExitCode = 2;
                    JsonOutput.TryError("Clipboard notification failed: " + exception.Message);
                    Application.ExitThread();
                }
                message.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref message);
        }

        private void NotifyImageChange()
        {
            uint sequence = GetClipboardSequenceNumber();
            if (sequence == 0 || sequence == lastSequence)
                return;

            bool hasImage = IsClipboardFormatAvailable(CfDib)
                || IsClipboardFormatAvailable(CfDibV5)
                || IsClipboardFormatAvailable(CfBitmap);

            // A newer change has its own notification; do not attach its formats
            // to an older sequence. Rapid updates may coalesce naturally.
            if (GetClipboardSequenceNumber() != sequence)
                return;

            lastSequence = sequence;
            if (hasImage)
                JsonOutput.Write("{\"type\":\"clipboard\",\"sequence\":"
                    + sequence.ToString(CultureInfo.InvariantCulture) + "}");
        }

        public void Dispose()
        {
            if (registered)
            {
                registered = false;
                if (!RemoveClipboardFormatListener(Handle))
                {
                    Environment.ExitCode = 2;
                    JsonOutput.TryError("Could not remove clipboard listener (Win32 "
                        + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ").");
                }
            }
            if (Handle != IntPtr.Zero)
                DestroyHandle();
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AddClipboardFormatListener(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RemoveClipboardFormatListener(IntPtr window);

        [DllImport("user32.dll")]
        private static extern uint GetClipboardSequenceNumber();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsClipboardFormatAvailable(uint format);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    }

    internal static class JsonOutput
    {
        private static readonly object Sync = new object();

        internal static void Write(string json)
        {
            lock (Sync)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        internal static void TryError(string message)
        {
            try
            {
                Write("{\"type\":\"error\",\"message\":" + Quote(message) + "}");
            }
            catch
            {
                // A closed stdout pipe cannot receive an error; the exit code remains nonzero.
            }
        }

        private static string Quote(string value)
        {
            StringBuilder escaped = new StringBuilder("\"");
            foreach (char character in value ?? String.Empty)
            {
                if (character == '"' || character == '\\')
                    escaped.Append('\\').Append(character);
                else if (character < 0x20)
                    escaped.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                else
                    escaped.Append(character);
            }
            return escaped.Append('"').ToString();
        }
    }
}
