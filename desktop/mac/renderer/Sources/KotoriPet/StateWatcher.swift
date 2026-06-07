import Foundation

/// Monitors the sessions directory for changes and receives real-time updates via Unix socket.
final class StateWatcher {
    private let sessionsDir: String
    private let socketPath: String
    private let sessionManager: SessionManager
    private var dirSource: DispatchSourceFileSystemObject?
    private var socketFd: Int32 = -1
    private var socketSource: DispatchSourceRead?

    init(sessionsDir: String, socketPath: String, sessionManager: SessionManager) {
        self.sessionsDir = sessionsDir
        self.socketPath = socketPath
        self.sessionManager = sessionManager
    }

    deinit {
        stop()
    }

    // MARK: - Directory Watcher

    func startDirectoryWatch(queue: DispatchQueue = .global(qos: .userInteractive)) {
        let fd = open(sessionsDir, O_EVTONLY)
        guard fd >= 0 else {
            print("[StateWatcher] ⚠️ Cannot open sessions dir for watching: \(sessionsDir)")
            return
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename],
            queue: queue
        )

        source.setEventHandler { [weak self] in
            self?.sessionManager.loadFromDisk()
        }

        source.setCancelHandler {
            close(fd)
        }

        self.dirSource = source
        source.resume()
        print("[StateWatcher] ✓ Watching directory: \(sessionsDir)")
    }

    // MARK: - Unix Socket Server

    func startSocketServer(queue: DispatchQueue = .global(qos: .userInteractive)) {
        // Clean up any stale socket
        unlink(socketPath)

        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            print("[StateWatcher] ⚠️ Cannot create socket")
            return
        }

        // Non-blocking
        let flags = fcntl(socketFd, F_GETFL, 0)
        _ = fcntl(socketFd, F_SETFL, flags | O_NONBLOCK)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { path in
            let len = strlen(path)
            withUnsafeMutablePointer(to: &addr.sun_path.0) { dst in
                dst.initialize(from: path, count: len + 1)
            }
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            bind(socketFd, UnsafeRawPointer(ptr).assumingMemoryBound(to: sockaddr.self), socklen_t(MemoryLayout<sockaddr_un>.size))
        }

        guard bindResult == 0 else {
            print("[StateWatcher] ⚠️ Cannot bind socket: \(socketPath)")
            close(socketFd)
            socketFd = -1
            return
        }

        listen(socketFd, 5)

        let source = DispatchSource.makeReadSource(fileDescriptor: socketFd, queue: queue)

        source.setEventHandler { [weak self] in
            self?.acceptConnection()
        }

        source.setCancelHandler { [weak self] in
            if let self = self, self.socketFd >= 0 {
                close(self.socketFd)
                self.socketFd = -1
            }
        }

        self.socketSource = source
        source.resume()
        print("[StateWatcher] ✓ Socket listening: \(socketPath)")
    }

    private func acceptConnection() {
        let clientFd = accept(socketFd, nil, nil)
        guard clientFd >= 0 else { return }

        // Read data (small JSON payloads, one read should suffice)
        var buffer = [UInt8](repeating: 0, count: 4096)
        let bytesRead = read(clientFd, &buffer, buffer.count)
        close(clientFd)

        guard bytesRead > 0 else { return }

        let data = Data(buffer[0..<bytesRead])
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        let sessionId = json["session_id"] as? String ?? "unknown"
        let state = json["state"] as? String ?? "idle"
        let dialogue = json["dialogue"] as? String ?? ""
        let source = json["source"] as? String ?? ""
        let isTerminal = json["isTerminal"] as? Bool ?? false

        sessionManager.update(sessionId: sessionId, state: state, dialogue: dialogue, source: source, isTerminal: isTerminal)
    }

    // MARK: - Cleanup

    func stop() {
        dirSource?.cancel()
        dirSource = nil
        socketSource?.cancel()
        socketSource = nil

        if socketFd >= 0 {
            close(socketFd)
            socketFd = -1
        }
        unlink(socketPath)
    }
}
