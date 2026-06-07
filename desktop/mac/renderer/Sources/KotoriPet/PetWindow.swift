import AppKit

/// Transparent, borderless, always-on-top floating window that hosts the pet sprite and dialogue bubble.
/// Supports drag-to-move and right-click context menu.
final class PetWindow: NSPanel {
    let imageView: NSImageView
    let bubble: DialogueBubble

    // Original sprite cell size
    private let originalWidth: CGFloat = 192
    private let originalHeight: CGFloat = 208

    // Display scale factor
    private let scale: CGFloat

    private var scaledWidth: CGFloat { originalWidth * scale }
    private var scaledHeight: CGFloat { originalHeight * scale }
    private let bubbleSpacing: CGFloat = 4
    private let cornerMargin: CGFloat

    // Menu from config
    private let menuItems: [PetConfig.MenuItemConfig]

    // Drag state
    private var dragStart: NSPoint?
    var onDrag: ((CGFloat) -> Void)?  // dx callback for direction animation
    private var wasDragging = false

    init(config: PetConfig) {
        self.scale = config.scale
        self.cornerMargin = config.cornerMargin
        self.menuItems = config.menuItems
        self.imageView = NSImageView(frame: .zero)
        self.bubble = DialogueBubble(config: config)

        // Window frame: scaled pet + bubble area above
        let w = config.scale * 192 + 24
        let h = config.scale * 208 + 60
        let frame = NSRect(x: 0, y: 0, width: w, height: h)
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        // Floating above everything
        self.level = .floating
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = false
        self.ignoresMouseEvents = false  // Enable interaction for drag + double-click
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        self.isReleasedWhenClosed = false
        self.hidesOnDeactivate = false

        // Setup content view
        guard let contentView = self.contentView else { return }
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = .clear

        // Image view — scale down the sprite
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        contentView.addSubview(imageView)

        // Bubble
        contentView.addSubview(bubble)

        // Position at bottom-right of screen
        positionInCorner()
    }

    // MARK: - Positioning

    /// Reposition the window to the bottom-right corner of the main screen.
    func positionInCorner() {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame
        let w = scaledWidth + 24
        let h = scaledHeight + 60

        let x = screenFrame.maxX - w - cornerMargin
        let y = screenFrame.minY + cornerMargin

        self.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true)
        layoutSubviews()
    }

    /// Layout bubble centered above the pet image.
    func layoutSubviews() {
        let bounds = self.contentView?.bounds ?? .zero
        let windowWidth = bounds.width

        // Pet image at bottom center
        let imgX = (windowWidth - scaledWidth) / 2
        imageView.frame = NSRect(x: imgX, y: 0, width: scaledWidth, height: scaledHeight)

        // Bubble above pet
        let bubbleSize = bubble.frame.size
        let bubbleX = (windowWidth - bubbleSize.width) / 2
        let bubbleY = scaledHeight + bubbleSpacing
        bubble.frame = NSRect(
            x: bubbleX,
            y: bubbleY,
            width: bubbleSize.width,
            height: bubbleSize.height
        )
    }

    /// Update the dialogue bubble and relayout.
    func updateDialogue(_ text: String, sessionCount: Int, state: String = "idle") {
        // Pick bubble style based on state
        let style: BubbleStyle
        switch state {
        case "waiting":
            style = .warning
        case "failed":
            style = .error
        default:
            style = .normal
        }
        bubble.style = style
        bubble.show(text: text, sessionCount: sessionCount)
        DispatchQueue.main.async {
            self.layoutSubviews()
        }
    }

    // MARK: - Drag Support

    override func mouseDown(with event: NSEvent) {
        // Single click → start drag
        dragStart = NSEvent.mouseLocation
        super.mouseDown(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        showContextMenu(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart else { return }
        let current = NSEvent.mouseLocation
        let dx = current.x - start.x
        let dy = current.y - start.y
        var frame = self.frame
        frame.origin.x += dx
        frame.origin.y += dy
        self.setFrame(frame, display: true)
        dragStart = current
        wasDragging = true

        // Notify direction for running animation
        if abs(dx) > 0.5 {
            onDrag?(dx)
        }
    }

    override func mouseUp(with event: NSEvent) {
        if wasDragging {
            wasDragging = false
            onDrag?(0)  // signal: drag ended
        }
        dragStart = nil
        super.mouseUp(with: event)
    }

    override func rightMouseUp(with event: NSEvent) {
        if wasDragging {
            wasDragging = false
            onDrag?(0)
        }
        dragStart = nil
        super.rightMouseUp(with: event)
    }

    override func otherMouseUp(with event: NSEvent) {
        if wasDragging {
            wasDragging = false
            onDrag?(0)
        }
        dragStart = nil
        super.otherMouseUp(with: event)
    }

    // MARK: - Context Menu

    private func showContextMenu(with event: NSEvent) {
        let menu = NSMenu()

        for itemConfig in menuItems {
            if itemConfig.action == "separator" {
                menu.addItem(NSMenuItem.separator())
            } else if itemConfig.action == "quit" {
                let item = menu.addItem(withTitle: itemConfig.title, action: #selector(quitApp), keyEquivalent: "q")
                item.target = self
            } else if itemConfig.action == "applescript", let script = itemConfig.script {
                let item = menu.addItem(withTitle: itemConfig.title, action: #selector(runScript(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = script
            }
        }

        // Fallback if no menu items configured
        if menu.items.isEmpty {
            let item = menu.addItem(withTitle: "关闭宠物", action: #selector(quitApp), keyEquivalent: "q")
            item.target = self
        }

        let targetView: NSView = self.contentView ?? NSView()
        NSMenu.popUpContextMenu(menu, with: event, for: targetView)
    }

    @objc private func runScript(_ sender: NSMenuItem) {
        guard let script = sender.representedObject as? String else { return }
        runAppleScript(script)
    }

    @objc private func quitApp() {
        NSApplication.shared.terminate(nil)
    }

    // MARK: - Helpers

    private func runAppleScript(_ source: String) {
        guard let script = NSAppleScript(source: source) else { return }
        var error: NSDictionary?
        script.executeAndReturnError(&error)
        if let error = error {
            print("[PetWindow] AppleScript error: \(error)")
        }
    }
}
