import AppKit
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
func write(_ file: String, _ value: [String: Any]) { try! JSONSerialization.data(withJSONObject: value).write(to: directory.appendingPathComponent(file), options: .atomic) }
class Scroller: NSScrollView {
    var scrolled = false
    override func scrollWheel(with event: NSEvent) { scrolled = true; super.scrollWheel(with: event); write("scroll.json", ["scrolled": true]) }
}
class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!; var field: NSTextField!; var scroll: Scroller!
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 200, y: 240, width: 560, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "NTPUComputerUseFixture"; window.isReleasedWhenClosed = false
        field = NSTextField(frame: NSRect(x: 30, y: 310, width: 450, height: 30)); field.placeholderString = "Fixture text"; window.contentView!.addSubview(field)
        let button = NSButton(title: "Verify fixture", target: self, action: #selector(clicked)); button.frame = NSRect(x: 30, y: 255, width: 180, height: 34); window.contentView!.addSubview(button)
        scroll = Scroller(frame: NSRect(x: 30, y: 30, width: 450, height: 200)); scroll.hasVerticalScroller = true
        let document = NSTextView(frame: NSRect(x: 0, y: 0, width: 430, height: 2000)); document.string = String(repeating: "Synthetic scroll content\n", count: 100); scroll.documentView = document; window.contentView!.addSubview(scroll)
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { _ in
            if self.scroll.contentView.bounds.origin.y != 0 { write("scroll.json", ["scrolled": true]) }
        }
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .keyDown, .keyUp, .scrollWheel]) { event in
            write("last-event.json", ["type": event.type.rawValue, "x": event.locationInWindow.x, "y": event.locationInWindow.y, "window": event.windowNumber])
            return event
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            func point(_ rect: NSRect) -> [String: Int] { let p = self.window.convertPoint(toScreen: NSPoint(x: rect.midX, y: rect.midY)); return ["x": Int(p.x - self.window.frame.minX), "y": Int(self.window.frame.maxY - p.y)] }
            write("ready.json", ["id": String(self.window.windowNumber), "entry": point(self.field.frame), "button": point(button.frame), "scroll": point(self.scroll.frame)])
        }
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("secure").path) {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent("secure"))
                let secure = NSSecureTextField(frame: NSRect(x: 30, y: 220, width: 300, height: 24)); self.window.contentView!.addSubview(secure)
                write("secure.json", ["secure": true])
            }
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("move").path) {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent("move")); self.window.setFrameOrigin(NSPoint(x: 260, y: 280)); write("moved.json", ["moved": true])
            }
        }
    }
    @objc func clicked() { window.makeFirstResponder(nil); write("receipt.json", ["text": field.stringValue, "clicked": true]) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared; let delegate = Delegate(); app.delegate = delegate; app.setActivationPolicy(.regular); app.run()
