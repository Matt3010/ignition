import Foundation

struct RoadContextSample: Codable {
    let latitude: Double
    let longitude: Double
    let speedKmh: Double
    let course: Double?
    let horizontalAccuracyMeters: Double
    let timestamp: String
    let sessionId: String

    enum CodingKeys: String, CodingKey {
        case latitude
        case longitude
        case speedKmh
        case course
        case horizontalAccuracyMeters
        case timestamp
        case sessionId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(latitude, forKey: .latitude)
        try container.encode(longitude, forKey: .longitude)
        try container.encode(speedKmh, forKey: .speedKmh)
        if let course {
            try container.encode(course, forKey: .course)
        } else {
            try container.encodeNil(forKey: .course)
        }
        try container.encode(horizontalAccuracyMeters, forKey: .horizontalAccuracyMeters)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(sessionId, forKey: .sessionId)
    }
}

struct RoadContextResponse: Codable {
    let matched: Bool
    let roadId: String?
    let roadName: String?
    let speedLimitKmh: Int?
    let roadType: String?
    let confidence: Double
    let direction: String
    let dataTimestamp: String
    let alerts: [RoadAlert]

    var limitText: String {
        guard let speedLimitKmh else { return "n/d" }
        return "\(speedLimitKmh) km/h"
    }
}

struct RoadAlert: Codable {
    let id: String
    let type: String
    let distanceMeters: Double
    let speedLimitKmh: Int?
    let latitude: Double
    let longitude: Double
    let direction: String
    let confidence: Double
}

struct RecorderEvent: Identifiable, Codable {
    let id: UUID
    let sample: RoadContextSample
    let response: RoadContextResponse?
    let errorMessage: String?
    let debugLine: String
    let requestStartedAt: String?
    let requestEndedAt: String?
    let latencyMs: Double?
    let httpStatusCode: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case sample
        case response
        case errorMessage
        case debugLine
        case requestStartedAt
        case requestEndedAt
        case latencyMs
        case httpStatusCode
    }

    init(
        id: UUID = UUID(),
        sample: RoadContextSample,
        response: RoadContextResponse?,
        errorMessage: String?,
        requestStartedAt: String? = nil,
        requestEndedAt: String? = nil,
        latencyMs: Double? = nil,
        httpStatusCode: Int? = nil
    ) {
        self.id = id
        self.sample = sample
        self.response = response
        self.errorMessage = errorMessage
        self.requestStartedAt = requestStartedAt
        self.requestEndedAt = requestEndedAt
        self.latencyMs = latencyMs
        self.httpStatusCode = httpStatusCode
        self.debugLine = DriveEventFormatter.format(sample: sample, response: response, errorMessage: errorMessage)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        sample = try container.decode(RoadContextSample.self, forKey: .sample)
        response = try container.decodeIfPresent(RoadContextResponse.self, forKey: .response)
        errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        requestStartedAt = try container.decodeIfPresent(String.self, forKey: .requestStartedAt)
        requestEndedAt = try container.decodeIfPresent(String.self, forKey: .requestEndedAt)
        latencyMs = try container.decodeIfPresent(Double.self, forKey: .latencyMs)
        httpStatusCode = try container.decodeIfPresent(Int.self, forKey: .httpStatusCode)
        debugLine = try container.decodeIfPresent(String.self, forKey: .debugLine)
            ?? DriveEventFormatter.format(sample: sample, response: response, errorMessage: errorMessage)
    }

    var timeText: String {
        sample.timestamp
            .split(separator: "T")
            .last?
            .replacingOccurrences(of: "Z", with: "")
            .prefix(8)
            .description ?? sample.timestamp
    }

    var speedText: String {
        "\(Int(sample.speedKmh.rounded())) km/h"
    }

    var positionText: String {
        String(format: "%.5f, %.5f", sample.latitude, sample.longitude)
    }

    var resultText: String {
        if errorMessage != nil { return "errore" }
        guard let response else { return "n/d" }
        return response.matched ? "\(Int((response.confidence * 100).rounded()))%" : "no match"
    }

    var networkText: String {
        let status = httpStatusCode.map { "HTTP \($0)" } ?? "HTTP n/d"
        let latency = latencyMs.map { "\(Int($0.rounded())) ms" } ?? "n/d ms"
        return "\(status), latenza \(latency)"
    }
}

