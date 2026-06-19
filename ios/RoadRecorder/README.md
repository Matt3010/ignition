# RoadRecorder

iOS client that records GPS samples and sends them to the backend `POST /api/v1/road-context`.

The backend URL is entered in the app, is required before recording starts, and is persisted locally after the user sets it.

Examples:

```sh
xcodebuild -project RoadRecorder.xcodeproj -scheme RoadRecorder -sdk iphonesimulator build
```

The backend does not manage external networking. It only exposes the internal HTTP entrypoint; Cloudflare Tunnel or any other ingress can be attached outside this app.
