import MapKit
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

                if recorder.isRecording || !recorder.routeCoordinates.isEmpty {
                    Section("Mappa registrazione") {
                        RecordingMapView()
                            .frame(height: 300)
                            .listRowInsets(EdgeInsets())
                    }
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
                        text: "match: \(response.matched ? "si" : "no"), stato \(response.matchStatus ?? "legacy"), confidenza \(percent(response.confidence))"
                    )
                    EventDetailLine(icon: "signpost.right", text: "strada: \(response.roadName ?? "non agganciata")")
                    EventDetailLine(icon: "number", text: "roadId: \(response.roadId ?? "n/d")")
                    EventDetailLine(icon: "point.3.connected.trianglepath.dotted", text: "tipo: \(response.roadType ?? "n/d"), direzione: \(response.direction)")
                    EventDetailLine(icon: "speedometer", text: limitCheckText(response))
                        .foregroundStyle(limitCheckColor(response))
                    EventDetailLine(icon: "clock", text: "campione GPS: \(response.dataTimestamp)")

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
        let source = DriveEventFormatter.speedLimitSourceText(response.speedLimitSource)
        let speed = event.sample.speedKmh
        if speed > Double(limit) + 2 {
            let delta = Int((speed - Double(limit)).rounded())
            return "limite: \(limit) km/h (\(source)), sopra di \(delta) km/h"
        }
        return "limite: \(limit) km/h (\(source)), ok"
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
            Label("\(DriveEventFormatter.alertTypeText(alert.type)): \(Int(alert.distanceMeters.rounded())) m", systemImage: "camera.fill")
                .foregroundStyle(.orange)
            Text("id: \(alert.id)")
            Text("limite alert: \(alert.speedLimitKmh.map { "\($0) km/h" } ?? "n/d") (\(DriveEventFormatter.speedLimitSourceText(alert.speedLimitSource))), direzione: \(alert.direction), confidenza: \(percent(alert.confidence))")
            if let operationalStatus = alert.operationalStatus {
                Text("stato: \(DriveEventFormatter.operationalStatusText(operationalStatus))")
                    .foregroundStyle(operationalStatus == "notOperational" ? Color.orange : Color.secondary)
            }
            if let statusReason = alert.statusReason, !statusReason.isEmpty {
                Text("motivo OSM: \(statusReason)")
                    .foregroundStyle(.secondary)
            }
            if let bearings = alert.directionBearings, !bearings.isEmpty {
                Text("direzioni OSM: \(bearings.map { String(Int($0.rounded())) + "°" }.joined(separator: ", "))")
                    .foregroundStyle(.secondary)
            }
            if let presence = alert.osmPresenceStatus {
                Text("presenza OSM: \(presence == "missingFromLatestImport" ? "mancante dall’ultimo import" : "presente")")
                    .foregroundStyle(presence == "missingFromLatestImport" ? Color.orange : Color.secondary)
            }
            if alert.active == false {
                Text("record backend: inattivo ma mantenuto").foregroundStyle(.orange)
            }
            if alert.positionApproximate == true {
                Text("posizione OSM: approssimativa").foregroundStyle(.orange)
            }
            if let osmId = alert.osmId {
                let identity = [alert.osmType, osmId].compactMap { $0 }.joined(separator: "/")
                Text("elemento OSM: \(identity)").foregroundStyle(.secondary)
            }
            if let relationId = alert.osmRelationId {
                Text("relazione OSM: \(relationId)").foregroundStyle(.secondary)
            }
            if let osmTimestamp = alert.osmTimestamp {
                Text("aggiornamento OSM: \(osmTimestamp)").foregroundStyle(.secondary)
            }
            Text(String(format: "posizione alert: %.5f, %.5f", alert.latitude, alert.longitude))
        }
        .padding(.leading, 2)
    }

    private func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }
}


private struct RecordingMapView: View {
    @EnvironmentObject private var recorder: LocationRecorder
    @State private var cameraPosition: MapCameraPosition = .automatic

