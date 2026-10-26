using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using static Web2Term.WindowsHelper.ApplicationInterop;
using static Web2Term.WindowsHelper.ControlTreeInterop;
using static Web2Term.WindowsHelper.WindowFocusInterop;
using static Web2Term.WindowsHelper.WindowInterop;

namespace Web2Term.WindowsHelper;

/** Built-in UIA3 COM client. Reads stay read-only; input handlers explicitly acquire bounded capabilities on a freshly resolved node. */
internal sealed class WindowsControlTreeBackend : IControlTreeBackend
{
    public CaptureRect Bounds(WindowSelection window, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        WindowsDpiContext.RequirePhysicalCoordinates();
        Marshal.ThrowExceptionForHR(ControlTreeInterop.DwmGetWindowAttribute(Parse(window.Window.Handle), 9, out Rect rect, (uint)Marshal.SizeOf<Rect>()));
        return new(rect.Left, rect.Top, checked(rect.Right - rect.Left), checked(rect.Bottom - rect.Top));
    }
    public IControlTreeSession Open(WindowSelection window, Action checkpoint, CancellationToken cancellation) => new Session(Parse(window.Window.Handle), checkpoint, cancellation);
    private static IntPtr Parse(string value) => (IntPtr)long.Parse(value.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
    private sealed class Node(IUIAutomationElement element, bool owns = true) : IControlNode
    {
        internal readonly IUIAutomationElement Element = element;
        private bool disposed;
        public void Dispose() { if (disposed) return; disposed = true; if (owns) Release(Element); }
    }
    private sealed class Session : IControlTreeSession, IControlClickSession, IControlTextSession, IControlKeySession, IControlPointerSession
    {
        private static readonly (int Property, string Name)[] Available = [(30031, "invoke"), (30037, "selection"), (30043, "value"), (30033, "range_value"), (30034, "scroll"),
            (30028, "expand_collapse"), (30030, "grid"), (30029, "grid_item"), (30032, "multiple_view"), (30036, "selection_item"), (30038, "table"), (30039, "table_item"),
            (30040, "text"), (30041, "toggle"), (30042, "transform"), (30044, "window"), (30035, "scroll_item"), (30090, "legacy_accessible")];
        private readonly IntPtr window;
        private readonly Action checkpoint;
        private readonly CancellationToken cancellation;
        private object? automationObject;
        private IUIAutomation automation = null!;
        private IUIAutomationCacheRequest cache = null!;
        private IUIAutomationTreeWalker controlWalker = null!, rawWalker = null!;
        private IUIAutomationElement root = null!;
        internal Session(IntPtr window, Action checkpoint, CancellationToken cancellation)
        {
            this.window = window; this.checkpoint = checkpoint; this.cancellation = cancellation;
            try
            {
                Check(); automationObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true)!);
                automation = (IUIAutomation)automationObject!;
                Check(); Marshal.ThrowExceptionForHR(automation.CreateCacheRequest(out cache));
                Check(); Marshal.ThrowExceptionForHR(cache.SetTreeScope(1)); // Element only: never bulk-fetch an unbounded subtree.
                foreach (int property in new[] { 30000, 30003, 30008, 30010, 30019, 30020, 30022, 30001, 30079 }.Concat(Available.Select(item => item.Property)))
                { Check(); Marshal.ThrowExceptionForHR(cache.AddProperty(property)); }
                Check(); Marshal.ThrowExceptionForHR(automation.GetControlViewWalker(out controlWalker));
                Check(); Marshal.ThrowExceptionForHR(automation.GetRawViewWalker(out rawWalker));
                Check(); Marshal.ThrowExceptionForHR(automation.ElementFromHandleBuildCache(window, cache, out root));
                if (root == null || Handle(root, true) != window) throw new COMException();
            }
            catch { Dispose(); throw; }
        }
        private void Check() { HelperInputState.Check(cancellation); checkpoint(); }
        public IControlNode Root() { Check(); return new Node(root, false); }
        public IControlNode? FirstChild(IControlNode node)
        { Check(); int hr = controlWalker.GetFirstChildElementBuildCache(((Node)node).Element, cache, out IUIAutomationElement? child); return Wrap(hr, child); }
        public IControlNode? NextSibling(IControlNode node)
        { Check(); int hr = controlWalker.GetNextSiblingElementBuildCache(((Node)node).Element, cache, out IUIAutomationElement? sibling); return Wrap(hr, sibling); }
        private IControlNode? Wrap(int hr, IUIAutomationElement? element)
        {
            try { Marshal.ThrowExceptionForHR(hr); Check(); return element == null ? null : new Node(element); }
            catch { Release(element); throw; }
        }
        private object? Property(IUIAutomationElement element, int property, bool cached, bool ignoreDefault = true)
        {
            Check();
            int hr = cached ? element.GetCachedPropertyValueEx(property, ignoreDefault, out object value) : element.GetCurrentPropertyValueEx(property, ignoreDefault, out value);
            if (hr >= 0) return value;
            Release(value); return null;
        }
        private bool? Boolean(IUIAutomationElement element, int property, bool cached, bool ignoreDefault = true)
        {
            object? value = Property(element, property, cached, ignoreDefault);
            try { return value is bool flag ? flag : null; } finally { Release(value); }
        }
        private int? Integer(IUIAutomationElement element, int property, bool cached)
        {
            object? value = Property(element, property, cached);
            try { return value is int number ? number : null; } finally { Release(value); }
        }
        private IntPtr Handle(IUIAutomationElement element, bool cached) => Integer(element, 30020, cached) is int handle ? new IntPtr(handle) : IntPtr.Zero;
        private string? Key(IUIAutomationElement element, bool cached)
        {
            object? value = Property(element, 30000, cached);
            try { return value is int[] values && values.Length is > 0 and <= 64 ? string.Join(':', values) : null; } finally { Release(value); }
        }
        private ControlBox? Box(IUIAutomationElement element)
        {
            object? value = Property(element, 30001, true);
            try { return value is double[] values && values.Length == 4 ? new(values[0], values[1], values[2], values[3]) : null; } finally { Release(value); }
        }
        public RawControl Read(IControlNode node)
        {
            IUIAutomationElement element = ((Node)node).Element;
            IntPtr handle = Handle(element, true);
            bool inWindow = handle == IntPtr.Zero || IsWindow(handle) && GetAncestor(handle, 2) == window;
            string? key = Key(element, true);
            int? type = Integer(element, 30003, true);
            bool? password = Boolean(element, 30019, true, false);
            bool? enabled = Boolean(element, 30010, true), focused = Boolean(element, 30008, true), offscreen = Boolean(element, 30022, true);
            ControlBox? box = Box(element);
            if (!inWindow || offscreen != false)
                return new(key, type, null, password, enabled, focused, offscreen, null, box, [], false, inWindow);
            string? name = null;
            if (password == false)
            {
                password = Boolean(element, 30019, false, false);
                if (password == false)
                {
                    object? value = Property(element, 30005, false);
                    try { name = value as string; } finally { Release(value); }
                    password = Boolean(element, 30019, false, false);
                    if (password != false) name = null;
                }
            }
            List<string> patterns = [];
            bool complete = true;
            foreach (var item in Available)
            {
                bool? supported = Boolean(element, item.Property, true, false);
                if (supported == true) patterns.Add(item.Name); else if (supported == null) complete = false;
            }
            return new(key, type, name, password, enabled, focused, offscreen,
                patterns.Contains("selection_item") ? Boolean(element, 30079, true) : null, box, patterns.ToArray(), complete, inWindow);
        }
        private bool Same(IUIAutomationElement first, IUIAutomationElement second)
        { Check(); Marshal.ThrowExceptionForHR(automation.CompareElements(first, second, out bool same)); return same; }
        public ControlFocus Focus()
        {
            IUIAutomationElement? cursor = null, latest = null;
            try
            {
                Check(); Marshal.ThrowExceptionForHR(automation.GetFocusedElement(out cursor));
                if (cursor == null || Boolean(cursor, 30008, false) != true) return new("unavailable");
                string? key = Key(cursor, false);
                if (key == null) return new("unavailable");
                string status = "unavailable";
                for (int depth = 0; depth < 32 && cursor != null; depth++)
                {
                    Check(); if (Same(cursor, root)) { status = "inside_target"; break; }
                    IntPtr handle = Handle(cursor, false);
                    if (handle != IntPtr.Zero && IsWindow(handle) && GetAncestor(handle, 2) != window) { status = "outside_target"; break; }
                    Check(); int hr = rawWalker.GetParentElement(cursor, out IUIAutomationElement? parent);
                    if (hr < 0) { Release(parent); Marshal.ThrowExceptionForHR(hr); }
                    Release(cursor); cursor = parent;
                    if (cursor == null) status = "outside_target";
                }
                Check(); Marshal.ThrowExceptionForHR(automation.GetFocusedElement(out latest));
                if (latest == null || Key(latest, false) != key || Boolean(latest, 30008, false) != true) return new("unavailable");
                return new(status, key);
            }
            catch (ControlBudgetExceeded) { throw; }
            catch (OperationCanceledException) { throw; }
            catch { return new("unavailable"); }
            finally { Release(cursor); Release(latest); }
        }
        private bool StillFocused(IUIAutomationElement element)
        {
            IUIAutomationElement? focused = null;
            try { Check(); Marshal.ThrowExceptionForHR(automation.GetFocusedElement(out focused)); return focused != null && Same(element, focused) && Boolean(element, 30008, false) == true; }
            finally { Release(focused); }
        }
        public bool TextTargetCurrent(IControlNode node, ControlRow row, string[] ancestors)
            => KeyTargetCurrent(node, row, ancestors) && TextReadOnly(((Node)node).Element) == false;
        public bool PointerTargetCurrent(IControlNode node, ControlRow row, string[] ancestors, CoordinatePoint point)
        {
            Check(); int result = ((Node)node).Element.BuildUpdatedCache(cache, out IUIAutomationElement fresh);
            if (result < 0) { Release(fresh); Marshal.ThrowExceptionForHR(result); }
            if (fresh == null) return false;
            using Node current = new(fresh);
            return ControlTreeService.MatchesRaw(row, Read(current)) && AncestorsMatch(current, ancestors) && AtPoint(current, point);
        }
        public bool KeyTargetCurrent(IControlNode node, ControlRow row, string[] ancestors)
        {
            IUIAutomationElement element = ((Node)node).Element;
            if (!StillFocused(element) || !AncestorsMatch(node, ancestors) || Boolean(element, 30010, false) != true ||
                Boolean(element, 30022, false) != false || Boolean(element, 30019, false, false) != row.password ||
                Boolean(element, 30009, false, false) != true || Integer(element, 30003, false) != row.control_type) return false;
            object? raw = Property(element, 30001, false);
            try { return raw is double[] box && box.Length == 4 && new ControlBox(box[0], box[1], box[2], box[3]) == row.bounds; }
            finally { Release(raw); }
        }
        private bool? TextReadOnly(IUIAutomationElement element)
        {
            bool? value = Boolean(element, 30046, false); // UIA_ValueIsReadOnlyPropertyId; never reads the value.
            if (value != null) return value;
            object? pattern = null, attribute = null; IUIAutomationTextRange? document = null;
            try {
                Check(); Marshal.ThrowExceptionForHR(element.GetCurrentPattern(10014, out pattern));
                if (pattern is not IUIAutomationTextPattern text) return null;
                Check(); Marshal.ThrowExceptionForHR(text.GetDocumentRange(out document));
                Check(); Marshal.ThrowExceptionForHR(document.GetAttributeValue(40015, out attribute)); // UIA_IsReadOnlyAttributeId.
                return attribute is bool flag ? flag : null;
            }
            finally { Release(attribute); Release(document); Release(pattern); }
        }
        public IPreparedTextValue? PrepareTextValue(IControlNode node)
        {
            Check(); int hr = ((Node)node).Element.GetCurrentPattern(10002, out object? pattern);
            if (hr == unchecked((int)0x80040204) || hr >= 0 && pattern is not IUIAutomationValuePattern) { Release(pattern); return null; }
            if (hr < 0) { Release(pattern); Marshal.ThrowExceptionForHR(hr); }
            return new PreparedTextValue((IUIAutomationValuePattern)pattern!);
        }
        private sealed class PreparedTextValue(IUIAutomationValuePattern pattern) : IPreparedTextValue
        {
            private bool used, disposed;
            public bool Writable => !disposed && pattern.GetCurrentIsReadOnly(out bool readOnly) >= 0 && !readOnly;
            public int Set(string text) { if (used || disposed || !Writable) throw new InvalidOperationException(); HelperInputState.Check(CancellationToken.None); used = true; return pattern.SetValue(text); }
            public void Dispose() { if (!disposed) { disposed = true; Release(pattern); } }
        }
        public TextSnapshot? ReadTextSnapshot(IControlNode node, bool selection)
        {
            IUIAutomationElement element = ((Node)node).Element;
            object? pattern = null; IUIAutomationTextRange? full = null, selected = null, prefix = null, suffix = null;
            IUIAutomationTextRangeArray? ranges = null;
            string ReadRange(IUIAutomationTextRange range) {
                Check(); if (Boolean(element, 30019, false, false) != false || !StillFocused(element)) throw new InvalidOperationException();
                Marshal.ThrowExceptionForHR(range.GetText(16385, out string value));
                if (value.Length > 16384 || Boolean(element, 30019, false, false) != false || !StillFocused(element)) throw new InvalidOperationException();
                return value;
            }
            try {
                if (Boolean(element, 30019, false, false) != false || !StillFocused(element)) return null;
                Check(); Marshal.ThrowExceptionForHR(element.GetCurrentPattern(10014, out pattern));
                if (pattern is not IUIAutomationTextPattern text) return null;
                Check(); Marshal.ThrowExceptionForHR(text.GetDocumentRange(out full));
                string content = ReadRange(full);
                string left = "", right = "";
                if (selection) {
                    Check(); Marshal.ThrowExceptionForHR(text.GetSelection(out ranges));
                    Check(); Marshal.ThrowExceptionForHR(ranges.GetLength(out int count)); if (count != 1) return null;
                    Check(); Marshal.ThrowExceptionForHR(ranges.GetElement(0, out selected));
                    Check(); Marshal.ThrowExceptionForHR(full.Clone(out prefix));
                    Check(); Marshal.ThrowExceptionForHR(prefix.MoveEndpointByRange(1, selected, 0));
                    left = ReadRange(prefix);
                    Check(); Marshal.ThrowExceptionForHR(full.Clone(out suffix));
                    Check(); Marshal.ThrowExceptionForHR(suffix.MoveEndpointByRange(0, selected, 1));
                    right = ReadRange(suffix);
                    string middle = ReadRange(selected);
                    if (left.Length > 16384 || right.Length > 16384 || TextInputProtocol.Canonical(left + middle + right) != TextInputProtocol.Canonical(content)) return null;
                }
                // Detect changing content during the multi-call snapshot; never certify a mixed read.
                string last = ReadRange(full);
                if (last != content || Boolean(element, 30019, false, false) != false || !StillFocused(element)) return null;
                return new(content, left, right);
            }
            catch (OperationCanceledException) { throw; }
            catch (ControlBudgetExceeded) { throw; }
            catch { return null; }
            finally { Release(suffix); Release(prefix); Release(selected); Release(ranges); Release(full); Release(pattern); }
        }
        public bool AncestorsMatch(IControlNode node, string[] expectedKeys)
        {
            IUIAutomationElement? cursor = ((Node)node).Element;
            bool owns = false;
            try {
                for (int index = 0; index < expectedKeys.Length; index++) {
                    Check(); if (cursor == null || Key(cursor, false) != expectedKeys[index]) return false;
                    if (index == expectedKeys.Length - 1) return Same(cursor, root);
                    Marshal.ThrowExceptionForHR(controlWalker.GetParentElement(cursor, out IUIAutomationElement? parent));
                    if (owns) Release(cursor); cursor = parent; owns = true;
                }
                return false;
            }
            finally { if (owns) Release(cursor); }
        }
        public bool AtPoint(IControlNode node, CoordinatePoint point)
        {
            IUIAutomationElement? hit = null;
            try {
                Check(); Marshal.ThrowExceptionForHR(automation.ElementFromPoint(new WindowFocusInterop.Point { X = point.x, Y = point.y }, out hit));
                for (int depth = 0; depth < 32 && hit != null; depth++) {
                    Check(); if (Same(hit, ((Node)node).Element)) return true;
                    if (Same(hit, root)) return false;
                    Marshal.ThrowExceptionForHR(rawWalker.GetParentElement(hit, out IUIAutomationElement? parent));
                    Release(hit); hit = parent;
                }
                return false;
            }
            finally { Release(hit); }
        }
        public IPreparedControlClick? PrepareClick(IControlNode node, string pattern)
        {
            Check(); int patternId = pattern switch { "invoke" => 10000, "toggle" => 10015, "select" => 10010, _ => throw new InvalidDataException() };
            int result = ((Node)node).Element.GetCurrentPattern(patternId, out object? value);
            bool applicable = pattern switch { "invoke" => value is IUIAutomationInvokePattern, "toggle" => value is IUIAutomationTogglePattern, "select" => value is IUIAutomationSelectionItemPattern, _ => false };
            if (result == unchecked((int)0x80040204) || result >= 0 && !applicable) { Release(value); return null; }
            if (result < 0) { Release(value); Marshal.ThrowExceptionForHR(result); }
            return new PreparedClick(value!, pattern);
        }
        private sealed class PreparedClick(object value, string pattern) : IPreparedControlClick
        {
            private bool invoked, disposed;
            public int Invoke() {
                if (invoked || disposed) throw new InvalidOperationException(); HelperInputState.Check(CancellationToken.None); invoked = true;
                return pattern switch { "invoke" => ((IUIAutomationInvokePattern)value).Invoke(), "toggle" => ((IUIAutomationTogglePattern)value).Toggle(), "select" => ((IUIAutomationSelectionItemPattern)value).Select(), _ => throw new InvalidDataException() };
            }
            public void Dispose() { if (!disposed) { disposed = true; Release(value); } }
        }
        public RawSelection Selection(IControlNode node, int maximum)
        {
            IUIAutomationElement element = ((Node)node).Element;
            object? pattern = null;
            IUIAutomationTextRangeArray? ranges = null;
            try
            {
                if (Boolean(element, 30019, false, false) != false) return new("protected");
                if (!StillFocused(element)) return new("changed");
                Check(); Marshal.ThrowExceptionForHR(element.GetCurrentPattern(10014, out pattern));
                if (pattern is not IUIAutomationTextPattern textPattern) return new("unsupported");
                Check(); Marshal.ThrowExceptionForHR(textPattern.GetSelection(out ranges));
                Check(); Marshal.ThrowExceptionForHR(ranges.GetLength(out int count));
                if (count < 0) return new("unavailable");
                StringBuilder text = new();
                bool truncated = count > 4;
                for (int index = 0; index < Math.Min(count, 4); index++)
                {
                    if (text.Length >= maximum) { truncated = true; break; }
                    IUIAutomationTextRange? range = null;
                    try
                    {
                        Check(); Marshal.ThrowExceptionForHR(ranges.GetElement(index, out range));
                        if (Boolean(element, 30019, false, false) != false) return new("protected");
                        if (!StillFocused(element)) return new("changed");
                        Check(); Marshal.ThrowExceptionForHR(range.GetText(maximum - text.Length + 1, out string selected));
                        if (Boolean(element, 30019, false, false) != false) return new("protected");
                        if (selected.Length > 0 && text.Length > 0) text.Append('\n');
                        int remaining = maximum - text.Length;
                        if (selected.Length > remaining) truncated = true;
                        text.Append(ControlTreeService.Clip(selected, Math.Max(0, remaining)));
                    }
                    finally { Release(range); }
                }
                if (!StillFocused(element)) return new("changed");
                return text.Length == 0 ? new("empty", null, truncated) : new("text", text.ToString(), truncated);
            }
            catch (ControlBudgetExceeded) { throw; }
            catch (OperationCanceledException) { throw; }
            catch { return new("unavailable"); }
            finally { Release(ranges); Release(pattern); }
        }
        public void Dispose()
        {
            Release(root); root = null!; Release(controlWalker); controlWalker = null!; Release(rawWalker); rawWalker = null!;
            Release(cache); cache = null!; Release(automationObject); automationObject = null; automation = null!;
        }
    }
}
