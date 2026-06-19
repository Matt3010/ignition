import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var recorder: LocationRecorder
    @FocusState private var backendFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Backend URL richiesto", text: $recorder.backendBaseURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .focused($backendFocused)
                            .disabled(recorder.isRecording)

                        HStack(spacing: 10) {
                            Button {
                                backendFocused = false
                                recorder.isRecording ? recorder.stopRecording() : recorder.startRecording()
                            } label: {
                                Label(recorder.isRecording ? "Stop" : "Start recording", systemImage: recorder.isRecording ? "stop.fill" : "location.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!recorder.canStartRecording)

                            Button {
                                recorder.clearEvents()
                            } label: {
                                Image(systemName: "trash")
                                    .frame(width: 34)
                            }
                            .buttonStyle(.bordered)
                            .disabled(recorder.isRecording || recorder.events.isEmpty)
                        }
                    }
                }

                Section {
                    StatRow(title: "Stato", value: recorder.statusText)
                    StatRow(title: "Backend", value: recorder.backendBaseURL.isEmpty ? "richiesto" : recorder.backendBaseURL)
                    StatRow(title: "Sessione", value: recorder.sessionId.uuidString)
                    StatRow(title: "File sessione", value: recorder.currentSessionFileURL?.lastPathComponent ?? "n/d")
                    StatRow(title: "Campioni inviati", value: "\(recorder.sentCount)")
                    StatRow(title: "Errori", value: "\(recorder.errorCount)")
                    StatRow(title: "Ultima accuratezza", value: recorder.lastAccuracyText)
                }

                Section("Sessioni salvate") {
                    if recorder.savedSessions.isEmpty {
                        Text("Nessuna sessione salvata")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(recorder.savedSessions) { session in
                            SavedSessionRow(session: session) {
                                recorder.deleteSavedSession(session)
                            }
                        }
                    }
                }

                Section("Eventi") {
                    if recorder.events.isEmpty {
                        Text("Nessun evento")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(recorder.events) { event in
                            EventRow(event: event)
                        }
                    }
                }
            }
            .navigationTitle("Road Recorder")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Circle()
                        .fill(recorder.isRecording ? Color.green : Color.secondary)
                        .frame(width: 12, height: 12)
                        .accessibilityLabel(recorder.isRecording ? "Recording" : "Stopped")
                }
            }
        }
    }
}

private struct SavedSessionRow: View {
    let session: SavedSessionSummary
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.titleText)
                        .font(.subheadline.weight(.semibold))
                    Text(session.detailText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ShareLink(item: session.fileURL) {
                    Image(systemName: "square.and.arrow.down")
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.bordered)
            }

            if !session.backendBaseURL.isEmpty {
                Text(session.backendBaseURL)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive, action: onDelete) {
                Label("Elimina", systemImage: "trash")
            }
        }
        .padding(.vertical, 4)
    }
}

private struct StatRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct EventRow: View {
    let event: RecorderEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(event.timeText)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(event.resultText)
                    .font(.caption)
                    .foregroundStyle(event.errorMessage == nil ? Color.secondary : Color.red)
            }

            HStack(spacing: 12) {
                Label(event.speedText, systemImage: "speedometer")
                Label(event.positionText, systemImage: "location")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Text(event.debugLine)
                .font(.caption.monospaced())
                .foregroundStyle(event.errorMessage == nil ? Color.primary : Color.red)
                .lineLimit(nil)

            EventDetailLine(icon: "network", text: event.networkText)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let response = event.response {
                VStack(alignment: .leading, spacing: 5) {
                    EventDetailLine(
                        icon: response.matched ? "road.lanes" : "exclamationmark.triangle",
                        text: "match: \(response.matched ? "si" : "no"), confidenza \(percent(response.confidence))"
                    )
                    EventDetailLine(icon: "signpost.right", text: "strada: \(response.roadName ?? "non agganciata")")
                    EventDetailLine(icon: "number", text: "roadId: \(response.roadId ?? "n/d")")
                    EventDetailLine(icon: "point.3.connected.trianglepath.dotted", text: "tipo: \(response.roadType ?? "n/d"), direzione: \(response.direction)")
                    EventDetailLine(icon: "speedometer", text: limitCheckText(response))
                        .foregroundStyle(limitCheckColor(response))
                    EventDetailLine(icon: "clock", text: "dati: \(response.dataTimestamp)")

                    if response.alerts.isEmpty {
                        EventDetailLine(icon: "camera", text: "alert: nessuno")
                    } else {
                        ForEach(response.alerts, id: \.id) { alert in
                            EventAlertLine(alert: alert)
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if let errorMessage = event.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }

    private func limitCheckText(_ response: RoadContextResponse) -> String {
        guard let limit = response.speedLimitKmh else {
            return "limite: non verificabile"
        }
        let speed = event.sample.speedKmh
        if speed > Double(limit) + 2 {
            let delta = Int((speed - Double(limit)).rounded())
            return "limite: \(limit) km/h, sopra di \(delta) km/h"
        }
        return "limite: \(limit) km/h, ok"
    }

    private func limitCheckColor(_ response: RoadContextResponse) -> Color {
        guard let limit = response.speedLimitKmh else { return .secondary }
        return event.sample.speedKmh > Double(limit) + 2 ? .red : .secondary
    }

    private func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }
}

private struct EventDetailLine: View {
    let icon: String
    let text: String

    var body: some View {
        Label(text, systemImage: icon)
            .lineLimit(nil)
    }
}

private struct EventAlertLine: View {
    let alert: RoadAlert

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label("\(alert.type): \(Int(alert.distanceMeters.rounded())) m", systemImage: "camera.fill")
                .foregroundStyle(.orange)
            Text("id: \(alert.id)")
            Text("limite alert: \(alert.speedLimitKmh.map { "\($0) km/h" } ?? "n/d"), direzione: \(alert.direction), confidenza: \(percent(alert.confidence))")
            Text(String(format: "posizione alert: %.5f, %.5f", alert.latitude, alert.longitude))
        }
        .padding(.leading, 2)
    }

    private func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }
}
