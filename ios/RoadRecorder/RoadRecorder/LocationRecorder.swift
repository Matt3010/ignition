import CoreLocation
import Foundation

@MainActor
final class LocationRecorder: NSObject, ObservableObject {
    @Published var backendBaseURL = "" {
        didSet {
            Task {
                await settingsStore.saveBackendBaseURL(backendBaseURL)
            }
        }
    }

    @Published private(set) var isRecording = false
    @Published private(set) var statusText = "Pronto"
    @Published private(set) var sessionId = UUID()
    @Published private(set) var sentCount = 0
    @Published private(set) var errorCount = 0
    @Published private(set) var events: [RecorderEvent] = []
    @Published private(set) var savedSessions: [SavedSessionSummary] = []
    @Published private(set) var currentSessionFileURL: URL?
    @Published private(set) var lastAccuracyText = "n/d"

    private let manager = CLLocationManager()
    private let client = RoadContextClient()
    private let settingsStore = BackendSettingsStore()
    private let sessionStore = SessionArchiveStore()
    private let isoFormatter = ISO8601DateFormatter()
    private var lastSentLocation: CLLocation?
    private var lastSentAt: Date?
    private var currentSessionArchive: RecorderSessionArchive?
    private var currentSessionEvents: [RecorderEvent] = []

    var canStartRecording: Bool {
        isRecording || validatedBackendURL != nil
    }

    override init() {
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        super.init()
        manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = 2
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        Task {
            backendBaseURL = await settingsStore.loadBackendBaseURL()
            await reloadSavedSessions()
        }
    }

    func startRecording() {
        guard validatedBackendURL != nil else {
            statusText = "Backend URL richiesto"
            return
        }

        sessionId = UUID()
        sentCount = 0
        errorCount = 0
        events = []
        currentSessionEvents = []
        currentSessionFileURL = nil
        lastSentLocation = nil
        lastSentAt = nil
        isRecording = true
        statusText = "Richiesta GPS"
        currentSessionArchive = RecorderSessionArchive(
            id: sessionId,
            startedAt: isoFormatter.string(from: Date()),
            endedAt: nil,
            backendBaseURL: backendBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sentCount: 0,
            errorCount: 0,
            events: []
        )
        persistCurrentSession()
        sendAppLog(kind: "session_start", event: nil, message: "recording started")

        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
            beginLocationUpdates()
        case .authorizedAlways:
            beginLocationUpdates()
        case .denied, .restricted:
            isRecording = false
            statusText = "Permesso GPS negato"
        @unknown default:
            isRecording = false
            statusText = "Permesso GPS sconosciuto"
        }
    }

    func stopRecording() {
        manager.stopUpdatingLocation()
        isRecording = false
        statusText = "Fermo"
        if var archive = currentSessionArchive {
            archive.endedAt = isoFormatter.string(from: Date())
            archive.sentCount = sentCount
            archive.errorCount = errorCount
            archive.events = currentSessionEvents
            currentSessionArchive = archive
            persistCurrentSession(refreshList: true)
            sendAppLog(kind: "session_stop", event: nil, message: "recording stopped")
        }
    }

    func clearEvents() {
        events = []
        sentCount = 0
        errorCount = 0
        statusText = "Pronto"
    }

    func reloadSavedSessions() async {
        do {
            savedSessions = try await sessionStore.list()
        } catch {
            statusText = "Errore lettura sessioni"
        }
    }

    func deleteSavedSession(_ session: SavedSessionSummary) {
        Task {
            do {
                try await sessionStore.delete(session)
                await reloadSavedSessions()
            } catch {
                statusText = "Errore eliminazione sessione"
            }
        }
    }

    private func beginLocationUpdates() {
        guard isRecording else { return }
        manager.startUpdatingLocation()
        statusText = "Registrazione attiva"
    }

    private func handle(location: CLLocation) {
        guard isRecording else { return }
        guard location.horizontalAccuracy > 0, location.horizontalAccuracy <= 50 else {
            lastAccuracyText = "\(Int(max(location.horizontalAccuracy, 0).rounded())) m"
            statusText = "GPS poco accurato"
            return
        }
        guard shouldSend(location) else { return }

        lastSentLocation = location
        lastSentAt = Date()
        lastAccuracyText = "\(Int(location.horizontalAccuracy.rounded())) m"

        let sample = RoadContextSample(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            speedKmh: max(location.speed, 0) * 3.6,
            course: location.course >= 0 ? location.course : nil,
            horizontalAccuracyMeters: location.horizontalAccuracy,
            timestamp: isoFormatter.string(from: location.timestamp),
            sessionId: sessionId.uuidString
        )

        Task {
            await send(sample)
        }
    }

    private func shouldSend(_ location: CLLocation) -> Bool {
        if let lastSentAt, Date().timeIntervalSince(lastSentAt) < 1 {
            return false
        }
        if let lastSentLocation, location.distance(from: lastSentLocation) < 2 {
            return false
        }
        return true
    }

    private func send(_ sample: RoadContextSample) async {
        let startedAtDate = Date()
        let requestStartedAt = isoFormatter.string(from: startedAtDate)
        do {
            guard let backendURL = validatedBackendURL else {
                throw RoadContextClientError.invalidBaseURL
            }
            let result = try await client.send(sample: sample, backendBaseURL: backendURL)
            let endedAtDate = Date()
            sentCount += 1
            statusText = result.response.matched ? "Invio ok" : "Non agganciata"
            prepend(RecorderEvent(
                sample: sample,
                response: result.response,
                errorMessage: nil,
                requestStartedAt: requestStartedAt,
                requestEndedAt: isoFormatter.string(from: endedAtDate),
                latencyMs: endedAtDate.timeIntervalSince(startedAtDate) * 1000,
                httpStatusCode: result.httpStatusCode
            ))
        } catch {
            let endedAtDate = Date()
            errorCount += 1
            statusText = "Errore invio"
            let httpStatusCode: Int?
            if case RoadContextClientError.http(let status, _) = error {
                httpStatusCode = status
            } else {
                httpStatusCode = nil
            }
            prepend(RecorderEvent(
                sample: sample,
                response: nil,
                errorMessage: error.localizedDescription,
                requestStartedAt: requestStartedAt,
                requestEndedAt: isoFormatter.string(from: endedAtDate),
                latencyMs: endedAtDate.timeIntervalSince(startedAtDate) * 1000,
                httpStatusCode: httpStatusCode
            ))
        }
    }

    private func prepend(_ event: RecorderEvent) {
        currentSessionEvents.append(event)
        events.insert(event, at: 0)
        if events.count > 80 {
            events.removeLast(events.count - 80)
        }
        if var archive = currentSessionArchive {
            archive.sentCount = sentCount
            archive.errorCount = errorCount
            archive.events = currentSessionEvents
            currentSessionArchive = archive
            persistCurrentSession()
        }
        sendAppLog(kind: "road_context_event", event: event, message: nil)
    }

    private func persistCurrentSession(refreshList: Bool = false) {
        guard let archive = currentSessionArchive else { return }
        Task {
            do {
                let fileURL = try await sessionStore.save(archive)
                currentSessionFileURL = fileURL
                if refreshList {
                    await reloadSavedSessions()
                }
            } catch {
                statusText = "Errore salvataggio sessione"
            }
        }
    }

    private var validatedBackendURL: URL? {
        let value = backendBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme != nil, url.host != nil else {
            return nil
        }
        return url
    }

    private func sendAppLog(kind: String, event: RecorderEvent?, message: String?) {
        guard let backendURL = validatedBackendURL else { return }
        let payload = AppLogPayload(
            sessionId: sessionId.uuidString,
            createdAt: isoFormatter.string(from: Date()),
            kind: kind,
            backendBaseURL: backendBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
            message: message,
            counters: AppLogCounters(
                sentCount: sentCount,
                errorCount: errorCount,
                localEventCount: currentSessionEvents.count
            ),
            event: event
        )
        Task {
            do {
                try await client.sendAppLog(payload: payload, backendBaseURL: backendURL)
            } catch {
                // Remote debug logs are best-effort; local session JSON remains authoritative.
            }
        }
    }
}

