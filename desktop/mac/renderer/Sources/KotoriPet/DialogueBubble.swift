import AppKit

/// Bubble style determines the color scheme.
enum BubbleStyle {
    case normal      // white bg, dark text
    case warning     // amber/orange bg, dark text — for permission requests
    case error       // red bg, white text — for failures
}

/// A simple label-style dialogue bubble with rounded corners and semi-transparent background.
/// Shows a short text string above the pet. Fades in/out with animation.
/// Sized to match the scaled-down pet window.
final class DialogueBubble: NSView {
    private let label: NSTextField
    private let countLabel: NSTextField  // shows "×N" for active session count

    var text: String = "" {
        didSet { updateText() }
    }

    var sessionCount: Int = 0 {
        didSet { updateCount() }
    }

    var style: BubbleStyle = .normal {
        didSet { applyStyle() }
    }

    private let configFontSize: CGFloat
    private let configMaxWidth: CGFloat
    private let configCornerRadius: CGFloat
    private let configFadeDuration: TimeInterval

    init(config: PetConfig) {
        configFontSize = config.dialogueFontSize
        configMaxWidth = config.dialogueMaxWidth
        configCornerRadius = config.dialogueCornerRadius
        configFadeDuration = config.dialogueFadeDuration

        // Label for dialogue text
        label = NSTextField(labelWithString: "")
        label.font = NSFont.systemFont(ofSize: configFontSize, weight: .medium)
        label.textColor = NSColor(white: 0.2, alpha: 1.0)
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.isBezeled = false
        label.isEditable = false
        label.isSelectable = false
        label.drawsBackground = false

        // Session count label
        countLabel = NSTextField(labelWithString: "")
        countLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .medium)
        countLabel.textColor = NSColor(white: 0.5, alpha: 1.0)
        countLabel.alignment = .center
        countLabel.isBezeled = false
        countLabel.isEditable = false
        countLabel.isSelectable = false
        countLabel.drawsBackground = false

        super.init(frame: .zero)
        wantsLayer = true
        alphaValue = 0

        addSubview(label)
        addSubview(countLabel)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let bounds = self.bounds

        // Background rounded rect
        layer?.cornerRadius = configCornerRadius
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.08
        layer?.shadowOffset = NSSize(width: 0, height: -1)
        layer?.shadowRadius = 2
        applyStyleColors()

        // Layout: text centered, count on the right
        let padding: CGFloat = 5
        let countWidth: CGFloat = sessionCount > 1 ? 22 : 0
        let textWidth = bounds.width - padding * 2 - countWidth

        label.frame = NSRect(
            x: padding,
            y: padding - 1,
            width: textWidth,
            height: bounds.height - padding * 2 + 2
        )

        if sessionCount > 1 {
            countLabel.frame = NSRect(
                x: bounds.width - countWidth - padding / 2,
                y: padding - 1,
                width: countWidth,
                height: bounds.height - padding * 2 + 2
            )
        }
    }

    func show(text: String, sessionCount: Int = 0) {
        self.text = text
        self.sessionCount = sessionCount

        if text.isEmpty && sessionCount <= 1 {
            hide()
            return
        }

        // Calculate size
        let displayText = text.isEmpty ? "" : text
        let countWidth: CGFloat = sessionCount > 1 ? 22 : 0
        let font = NSFont.systemFont(ofSize: configFontSize, weight: .medium)
        let textMaxWidth = configMaxWidth - 40
        let textSize = (displayText as NSString).boundingRect(
            with: NSSize(width: textMaxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        )

        let h = max(20, ceil(textSize.height) + 10)
        let w = min(configMaxWidth, max(40, ceil(textSize.width) + 16 + CGFloat(Int(countWidth))))

        setFrameSize(NSSize(width: w, height: h))
        needsLayout = true
        superview?.needsLayout = true

        // Fade in
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = configFadeDuration
            self.animator().alphaValue = 1.0
        }
    }

    func hide() {
        guard alphaValue > 0.01 else { return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = configFadeDuration
            self.animator().alphaValue = 0.0
        }
    }

    private func updateText() {
        label.stringValue = text
    }

    private func updateCount() {
        countLabel.stringValue = sessionCount > 1 ? "×\(sessionCount)" : ""
    }

    private func applyStyle() {
        applyStyleColors()
        needsLayout = true
    }

    private func applyStyleColors() {
        switch style {
        case .normal:
            layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.88).cgColor
            label.textColor = NSColor(white: 0.2, alpha: 1.0)
            countLabel.textColor = NSColor(white: 0.5, alpha: 1.0)
        case .warning:
            layer?.backgroundColor = NSColor(red: 1.0, green: 0.76, blue: 0.03, alpha: 0.92).cgColor
            label.textColor = NSColor(white: 0.15, alpha: 1.0)
            countLabel.textColor = NSColor(red: 0.4, green: 0.25, blue: 0.0, alpha: 1.0)
        case .error:
            layer?.backgroundColor = NSColor(red: 0.95, green: 0.22, blue: 0.22, alpha: 0.92).cgColor
            label.textColor = NSColor.white
            countLabel.textColor = NSColor(white: 0.85, alpha: 1.0)
        }
    }
}