enum DriveEventFormatter {
    static func format(sample: RoadContextSample, response: RoadContextResponse?, errorMessage: String?) -> String {
        let speed = "\(Int(sample.speedKmh.rounded())) km/h"

        guard let response else {
            return "\(speed), richiesta fallita, \(errorMessage ?? "errore sconosciuto")"
        }

        let roadLabel = response.matched
            ? roadName(response)
            : "strada non agganciata"
        let limitLabel = response.speedLimitKmh.map { "limite \($0) km/h" } ?? "limite sconosciuto"
        let speedStatus = speedStatus(sample: sample, response: response)
        let nearestAlert = response.alerts.first.map {
            "alert \($0.type) a \(Int($0.distanceMeters.rounded())) m"
        } ?? "nessun alert vicino"

        return "\(speed), \(roadLabel), \(limitLabel), \(speedStatus), \(nearestAlert)"
    }

    private static func roadName(_ response: RoadContextResponse) -> String {
        let name = response.roadName ?? response.roadId ?? "strada senza nome"
        guard let roadType = response.roadType else { return name }
        return "\(name) (\(roadType))"
    }

    private static func speedStatus(sample: RoadContextSample, response: RoadContextResponse) -> String {
        guard let limit = response.speedLimitKmh else {
            return "limite non verificabile"
        }
        if sample.speedKmh > Double(limit) + 2 {
            return "LIMITE SUPERATO di \(Int((sample.speedKmh - Double(limit)).rounded())) km/h"
        }
        return "velocita ok"
    }
}

struct RoadContextClientResult {
    let response: RoadContextResponse
    let httpStatusCode: Int
}

struct AppLogCounters: Encodable {
    let sentCount: Int
    let errorCount: Int
    let localEventCount: Int
}

struct AppLogPayload: Encodable {
    let sessionId: String
    let createdAt: String
    let kind: String
    let platform: String
    let appName: String
    let appVersion: String
    let backendBaseURL: String
    let message: String?
    let counters: AppLogCounters
    let event: RecorderEvent?

    init(
        sessionId: String,
        createdAt: String,
        kind: String,
        backendBaseURL: String,
        message: String?,
        counters: AppLogCounters,
        event: RecorderEvent?
    ) {
        self.sessionId = sessionId
        self.createdAt = createdAt
        self.kind = kind
        self.platform = "ios"
        self.appName = "RoadRecorder"
        self.appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        self.backendBaseURL = backendBaseURL
        self.message = message
        self.counters = counters
        self.event = event
    }
}

final class RoadContextClient {
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession = .shared) {
        self.session = session
    }

    func send(sample: RoadContextSample, backendBaseURL: URL) async throws -> RoadContextClientResult {
        let url = backendBaseURL.appending(path: "/api/v1/road-context")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(sample)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw RoadContextClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            throw RoadContextClientError.http(httpResponse.statusCode, message)
        }
        let decoded = try decoder.decode(RoadContextResponse.self, from: data)
        return RoadContextClientResult(response: decoded, httpStatusCode: httpResponse.statusCode)
    }

    func sendAppLog(payload: AppLogPayload, backendBaseURL: URL) async throws {
        let url = backendBaseURL.appending(path: "/api/v1/app-logs")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(payload)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw RoadContextClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw RoadContextClientError.http(httpResponse.statusCode, "App log upload failed")
        }
    }
}

enum RoadContextClientError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Backend URL richiesto"
        case .invalidResponse:
            return "Risposta backend non valida"
        case .http(let status, let message):
            return "HTTP \(status): \(message)"
        }
    }
}