    var body: some View {
        ZStack(alignment: .top) {
            Map(position: $cameraPosition) {
                if let coordinate = recorder.currentCoordinate,
                   let accuracy = recorder.currentHorizontalAccuracyMeters,
                   accuracy > 0 {
                    MapCircle(center: coordinate, radius: accuracy)
                        .foregroundStyle(.blue.opacity(0.12))
                        .stroke(.blue.opacity(0.45), lineWidth: 1)
                }

                ForEach(routeSegments) { segment in
                    MapPolyline(coordinates: [segment.start.coordinate, segment.end.coordinate])
                        .stroke(traceColor(for: segment.end), lineWidth: 5)
                }

                ForEach(recorder.speedViolationPoints) { violation in
                    Annotation("Superamento limite", coordinate: violation.coordinate) {
                        VStack(spacing: 2) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(6)
                                .background(.red, in: Circle())
                                .overlay(Circle().stroke(.white, lineWidth: 2))

                            Text("\(Int(violation.speedKmh.rounded()))/\(violation.speedLimitKmh)")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.red)
                                .padding(.horizontal, 4)
                                .background(.regularMaterial, in: Capsule())
                        }
                        .accessibilityLabel("Limite superato: velocità \(Int(violation.speedKmh.rounded())) chilometri orari, limite \(violation.speedLimitKmh)")
                    }
                }

                ForEach(recorder.mapAlerts, id: \.id) { alert in
                    Annotation(
                        DriveEventFormatter.alertTypeText(alert.type),
                        coordinate: CLLocationCoordinate2D(latitude: alert.latitude, longitude: alert.longitude)
                    ) {
                        VStack(spacing: 2) {
                            Image(systemName: symbolName(for: alert.type))
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(7)
                                .background(alertColor(alert), in: Circle())
                                .overlay(Circle().stroke(.white, style: StrokeStyle(lineWidth: 2, dash: alert.positionApproximate == true ? [3, 2] : [])))
                                .shadow(radius: 2)

                            Text("\(Int(alert.distanceMeters.rounded())) m")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 4)
                                .background(.regularMaterial, in: Capsule())
                        }
                        .opacity(alertOpacity(alert))
                        .accessibilityLabel(alertAccessibilityLabel(alert))
                    }
                }

