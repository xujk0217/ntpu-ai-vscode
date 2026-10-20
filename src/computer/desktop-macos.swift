// Selected-window backend. No clipboard, whole-display capture or shell commands.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Darwin

// Delay termination only across a down/up pair so cancellation cannot leave held inputs.
func paired(_ body: () -> Void) {
    var mask = sigset_t(), previous = sigset_t(); sigemptyset(&mask); sigaddset(&mask, SIGTERM); sigaddset(&mask, SIGINT)
    pthread_sigmask(SIG_BLOCK, &mask, &previous); body(); pthread_sigmask(SIG_SETMASK, &previous, nil)
}
struct Failure: Error { let message: String; init(_ message: String) { self.message = message } }
func check(_ condition: Bool, _ message: String) throws { if !condition { throw Failure(message) } }
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}
func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
let sensitive = #"\b(?:sso|sign.?in|log.?in|password|authentication)\b|登入|驗證碼|密碼"#
func policy() throws -> [String: String] {
    let file = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("window-policy.json")
    return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
}
func info(_ window: [String: Any], _ rules: [String: String]) -> [String: Any]? {
    guard let id = window[kCGWindowNumber as String] as? Int, let pid = window[kCGWindowOwnerPID as String] as? Int32,
          let app = NSRunningApplication(processIdentifier: pid), let bundle = app.bundleIdentifier,
          let title = window[kCGWindowName as String] as? String, !title.isEmpty,
          let bounds = window[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 0, rect.height > 0,
          window[kCGWindowLayer as String] as? Int == 0 else { return nil }
    let owner = app.localizedName ?? ""
    guard !matches(owner, rules["blockedClassPattern"] ?? ".*"), !matches(bundle, rules["blockedMacBundlePattern"] ?? ".*"), !matches(title, sensitive) else { return nil }
    return ["id": String(id), "pid": Int(pid), "bundle": bundle, "class": owner, "title": title, "x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
}
func windows() -> [[String: Any]] { CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] }
func axWindow(_ current: [String: Any]) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(Int32(current["pid"] as! Int))
    let candidates = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter { element in
        guard let title = attribute(element, kAXTitleAttribute) as? String, title == current["title"] as? String,
              let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(position as! AXValue, .cgPoint, &p); AXValueGetValue(size as! AXValue, .cgSize, &s)
        return abs(p.x - (current["x"] as! Double)) < 1 && abs(p.y - (current["y"] as! Double)) < 1 && abs(s.width - (current["width"] as! Double)) < 1 && abs(s.height - (current["height"] as! Double)) < 1
    }
    try check(candidates.count == 1, "無法唯一辨識選定的輔助使用視窗；請關閉重複標題視窗或重新選取。")
    return candidates[0]
}
func safeContents(_ element: AXUIElement, _ depth: Int = 0, _ count: inout Int) throws {
    count += 1; try check(depth < 40 && count < 5000, "視窗結構過大，無法安全檢查；請改用受控工作瀏覽器。")
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
    let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].compactMap { attribute(element, $0) as? String }.joined(separator: " ")
    try check(!subrole.contains("Secure") && role != "AXSheet" && !matches(label, sensitive), "選定視窗包含登入、密碼或驗證畫面，已停止觀察／操作。")
    for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] { try safeContents(child, depth + 1, &count) }
}
@available(macOS 14.0, *)
func perform(_ m: [String: Any]) async throws -> [String: Any] {
    let screen = CGPreflightScreenCaptureAccess(), accessibility = AXIsProcessTrusted()
    if m["op"] as? String == "status" { return ["screenRecording": screen, "accessibility": accessibility, "backend": "macOS selected window"] }
    try check(screen, "需要螢幕錄製權限：系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製，允許 VS Code／啟動此工具的程式，然後重新啟動。")
    try check(accessibility, "需要輔助使用權限：系統設定 → 隱私權與安全性 → 輔助使用，允許 VS Code／啟動此工具的程式，然後重新啟動。")
    let rules = try policy(), all = windows()
    if m["op"] as? String == "list" { return ["windows": all.compactMap { info($0, rules) }] }
    guard let raw = all.first(where: { String($0[kCGWindowNumber as String] as? Int ?? -1) == m["id"] as? String }), let current = info(raw, rules) else { throw Failure("選定視窗已關閉、不可見或屬於禁止控制的應用程式。") }
    guard let identity = m["identity"] as? [String: Any] else { throw Failure("缺少使用者選定視窗的身分。") }
    try check(identity["pid"] as? Int == (current["pid"] as? Int) && identity["bundle"] as? String == current["bundle"] as? String, "視窗身分已改變，請重新選取。")
    try check((current["width"] as! Double) <= 3072 && (current["height"] as! Double) <= 2048, "視窗過大，請縮小到 3072×2048 以內。")
    let selected = try axWindow(current); var count = 0; try safeContents(selected, 0, &count)
    if m["op"] as? String == "observe" {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { String($0.windowID) == current["id"] as? String && Int($0.owningApplication?.processID ?? -1) == current["pid"] as? Int }) else { throw Failure("選定視窗已關閉，或螢幕錄製權限已撤銷。") }
        let config = SCStreamConfiguration(); config.width = Int(window.frame.width); config.height = Int(window.frame.height); config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        guard let latest = windows().first(where: { String($0[kCGWindowNumber as String] as? Int ?? -1) == current["id"] as? String }), let latestInfo = info(latest, rules) else { throw Failure("擷取期間視窗已關閉。") }
        try check(latestInfo["pid"] as? Int == current["pid"] as? Int && latestInfo["bundle"] as? String == current["bundle"] as? String, "擷取期間視窗身分已變更。")
        for key in ["x", "y", "width", "height"] { try check((latestInfo[key] as? Double) == (current[key] as? Double), "擷取期間視窗身分或幾何已變更，請重新觀察。") }
        var afterCount = 0; try safeContents(try axWindow(current), 0, &afterCount)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 8 * 1024 * 1024 else { throw Failure("截圖失敗或超過 8 MiB。") }
        var result = current; result["png"] = png.base64EncodedString(); return result
    }
    try check(m["op"] as? String == "action", "未知桌面操作。")
    guard let geometry = m["geometry"] as? [String: Double] else { throw Failure("請先觀察視窗。") }
    for key in ["x", "y", "width", "height"] { try check(geometry[key] == current[key] as? Double, "視窗位置或大小已變更，請重新觀察。") }
    let pid = Int32(current["pid"] as! Int), app = NSRunningApplication(processIdentifier: pid)!
    func focused() throws {
        try check(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, "焦點已移到其他程式，已停止操作。")
        let axApp = AXUIElementCreateApplication(pid)
        guard let focus = attribute(axApp, kAXFocusedWindowAttribute) else { throw Failure("無法確認視窗焦點。") }
        try check(CFEqual(focus, selected), "焦點不是選定視窗，已停止操作。")
        try check(!matches(attribute(selected, kAXTitleAttribute) as? String ?? "", sensitive), "視窗已進入登入或驗證流程，已停止操作。")
        if let focusElement = attribute(axApp, kAXFocusedUIElementAttribute), CFGetTypeID(focusElement) == AXUIElementGetTypeID() {
            let element = focusElement as! AXUIElement
            try check(!(attribute(element, kAXSubroleAttribute) as? String ?? "").contains("Secure"), "焦點已進入安全輸入欄位，已停止操作。")
        }
        let flags = CGEventSource.flagsState(.combinedSessionState)
        try check(flags.intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]).isEmpty, "請先放開修飾鍵，再重新觀察。")
    }
    try check(app.activate(options: []), "無法切換到選定應用程式。")
    try check(AXUIElementPerformAction(selected, kAXRaiseAction as CFString) == .success, "無法將選定視窗移至前景。")
    try await Task.sleep(nanoseconds: 150_000_000); try focused()
    let source = CGEventSource(stateID: .privateState)
    func sendKey(_ code: CGKeyCode, _ text: String? = nil) throws {
        try Task.checkCancellation(); try focused()
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { throw Failure("無法建立鍵盤事件。") }
        if let text { let chars = Array(text.utf16); chars.withUnsafeBufferPointer { down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: $0.baseAddress); up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: $0.baseAddress) } }
        down.flags = []; up.flags = []; paired { down.postToPid(pid); up.postToPid(pid) }
    }
    switch m["action"] as? String {
    case "type":
        guard let text = m["text"] as? String, !text.isEmpty, text.count <= 1000, !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw Failure("文字需為 1–1000 個可列印字元。") }
        for char in text { try sendKey(0, String(char)); try await Task.sleep(nanoseconds: 12_000_000) }
    case "key":
        let keys: [String: CGKeyCode] = ["Return":36,"Tab":48,"Escape":53,"space":49,"BackSpace":51,"Delete":117,"Left":123,"Right":124,"Up":126,"Down":125,"Home":115,"End":119,"Page_Up":116,"Page_Down":121]
        guard let name = m["key"] as? String, let key = keys[name] else { throw Failure("不允許此按鍵或系統快捷鍵。") }; try sendKey(key)
    case "click", "scroll":
        guard let x = m["x"] as? Double, let y = m["y"] as? Double, x.isFinite, y.isFinite, x >= 0, y >= 0, x < geometry["width"]!, y < geometry["height"]! else { throw Failure("座標不在選定視窗內。") }
        let point = CGPoint(x: geometry["x"]! + x, y: geometry["y"]! + y)
        var hit: AXUIElement?
        try check(AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, "無法確認點擊目標；請確認輔助使用權限。")
        guard let hit else { throw Failure("無法確認點擊目標。") }
        var hitPid: pid_t = 0; AXUIElementGetPid(hit, &hitPid)
        let hitWindow = attribute(hit, kAXWindowAttribute)
        try check(hitPid == pid && (CFEqual(hit, selected) || (hitWindow != nil && CFEqual(hitWindow!, selected))), "選定視窗被遮住，已停止操作。")
        try focused()
        if m["action"] as? String == "click" {
            var names: CFArray?
            AXUIElementCopyActionNames(hit, &names)
            if (names as? [String] ?? []).contains(kAXPressAction) {
                try check(AXUIElementPerformAction(hit, kAXPressAction as CFString) == .success, "選定控制項未接受點擊，結果未確認。")
            } else if [kAXTextFieldRole, kAXTextAreaRole].contains(attribute(hit, kAXRoleAttribute) as? String ?? "") {
                try check(AXUIElementSetAttributeValue(hit, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success, "無法聚焦選定文字欄位。")
            } else { throw Failure("此控制項不提供安全的輔助使用點擊；請改用受控工作瀏覽器或手動操作。") }
        } else {
            guard let direction = m["direction"] as? String, ["up", "down"].contains(direction), let count = m["count"] as? Int, (1...10).contains(count) else { throw Failure("捲動需指定 up／down，count 為 1–10。") }
            var ancestor: AXUIElement? = hit, bar: AXUIElement?
            for _ in 0..<20 {
                guard let element = ancestor else { break }
                if let value = attribute(element, kAXVerticalScrollBarAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() { bar = (value as! AXUIElement); break }
                guard let parent = attribute(element, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
                ancestor = (parent as! AXUIElement)
            }
            guard let bar else { throw Failure("此視窗沒有可核對的垂直捲動控制項；請改用受控工作瀏覽器或手動捲動。") }
            try focused()
            var settable = DarwinBoolean(false)
            try check(AXUIElementIsAttributeSettable(bar, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue, "此捲動控制項不可調整；請改用工作瀏覽器。")
            guard let value = attribute(bar, kAXValueAttribute) as? NSNumber else { throw Failure("無法核對捲動位置。") }
            let lower = (attribute(bar, kAXMinValueAttribute) as? NSNumber)?.doubleValue ?? 0
            let upper = (attribute(bar, kAXMaxValueAttribute) as? NSNumber)?.doubleValue ?? 1
            try check(lower.isFinite && upper.isFinite && upper > lower && value.doubleValue.isFinite, "捲動範圍無效。")
            let next = min(upper, max(lower, value.doubleValue + (upper - lower) * Double(count) * (direction == "up" ? -0.05 : 0.05)))
            try check(next != value.doubleValue, "已在捲動邊界，沒有進一步變更。")
            try check(AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success, "捲動控制項未接受操作，結果未確認。")
        }
    default: throw Failure("不支援此桌面動作。")
    }
    return ["performed": true, "requiresObservation": true]
}
@main struct Main {
    static func main() async {
        var output: [String: Any]
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            try check(data.count <= 16000, "桌面操作資料過大。")
            guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure("無效桌面操作。") }
            if #available(macOS 14.0, *) { output = try await perform(message); output["ok"] = true }
            else { throw Failure("macOS 原生桌面控制需要 macOS 14 或更新版本；舊版可使用受控工作瀏覽器。") }
        } catch { output = ["ok": false, "error": (error as? Failure)?.message ?? "macOS 視窗擷取／操作失敗；請確認螢幕錄製、輔助使用權限與選定視窗仍可用。"] }
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) { FileHandle.standardOutput.write(data) }
    }
}
