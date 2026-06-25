import MapKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var recorder: LocationRecorder
    @FocusState private var backendFocused: Bool
    @State private var isMapFullScreen = false
    @State private var mapCameraPosition: MapCameraPosition = .automatic
    @State private var hasCenteredMapInitially = false

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
                        RecordingMapView(
                            cameraPosition: $mapCameraPosition,
                            hasCenteredInitially: $hasCenteredMapInitially,
                            showsAlertLegend: false,
                            mapActionSystemImage: "arrow.up.left.and.arrow.down.right",
                            mapActionAccessibilityLabel: "Apri mappa a schermo intero",
                            onMapAction: { isMapFullScreen = true }
                        )
                            .frame(height: 300)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
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
        .fullScreenCover(isPresented: $isMapFullScreen) {
            FullScreenRecordingMapView(
                cameraPosition: $mapCameraPosition,
                hasCenteredInitially: $hasCenteredMapInitially,
                onClose: { isMapFullScreen = false }
            )
            .environmentObject(recorder)
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
                    EventDetailLine(
                        icon: response.alertsStatus == "unavailable" ? "exclamationmark.triangle" : response.alertsStatus == "empty" ? "checkmark.circle" : "checkmark.circle",
                        text: response.alertsStatus == "unavailable" ? "alert: non disponibili" : response.alertsStatus == "empty" ? "alert: disponibili, nessun dato presente" : "alert: disponibili"
                    )

                    if response.alertsStatus == "unavailable" {
                        EmptyView()
                    } else if response.alerts.isEmpty {
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


private struct FullScreenRecordingMapView: View {
    @Binding var cameraPosition: MapCameraPosition
    @Binding var hasCenteredInitially: Bool
    let onClose: () -> Void

    var body: some View {
        ZStack {
            RecordingMapView(
                cameraPosition: $cameraPosition,
                hasCenteredInitially: $hasCenteredInitially,
                showsAlertLegend: true,
                mapActionSystemImage: "xmark",
                mapActionAccessibilityLabel: "Chiudi mappa a schermo intero",
                onMapAction: onClose
            )
        }
    }
}


private struct RecordingMapView: View {
    @EnvironmentObject private var recorder: LocationRecorder
    @Binding var cameraPosition: MapCameraPosition
    @Binding var hasCenteredInitially: Bool
    @State private var isAlertLegendExpanded = false
    let showsAlertLegend: Bool
    let mapActionSystemImage: String
    let mapActionAccessibilityLabel: String
    let onMapAction: () -> Void
    private let maxGenericAlertAnnotations = 160

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

                if smoothedRouteCoordinates.count >= 2 {
                    MapPolyline(coordinates: smoothedRouteCoordinates)
                        .stroke(.blue, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
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

                ForEach(visibleMapAlerts, id: \.id) { alert in
                    let isPriority = alert.relevance == "route"
                    Annotation(
                        DriveEventFormatter.alertTypeText(alert.type),
                        coordinate: CLLocationCoordinate2D(latitude: alert.latitude, longitude: alert.longitude)
                    ) {
                        VStack(spacing: 2) {
                            Image(systemName: symbolName(for: alert.type))
                                .font(isPriority ? .caption.weight(.bold) : .caption2.weight(.semibold))
                                .foregroundStyle(isPriority ? Color.white : alertColor(alert))
                                .padding(isPriority ? 8 : 6)
                                .background {
                                    if isPriority {
                                        Circle().fill(alertColor(alert))
                                    } else {
                                        Circle().fill(.regularMaterial)
                                    }
                                }
                                .overlay {
                                    Circle().stroke(
                                        isPriority ? Color.white : alertColor(alert),
                                        style: StrokeStyle(
                                            lineWidth: isPriority ? 2.5 : 1.5,
                                            dash: alert.positionApproximate == true ? [3, 2] : []
                                        )
                                    )
                                }
                                .shadow(radius: isPriority ? 3 : 1)

                            Text(distanceText(alert.distanceMeters))
                                .font(.caption2.weight(isPriority ? .bold : .medium))
                                .foregroundStyle(isPriority ? Color.primary : Color.secondary)
                                .padding(.horizontal, 4)
                                .background(.regularMaterial, in: Capsule())
                        }
                        .opacity(isPriority ? alertOpacity(alert) : min(alertOpacity(alert), 0.72))
                        .accessibilityLabel(alertAccessibilityLabel(alert, isPriority: isPriority))
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
            .ignoresSafeArea(.container, edges: showsAlertLegend ? .all : [])

            mapStatusOverlay
                .padding(8)

            if showsAlertLegend {
                VStack {
                    Spacer()
                    HStack {
                        alertLegend
                        Spacer()
                    }
                    .padding(16)
                }
            }

            VStack {
                Spacer()
                HStack {
                    Spacer()
                    VStack(spacing: 10) {
                        Button(action: centerOnCurrentPosition) {
                            Image(systemName: "location.fill")
                                .font(.headline.weight(.semibold))
                                .padding(12)
                                .background(.regularMaterial, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(recorder.currentCoordinate == nil)
                        .opacity(recorder.currentCoordinate == nil ? 0.45 : 1)
                        .accessibilityLabel("Centra sulla posizione corrente")

                        Button(action: onMapAction) {
                            Image(systemName: mapActionSystemImage)
                                .font(.headline.weight(.semibold))
                                .padding(12)
                                .background(.regularMaterial, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(mapActionAccessibilityLabel)
                    }
                }
                .padding(12)
            }
        }
        .onAppear(perform: centerOnCurrentPositionOnce)
        .onChange(of: coordinateKey) { _, _ in centerOnCurrentPositionOnce() }
    }

    private var mapStatusOverlay: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(recorder.currentRoadContext?.roadName ?? "Strada non riconosciuta")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Label("Precisione \(accuracyText)", systemImage: "location.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if recorder.currentRoadContext?.alertsStatus == "unavailable" {
                    Label("Alert non disponibili", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                } else if let alert = nearestAlert {
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

    private var visibleMapAlerts: [RoadAlert] {
        var result: [RoadAlert] = []
        var included = Set<String>()

        for alert in recorder.mapAlerts where alert.relevance == "route" {
            result.append(alert)
            included.insert(alert.id)
        }

        for alert in recorder.mapAlerts where !included.contains(alert.id) {
            guard result.count < maxGenericAlertAnnotations else { break }
            result.append(alert)
            included.insert(alert.id)
        }

        return result.sorted { lhs, rhs in
            if (lhs.relevance == "route") != (rhs.relevance == "route") {
                return lhs.relevance == "route"
            }
            if lhs.distanceMeters == rhs.distanceMeters {
                return lhs.id < rhs.id
            }
            return lhs.distanceMeters < rhs.distanceMeters
        }
    }

    private var hiddenMapAlertCount: Int {
        max(0, recorder.mapAlerts.count - visibleMapAlerts.count)
    }

    private var alertLegend: some View {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                isAlertLegendExpanded.toggle()
            }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    legendItem(
                        title: "Autovelox",
                        systemImage: "camera.fill",
                        color: .red,
                        style: .iconOnly
                    )

                    Divider()
                        .frame(height: 18)

                    legendItem(
                        title: "Accesso",
                        systemImage: "lock.fill",
                        color: .blue,
                        style: .iconOnly
                    )

                    Image(systemName: isAlertLegendExpanded ? "chevron.down" : "chevron.up")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }

                if isAlertLegendExpanded {
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Icona")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                            legendItem(title: "Autovelox, tutor, photored", systemImage: "camera.fill", color: .red, style: .iconOnly)
                            legendItem(title: "Accesso controllato / ZTL", systemImage: "lock.fill", color: .blue, style: .iconOnly)
                        }

                        VStack(alignment: .leading, spacing: 5) {
                            Text("Cerchio")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                            legendItem(title: "Pieno: sul percorso", systemImage: "camera.fill", color: .red, style: .filled)
                            legendItem(title: "Vuoto: vicino, non sul percorso", systemImage: "camera.fill", color: .red, style: .outline)
                            legendItem(title: "Bordo continuo: posizione precisa", systemImage: "camera.fill", color: .red, style: .outline)
                            legendItem(title: "Bordo tratteggiato: posizione approssimativa", systemImage: "camera.fill", color: .red, style: .dashedOutline)
                            legendItem(title: "Grigio: non operativo", systemImage: "camera.fill", color: .gray, style: .filled)
                        }

                        if hiddenMapAlertCount > 0 {
                            Text("Mostrati \(visibleMapAlerts.count) di \(recorder.mapAlerts.count) alert")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .buttonStyle(.plain)
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.35), lineWidth: 0.5))
        .shadow(radius: 2, y: 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Legenda alert. Tocca per \(isAlertLegendExpanded ? "ridurre" : "espandere")")
    }

    private enum LegendMarkerStyle: Equatable {
        case iconOnly
        case filled
        case outline
        case dashedOutline
    }

    private func legendItem(title: String, systemImage: String, color: Color, style: LegendMarkerStyle) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(style == .filled ? Color.white : color)
                .frame(width: 18, height: 18)
                .background {
                    if style != .iconOnly {
                        Circle().fill(style == .filled ? color : Color.clear)
                    }
                }
                .overlay {
                    if style != .iconOnly {
                        Circle().stroke(
                            style == .filled ? Color.white : color,
                            style: StrokeStyle(lineWidth: 1.25, dash: style == .dashedOutline ? [3, 2] : [])
                        )
                    }
                }

            Text(title)
                .lineLimit(2)
        }
    }

    private var smoothedRouteCoordinates: [CLLocationCoordinate2D] {
        smooth(recorder.routeCoordinates, iterations: 2)
    }

    /// Chaikin corner cutting keeps the trace connected while rounding GPS
    /// corners without making the map camera follow every incoming sample.
    private func smooth(
        _ coordinates: [CLLocationCoordinate2D],
        iterations: Int
    ) -> [CLLocationCoordinate2D] {
        guard coordinates.count >= 3, iterations > 0 else { return coordinates }

        var result = coordinates
        for _ in 0..<iterations {
            guard let first = result.first, let last = result.last else { return result }
            var next: [CLLocationCoordinate2D] = []
            next.reserveCapacity(result.count * 2)
            next.append(first)

            for index in 0..<(result.count - 1) {
                let start = result[index]
                let end = result[index + 1]
                next.append(interpolate(from: start, to: end, progress: 0.25))
                next.append(interpolate(from: start, to: end, progress: 0.75))
            }

            next.append(last)
            result = next
        }
        return result
    }

    private func interpolate(
        from start: CLLocationCoordinate2D,
        to end: CLLocationCoordinate2D,
        progress: Double
    ) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: start.latitude + ((end.latitude - start.latitude) * progress),
            longitude: start.longitude + ((end.longitude - start.longitude) * progress)
        )
    }

    private func alertColor(_ alert: RoadAlert) -> Color {
        if alert.operationalStatus == "notOperational" || alert.active == false { return .gray }
        switch alert.type {
        case "fixedSpeedCamera", "averageSpeedCamera", "redLightCamera": return .red
        case "accessControl": return .blue
        default: return .orange
        }
    }

    private func alertOpacity(_ alert: RoadAlert) -> Double {
        if alert.operationalStatus == "notOperational" || alert.active == false { return 0.45 }
        return max(0.5, min(alert.confidence, 1))
    }

    private func alertAccessibilityLabel(_ alert: RoadAlert, isPriority: Bool) -> String {
        let category = isPriority ? "alert sul percorso" : "alert vicino, non sul percorso"
        let precision = alert.positionApproximate == true ? "posizione approssimativa" : "posizione precisa"
        return "\(category), \(DriveEventFormatter.alertTypeText(alert.type)), distanza \(Int(alert.distanceMeters.rounded())) metri, confidenza \(Int((alert.confidence * 100).rounded())) percento, \(precision)"
    }

    private func distanceText(_ meters: Double) -> String {
        if meters >= 1_000 {
            return String(format: "%.1f km", meters / 1_000)
        }
        return "\(Int(meters.rounded())) m"
    }

    private var coordinateKey: String {
        guard let coordinate = recorder.currentCoordinate else { return "none" }
        return "\(coordinate.latitude),\(coordinate.longitude)"
    }

    private func centerOnCurrentPositionOnce() {
        guard !hasCenteredInitially, let coordinate = recorder.currentCoordinate else { return }
        hasCenteredInitially = true
        setCamera(center: coordinate, meters: 1_500)
    }

    private func centerOnCurrentPosition() {
        guard let coordinate = recorder.currentCoordinate else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
            setCamera(center: coordinate, meters: 500)
        }
    }

    private func setCamera(center coordinate: CLLocationCoordinate2D, meters: CLLocationDistance) {
        cameraPosition = .region(
            MKCoordinateRegion(
                center: coordinate,
                latitudinalMeters: meters,
                longitudinalMeters: meters
            )
        )
    }

    private func symbolName(for type: String) -> String {
        switch type {
        case "speed_camera", "speedCamera", "fixedSpeedCamera", "averageSpeedCamera", "redLightCamera": return "camera.fill"
        case "accessControl": return "lock.fill"
        default: return "exclamationmark.triangle.fill"
        }
    }
}