                if let coordinate = recorder.currentCoordinate {
                    Annotation("Posizione corrente", coordinate: coordinate) {
                        Image(systemName: "location.north.fill")
                            .font(.title3)
                            .foregroundStyle(.white)
                            .padding(8)
                            .background(.blue, in: Circle())
                            .overlay(Circle().stroke(.white, lineWidth: 2))
                            .shadow(radius: 3)
                            .rotationEffect(.degrees(recorder.currentCourseDegrees ?? 0))
                            .animation(.easeOut(duration: 0.2), value: recorder.currentCourseDegrees)
                    }
                }
            }
            .mapControls {
                MapCompass()
                MapScaleView()
            }

            mapStatusOverlay
                .padding(8)
        }
        .onAppear(perform: centerOnCurrentPosition)
        .onChange(of: coordinateKey) { _, _ in centerOnCurrentPosition() }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    private var mapStatusOverlay: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(recorder.currentRoadContext?.roadName ?? "Strada non riconosciuta")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text("\(Int(recorder.currentSpeedKmh.rounded())) km/h · GPS \(accuracyText)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let alert = nearestAlert {
                    Label("\(DriveEventFormatter.alertTypeText(alert.type)) · \(Int(alert.distanceMeters.rounded())) m", systemImage: symbolName(for: alert.type))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
            }
            .padding(8)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))

            Spacer(minLength: 4)

            speedLimitBadge
        }
    }

    private var speedLimitBadge: some View {
        ZStack {
            Circle().fill(.white)
            Circle().stroke(limitBadgeColor, lineWidth: 5)
            Text(recorder.currentRoadContext?.speedLimitKmh.map(String.init) ?? "—")
                .font(.headline.weight(.bold))
                .foregroundStyle(.black)
        }
        .frame(width: 54, height: 54)
        .shadow(radius: 2)
        .accessibilityLabel("Limite corrente \(recorder.currentRoadContext?.speedLimitKmh.map { "\($0) chilometri orari" } ?? "non disponibile")")
    }

    private var limitBadgeColor: Color {
        guard let limit = recorder.currentRoadContext?.speedLimitKmh, limit > 0 else { return .secondary }
        return recorder.currentSpeedKmh > Double(limit) ? .red : .green
    }

    private var accuracyText: String {
        guard let accuracy = recorder.currentHorizontalAccuracyMeters else { return "n/d" }
        return "\(Int(accuracy.rounded())) m"
    }

    private var nearestAlert: RoadAlert? {
        recorder.currentRoadContext?.alerts.min { $0.distanceMeters < $1.distanceMeters }
    }

    private struct RouteSegment: Identifiable {
        let start: RecordedRoutePoint
        let end: RecordedRoutePoint
        var id: UUID { end.id }
    }

    private var routeSegments: [RouteSegment] {
        guard recorder.routePoints.count >= 2 else { return [] }
        return zip(recorder.routePoints, recorder.routePoints.dropFirst()).map { RouteSegment(start: $0.0, end: $0.1) }
    }

    private func traceColor(for point: RecordedRoutePoint) -> Color {
        guard let limit = point.speedLimitKmh, limit > 0 else { return .green }
        let ratio = min(max(point.speedKmh / Double(limit), 0), 1)
        return Color(hue: (1 - ratio) * 0.33, saturation: 0.9, brightness: 0.9)
    }

    private func alertColor(_ alert: RoadAlert) -> Color {
        if alert.operationalStatus == "notOperational" || alert.active == false { return .gray }
        switch alert.type {
        case "fixedSpeedCamera", "averageSpeedCamera", "mobileSpeedCamera", "redLightCamera": return .red
        case "roadWorks", "roadClosure": return .orange
        case "policeControl": return .blue
        default: return .orange
        }
    }

    private func alertOpacity(_ alert: RoadAlert) -> Double {
        if alert.operationalStatus == "notOperational" || alert.active == false { return 0.45 }
        return max(0.5, min(alert.confidence, 1))
    }

    private func alertAccessibilityLabel(_ alert: RoadAlert) -> String {
        let precision = alert.positionApproximate == true ? "posizione approssimativa" : "posizione precisa"
        return "\(DriveEventFormatter.alertTypeText(alert.type)), distanza \(Int(alert.distanceMeters.rounded())) metri, confidenza \(Int((alert.confidence * 100).rounded())) percento, \(precision)"
    }

    private var coordinateKey: String {
        guard let coordinate = recorder.currentCoordinate else { return "none" }
        return "\(coordinate.latitude),\(coordinate.longitude)"
    }

    private func centerOnCurrentPosition() {
        guard let coordinate = recorder.currentCoordinate else { return }
        cameraPosition = .region(MKCoordinateRegion(center: coordinate, latitudinalMeters: 1_500, longitudinalMeters: 1_500))
    }

    private func symbolName(for type: String) -> String {
        switch type {
        case "speed_camera", "speedCamera", "fixedSpeedCamera", "averageSpeedCamera", "mobileSpeedCamera", "redLightCamera": return "camera.fill"
        case "road_works", "roadWorks": return "wrench.and.screwdriver.fill"
        case "roadClosure": return "nosign"
        case "accident": return "car.side.rear.and.collision.and.car.side.front"
        case "police_control", "policeControl": return "shield.fill"
        case "accessControl": return "lock.fill"
        case "weightControl": return "scalemass.fill"
        default: return "exclamationmark.triangle.fill"
        }
    }
}

