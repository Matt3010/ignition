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
    private var activeSendTask: Task<Void, Never>?
    private var activeRequestToken: UUID?
    private var sessionGeneration = UUID()
    private var archiveRevision = 0
    private let maximumLocationAge: TimeInterval = 10
    private let maximumLocationFutureSkew: TimeInterval = 5

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

        activeSendTask?.cancel()
        sessionGeneration = UUID()
        sessionId = UUID()
        archiveRevision = 0
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
            finishCurrentSession(
                status: "Permesso GPS negato",
                logKind: "session_permission_denied",
                message: "recording stopped because location permission was denied"
            )
        @unknown default:
            finishCurrentSession(
                status: "Permesso GPS sconosciuto",
                logKind: "session_permission_unknown",
                message: "recording stopped because location authorization status was unknown"
            )
        }
    }

    func stopRecording() {
        finishCurrentSession(
            status: "Fermo",
            logKind: "session_stop",
            message: "recording stopped"
        )
    }

    private func finishCurrentSession(status: String, logKind: String, message: String) {
        manager.stopUpdatingLocation()
        activeSendTask?.cancel()
        activeSendTask = nil
        activeRequestToken = nil

        let stoppedSessionId = sessionId
        let stoppedBackendURL = validatedBackendURL
        let hadActiveSession = isRecording || currentSessionArchive?.endedAt == nil

        isRecording = false
        sessionGeneration = UUID()
        statusText = status

        guard hadActiveSession, var archive = currentSessionArchive, archive.endedAt == nil else { return }
        archive.endedAt = isoFormatter.string(from: Date())
        archive.sentCount = sentCount
        archive.errorCount = errorCount
        archive.events = currentSessionEvents
        currentSessionArchive = archive
        persistCurrentSession(refreshList: true)
        sendAppLog(
            kind: logKind,
            event: nil,
            message: message,
            sessionId: stoppedSessionId,
            backendURL: stoppedBackendURL
        )
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
        let locationAge = Date().timeIntervalSince(location.timestamp)
        guard locationAge <= maximumLocationAge, locationAge >= -maximumLocationFutureSkew else {
            statusText = "Posizione GPS non aggiornata"
            return
        }
        guard location.horizontalAccuracy > 0, location.horizontalAccuracy <= 50 else {
            lastAccuracyText = "\(Int(max(location.horizontalAccuracy, 0).rounded())) m"
            statusText = "GPS poco accurato"
            return
        }
        guard shouldSend(location) else { return }
        guard activeSendTask == nil, let backendURL = validatedBackendURL else { return }

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

        let requestGeneration = sessionGeneration
        let requestSessionId = sessionId
        let requestToken = UUID()
        activeRequestToken = requestToken
        activeSendTask = Task { [weak self] in
            await self?.send(
                sample,
                backendURL: backendURL,
                requestSessionId: requestSessionId,
                requestGeneration: requestGeneration
            )
            guard let self, self.activeRequestToken == requestToken else { return }
            self.activeSendTask = nil
            self.activeRequestToken = nil
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

    private func send(
        _ sample: RoadContextSample,
        backendURL: URL,
        requestSessionId: UUID,
        requestGeneration: UUID
    ) async {
        let startedAtDate = Date()
        let requestStartedAt = isoFormatter.string(from: startedAtDate)
        do {
            let result = try await client.send(sample: sample, backendBaseURL: backendURL)
            try Task.checkCancellation()
            guard isCurrentRequest(sessionId: requestSessionId, generation: requestGeneration) else { return }
            let endedAtDate = Date()
            sentCount += 1
            let event = RecorderEvent(
                sample: sample,
                response: result.response,
                errorMessage: nil,
                requestStartedAt: requestStartedAt,
                requestEndedAt: isoFormatter.string(from: endedAtDate),
                latencyMs: endedAtDate.timeIntervalSince(startedAtDate) * 1000,
                httpStatusCode: result.httpStatusCode
            )
            statusText = warmupOnly(event)
                ? "Aggancio in corso"
                : result.response.matched
                    ? "Invio ok"
                    : result.response.matchStatus == "providerUnavailable"
                        ? "Mappe non disponibili"
                        : "Non agganciata"
            prepend(event, sessionId: requestSessionId, backendURL: backendURL)
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentRequest(sessionId: requestSessionId, generation: requestGeneration) else { return }
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
            ), sessionId: requestSessionId, backendURL: backendURL)
        }
    }

    private func isCurrentRequest(sessionId requestSessionId: UUID, generation: UUID) -> Bool {
        isRecording && sessionId == requestSessionId && sessionGeneration == generation
    }

    private func prepend(_ event: RecorderEvent, sessionId eventSessionId: UUID, backendURL: URL) {
        guard sessionId == eventSessionId, isRecording else { return }
        let hiddenFromTimeline = warmupOnly(event)
        currentSessionEvents.append(event)
        if !hiddenFromTimeline {
            events.insert(event, at: 0)
            if events.count > 80 {
                events.removeLast(events.count - 80)
            }
        }
        if var archive = currentSessionArchive {
            archive.sentCount = sentCount
            archive.errorCount = errorCount
            archive.events = currentSessionEvents
            currentSessionArchive = archive
            persistCurrentSession()
        }
        sendAppLog(
            kind: "road_context_event",
            event: event,
            message: nil,
            sessionId: eventSessionId,
            backendURL: backendURL
        )
    }

    private func warmupOnly(_ event: RecorderEvent) -> Bool {
        guard currentSessionEvents.isEmpty, event.errorMessage == nil, let response = event.response else {
            return false
        }
        return !response.matched && (response.matchStatus == nil || response.matchStatus == "noMatch")
    }

    private func persistCurrentSession(refreshList: Bool = false) {
        guard let archive = currentSessionArchive else { return }
        archiveRevision += 1
        let revision = archiveRevision
        let archiveSessionId = archive.id
        Task {
            do {
                if let fileURL = try await sessionStore.save(archive, revision: revision), sessionId == archiveSessionId {
                    currentSessionFileURL = fileURL
                }
                if refreshList {
                    await reloadSavedSessions()
                }
            } catch {
                if sessionId == archiveSessionId {
                    statusText = "Errore salvataggio sessione"
                }
            }
        }
    }

    private var validatedBackendURL: URL? {
        let value = backendBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let url = URL(string: value),
            let scheme = url.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            url.host != nil
        else {
            return nil
        }
        return url
    }

    private func recordLocationError(_ error: Error) {
        guard isRecording, var archive = currentSessionArchive else {
            statusText = error.localizedDescription
            return
        }

        errorCount += 1
        statusText = error.localizedDescription
        archive.errorCount = errorCount
        archive.sentCount = sentCount
        archive.events = currentSessionEvents
        currentSessionArchive = archive
        persistCurrentSession()
        sendAppLog(
            kind: "location_error",
            event: nil,
            message: error.localizedDescription,
            sessionId: archive.id,
            backendURL: validatedBackendURL
        )
    }

    private func sendAppLog(
        kind: String,
        event: RecorderEvent?,
        message: String?,
        sessionId explicitSessionId: UUID? = nil,
        backendURL explicitBackendURL: URL? = nil
    ) {
        guard let backendURL = explicitBackendURL ?? validatedBackendURL else { return }
        let logSessionId = explicitSessionId ?? sessionId
        let payload = AppLogPayload(
            sessionId: logSessionId.uuidString,
            createdAt: isoFormatter.string(from: Date()),
            kind: kind,
            backendBaseURL: backendURL.absoluteString,
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
    private var latestRevisionBySession: [UUID: Int] = [:]

    init() {
        directoryURL = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("RoadRecorderSessions", isDirectory: true)
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    func save(_ archive: RecorderSessionArchive, revision: Int) throws -> URL? {
        let latestRevision = latestRevisionBySession[archive.id] ?? -1
        guard revision >= latestRevision else { return nil }
        try ensureDirectory()
        let fileURL = url(for: archive.id)
        let data = try encoder.encode(archive)
        try data.write(to: fileURL, options: [.atomic])
        latestRevisionBySession[archive.id] = revision
        return fileURL
    }

    func list() throws -> [SavedSessionSummary] {
        try ensureDirectory()
        let fileURLs = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )

        return fileURLs
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL in
                guard
                    let data = try? Data(contentsOf: fileURL),
                    let archive = try? decoder.decode(RecorderSessionArchive.self, from: data)
                else {
                    return nil
                }
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
        latestRevisionBySession.removeValue(forKey: session.id)
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
                finishCurrentSession(
                    status: "Permesso GPS negato",
                    logKind: "session_permission_denied",
                    message: "recording stopped because location permission was denied"
                )
            case .notDetermined:
                break
            @unknown default:
                finishCurrentSession(
                    status: "Permesso GPS sconosciuto",
                    logKind: "session_permission_unknown",
                    message: "recording stopped because location authorization status was unknown"
                )
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
            recordLocationError(error)
        }
    }
}
