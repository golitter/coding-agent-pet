import Foundation

/// Represents the state of a single session.
struct SessionState {
    let state: String
    let dialogue: String
    let source: String
    let isTerminal: Bool
    let updatedAt: Date
}

/// Priority order for aggregating multi-session states.
/// Higher number = higher priority (shown first).
private let statePriority: [String: Int] = [
    "running":        7,
    "running-right":  6,
    "running-left":   6,
    "review":         5,
    "jumping":        4,
    "waving":         3,
    "waiting":        2,
    "idle":           1,
    "failed":         0,
]

/// Manages multiple concurrent sessions, aggregates them into a single display state.
/// Active sessions are those that are currently working (not idle/stopped).
final class SessionManager {
    private var sessions: [String: SessionState] = [:]
    private let sessionsDir: String

    /// The last aggregated result.
    private(set) var currentState: String = "idle"
    private(set) var currentDialogue: String = ""
    private(set) var activeCount: Int = 0

    var onStateChange: ((String, String, Int) -> Void)?

    init(sessionsDir: String) {
        self.sessionsDir = sessionsDir
    }

    /// Update a session's state from a hook event.
    func update(sessionId: String, state: String, dialogue: String, source: String, isTerminal: Bool = false) {
        if isTerminal {
            // Terminal events: remove session immediately
            sessions.removeValue(forKey: sessionId)
            // Also delete file
            let path = (sessionsDir as NSString).appendingPathComponent("\(sessionId).json")
            try? FileManager.default.removeItem(atPath: path)
            aggregateAndNotify()
            return
        }

        let sessionState = SessionState(
            state: state,
            dialogue: dialogue,
            source: source,
            isTerminal: false,
            updatedAt: Date()
        )
        sessions[sessionId] = sessionState
        aggregateAndNotify()
    }

    /// Remove a session.
    func remove(sessionId: String) {
        sessions.removeValue(forKey: sessionId)
        aggregateAndNotify()
    }

    /// Load all session files from disk (called on startup or directory change).
    func loadFromDisk() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: sessionsDir) else { return }

        // Rebuild sessions from files (file is source of truth)
        var loaded: [String: SessionState] = [:]

        for file in files where file.hasSuffix(".json") {
            let path = (sessionsDir as NSString).appendingPathComponent(file)
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }

            let sessionId = file.replacingOccurrences(of: ".json", with: "")
            let state = json["state"] as? String ?? "idle"
            let dialogue = json["dialogue"] as? String ?? ""
            let source = json["source"] as? String ?? ""
            let isTerminal = json["isTerminal"] as? Bool ?? false

            // Skip terminal sessions (they should have been deleted already)
            if isTerminal { continue }

            // Parse date
            var date = Date()
            if let iso = json["updatedAt"] as? String {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                date = formatter.date(from: iso) ?? Date()
            }

            // Skip sessions older than 60s (stale)
            if Date().timeIntervalSince(date) > 60 { continue }

            loaded[sessionId] = SessionState(
                state: state, dialogue: dialogue,
                source: source, isTerminal: false, updatedAt: date
            )
        }

        sessions = loaded
        aggregateAndNotify()
    }

    /// Clean up: delete files that no longer have corresponding sessions,
    /// and remove sessions whose files have been deleted by the hook.
    func cleanupStale() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: sessionsDir) else { return }

        let fileIds = Set(files.filter { $0.hasSuffix(".json") }.map { $0.replacingOccurrences(of: ".json", with: "") })

        // Remove sessions whose files were deleted (hook cleaned them up)
        let orphanedIds = sessions.keys.filter { !fileIds.contains($0) }
        for id in orphanedIds {
            sessions.removeValue(forKey: id)
        }

        if !orphanedIds.isEmpty {
            print("[SessionManager] Cleaned up \(orphanedIds.count) orphaned sessions")
            aggregateAndNotify()
        }
    }

    /// Aggregate all sessions into a single display state using priority.
    /// Only truly active sessions (not idle) count toward ×N.
    private func aggregateAndNotify() {
        guard !sessions.isEmpty else {
            currentState = "idle"
            currentDialogue = ""
            activeCount = 0
            onStateChange?(currentState, currentDialogue, activeCount)
            return
        }

        // Find the session with the highest priority state
        var bestSession: SessionState?
        var bestPriority = -1

        for (_, s) in sessions {
            let priority = statePriority[s.state] ?? 0
            if priority > bestPriority {
                bestPriority = priority
                bestSession = s
            }
        }

        let newState = bestSession?.state ?? "idle"
        let newDialogue = bestSession?.dialogue ?? ""

        // Only count sessions that are actively doing something (not idle)
        let newCount = sessions.values.filter { $0.state != "idle" }.count

        // Only notify if something changed
        if newState != currentState || newDialogue != currentDialogue || newCount != activeCount {
            currentState = newState
            currentDialogue = newDialogue
            activeCount = newCount
            print("[SessionManager] → state=\(currentState) dialogue=\"\(currentDialogue)\" active=\(activeCount)")
            onStateChange?(currentState, currentDialogue, activeCount)
        }
    }
}
