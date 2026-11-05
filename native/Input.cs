using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal static class DesktopInput
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey, Scan;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputData Data;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    private static readonly HashSet<int> Keys = new HashSet<int>();
    private static readonly HashSet<int> Buttons = new HashSet<int>();
    private static readonly uint[] DownFlags = { 0x02, 0x20, 0x08, 0x80, 0x80 };
    private static readonly uint[] UpFlags = { 0x04, 0x40, 0x10, 0x100, 0x100 };
    private static readonly int InputSize = Marshal.SizeOf(typeof(Input));
    private const uint AbsoluteMove = 0xc001; // MOVE | VIRTUALDESK | ABSOLUTE
    private static int desktopLeft, desktopTop, desktopWidth, desktopHeight;

    private static bool Mouse(uint flags, int data, int x = 0, int y = 0)
    {
        Input input = new Input();
        input.Data.Mouse.Flags = flags;
        input.Data.Mouse.Data = unchecked((uint)data);
        if ((flags & AbsoluteMove) == AbsoluteMove)
        {
            input.Data.Mouse.X = (int)((x - desktopLeft + 0.5) * 65536 / desktopWidth);
            input.Data.Mouse.Y = (int)((y - desktopTop + 0.5) * 65536 / desktopHeight);
        }
        return SendInput(1, new[] { input }, InputSize) == 1;
    }

    private static bool Key(int scan, bool down)
    {
        Input input = new Input();
        input.Type = 1;
        input.Data.Keyboard.Scan = (ushort)(scan & 0xff);
        input.Data.Keyboard.Flags = 0x08;
        if (scan > 0xff) input.Data.Keyboard.Flags |= 0x01;
        if (!down) input.Data.Keyboard.Flags |= 0x02;
        return SendInput(1, new[] { input }, InputSize) == 1;
    }

    private static int ButtonData(int button)
    {
        return button < 3 ? 0 : button - 2;
    }

    private static bool Release()
    {
        Keys.RemoveWhere(scan => Key(scan, false));
        Buttons.RemoveWhere(button => Mouse(UpFlags[button], ButtonData(button)));
        return Keys.Count == 0 && Buttons.Count == 0;
    }

    private static bool Execute(string line)
    {
        string[] fields = line.Split(' ');
        int[] args = new int[fields.Length - 1];
        for (int i = 0; i < args.Length; i++)
            if (!Int32.TryParse(fields[i + 1], out args[i])) return false;

        switch (fields[0])
        {
            case "R":
                return args.Length == 0 && Release();
            case "K":
                if (args.Length != 2 || args[0] < 1 || args[0] > 0x17f || (args[0] & 0xff) == 0 ||
                    args[0] >= 0x80 && args[0] <= 0x100 || (args[1] != 0 && args[1] != 1))
                    return false;
                bool keyDown = args[1] == 1;
                if (!keyDown && !Keys.Contains(args[0])) return true;
                if (!Key(args[0], keyDown)) return false;
                if (keyDown) Keys.Add(args[0]);
                else Keys.Remove(args[0]);
                return true;
            case "M":
                return args.Length == 2 && InsideDesktop(args[0], args[1]) &&
                    Mouse(AbsoluteMove, 0, args[0], args[1]);
            case "B":
                if (args.Length != 4 || args[2] < 0 || args[2] >= DownFlags.Length ||
                    (args[3] != 0 && args[3] != 1)) return false;
                int button = args[2];
                bool buttonDown = args[3] == 1;
                if (!buttonDown && !Buttons.Contains(button)) return true;
                if (!InsideDesktop(args[0], args[1]) ||
                    !Mouse(AbsoluteMove | (buttonDown ? DownFlags[button] : UpFlags[button]),
                        ButtonData(button), args[0], args[1]))
                    return false;
                if (buttonDown) Buttons.Add(button);
                else Buttons.Remove(button);
                return true;
            case "W":
                if (args.Length != 4 || Math.Abs((long)args[2]) > 1200 || Math.Abs((long)args[3]) > 1200 ||
                    !InsideDesktop(args[0], args[1])) return false;
                return (args[2] == 0 || Mouse(AbsoluteMove | 0x1000, args[2], args[0], args[1])) &&
                       (args[3] == 0 || Mouse(AbsoluteMove | 0x0800, args[3], args[0], args[1]));
            default:
                return false;
        }
    }

    private static bool InsideDesktop(int x, int y)
    {
        return x >= desktopLeft && (long)x - desktopLeft < desktopWidth &&
            y >= desktopTop && (long)y - desktopTop < desktopHeight;
    }

    private static int Main(string[] args)
    {
        if (InputSize != 40 || args.Length != 4 ||
            !Int32.TryParse(args[0], out desktopLeft) || !Int32.TryParse(args[1], out desktopTop) ||
            !Int32.TryParse(args[2], out desktopWidth) || !Int32.TryParse(args[3], out desktopHeight) ||
            desktopWidth < 1 || desktopHeight < 1) return 1;
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (!Execute(line))
                {
                    Console.Error.WriteLine("Windows rejected a remote input command.");
                    return 1;
                }
            }
            return 0;
        }
        finally
        {
            Release();
        }
    }
}
