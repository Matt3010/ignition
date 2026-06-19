import SwiftUI

@main
struct RoadRecorderApp: App {
    @StateObject private var recorder = LocationRecorder()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
        }
    }
}