private actor BackendSettingsStore {
    private let backendBaseURLKey = "backendBaseURL"

    func loadBackendBaseURL() -> String {
        UserDefaults.standard.string(forKey: backendBaseURLKey) ?? ""
    }

    func saveBackendBaseURL(_ value: String) {
        UserDefaults.standard.set(value, forKey: backendBaseURLKey)
    }
}

struct SavedSessionSummary: Identifiable, Equatable {
    let id: UUID
    let startedAt: String
    let endedAt: String?
    let backendBaseURL: String
    let sentCount: Int
    let errorCount: Int
    let eventCount: Int
    let fileURL: URL

    var titleText: String {
        startedAt
            .replacingOccurrences(of: "T", with: " ")
            .replacingOccurrences(of: "Z", with: "")
    }

    var detailText: String {
        "\(eventCount) eventi, \(sentCount) ok, \(errorCount) errori"
    }
}

private struct RecorderSessionArchive: Identifiable, Codable {
    let id: UUID
    let startedAt: String
    var endedAt: String?
    let backendBaseURL: String
    var sentCount: Int
    var errorCount: Int
    var events: [RecorderEvent]
}

private actor SessionArchiveStore {
    private let directoryURL: URL
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init() {
        directoryURL = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("RoadRecorderSessions", isDirectory: true)
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    func save(_ archive: RecorderSessionArchive) throws -> URL {
        try ensureDirectory()
        let fileURL = url(for: archive.id)
        let data = try encoder.encode(archive)
        try data.write(to: fileURL, options: [.atomic])
        return fileURL
    }

    func list() throws -> [SavedSessionSummary] {
        try ensureDirectory()
        let fileURLs = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )

        return try fileURLs
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL in
                let data = try Data(contentsOf: fileURL)
                let archive = try decoder.decode(RecorderSessionArchive.self, from: data)
                return SavedSessionSummary(
                    id: archive.id,
                    startedAt: archive.startedAt,
                    endedAt: archive.endedAt,
                    backendBaseURL: archive.backendBaseURL,
                    sentCount: archive.sentCount,
                    errorCount: archive.errorCount,
                    eventCount: archive.events.count,
                    fileURL: fileURL
                )
            }
            .sorted { $0.startedAt > $1.startedAt }
    }

    func delete(_ session: SavedSessionSummary) throws {
        try FileManager.default.removeItem(at: session.fileURL)
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    private func url(for sessionId: UUID) -> URL {
        directoryURL.appendingPathComponent("\(sessionId.uuidString).json")
    }
}

extension LocationRecorder: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            switch manager.authorizationStatus {
            case .authorizedWhenInUse:
                manager.requestAlwaysAuthorization()
                beginLocationUpdates()
            case .authorizedAlways:
                beginLocationUpdates()
            case .denied, .restricted:
                isRecording = false
                statusText = "Permesso GPS negato"
            case .notDetermined:
                break
            @unknown default:
                isRecording = false
                statusText = "Permesso GPS sconosciuto"
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            handle(location: location)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            statusText = error.localizedDescription
            errorCount += 1
        }
    }
}
