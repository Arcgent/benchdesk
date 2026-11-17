# Benchdesk for iOS (native SwiftUI)

A first native client for iPhone and iPad (iOS 16+). No WKWebView and no web app wrapper. Your Mac stays the base station; the app uses the mobile HTTPS bridge from `src/mobile/server.ts`.

## What is in the source

- Native pairing screen with a private HTTPS address and a one-time eight-digit code.
- Search conversations, see their status, read session notes and follow chat history.
- Terminal output as a readable text preview. It is not a terminal emulator: cursor movement and screen layout cannot be reproduced completely.
- Send messages to existing agent conversations, with explicit retries and the same message ID as long as the text does not change.
- Drafts and send status survive navigation in app memory, but not app termination or unpairing.
- The access cookie is stored in the device-bound Keychain, not in UserDefaults or logs. HTTPS is required, redirects are refused and standard TLS validation stays on.
- Revoke the pairing on the Mac, or forget it locally when the Mac cannot be reached.
- System colours for light and dark mode, Dynamic Type, text selection and native navigation.

Starting new tasks or sessions, resuming closed terminals, answering permission prompts, push notifications and offline execution are not in this first version. The app asks for no model or API keys of its own. Read polling stops when the app is not active.

## Open and build

1. Install Xcode with iOS platform support and open it once to finish the first-run setup.
2. Open `ios/Benchdesk.xcodeproj`, choose the **Benchdesk** scheme and an iPhone simulator. The local Swift package `BenchdeskCore` has no external package dependencies.
3. For a physical iPhone, choose your own **Team** under Signing & Capabilities. The provisional bundle ID is `nl.benchdesk.ios`; change it to one available under your team. Connect the device and switch on Developer Mode if needed.
4. Build & Run. TestFlight needs an Apple Developer account, App Store Connect configuration and a signed archive. Nothing has been published or uploaded.

From the repository, after installing Xcode:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/Benchdesk.xcodeproj -scheme Benchdesk \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath tmp/ios-derived-data \
  CODE_SIGNING_ALLOWED=NO build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test \
  --package-path ios/BenchdeskCore \
  --scratch-path tmp/ios-core-build
```

The app scheme has no iOS UI test target yet. `swift test` only runs the package tests, with a mock network on macOS.

A standalone check without XCTest:

```sh
swiftc -parse-as-library \
  ios/BenchdeskCore/Sources/BenchdeskCore/Models.swift \
  ios/BenchdeskCore/Sources/BenchdeskCore/StationClient.swift \
  ios/verify-core.swift \
  -o tmp/ios-core-check
tmp/ios-core-check
```

## Pair with your Mac

Follow the [bridge instructions](../docs/mobile.md#on-your-phone-through-tailscale) for a private HTTPS entry. Use Tailscale Serve, not Funnel. The app does not accept `http://localhost:5184` or an HTTP LAN address. The Mac and the iPhone must both reach the private base station; Benchdesk and the bridge must be running and the Mac must stay awake.

Open the native pairing screen and enter exactly the HTTPS origin configured for the bridge, plus the temporary code. Restarting the bridge revokes all pairings; otherwise they expire after at most thirty days. The bridge does not start automatically with the desktop app yet.

## What has and has not been checked

- The iOS Simulator build and the generic unsigned iPhoneOS build succeed, and the package tests pass.
- The pairing screen was checked in the simulator in light and dark mode and with larger text.
- Not checked yet: interactive pairing and chat in the native app, VoiceOver, all accessibility text sizes, background and foreground transitions on a device, Keychain storage of a real pairing, and anything on a physical iPhone.

## First device check

Test pairing and reopening, a wrong or expired code, chat paging and streaming, the terminal preview, notes, dark mode and large text. Check that drafts survive navigating back, uncertain sends with the same ID, a bridge restart (pair again), a sleeping Mac and unpairing. Only send a deliberately chosen test message to a conversation meant for it. There is no automatic resend and no confirming of agent permissions.

Apple sources: [Keychain](https://developer.apple.com/documentation/security/using-the-keychain-to-manage-user-secrets), [distribution and beta testing](https://developer.apple.com/documentation/Xcode/distributing-your-app-for-beta-testing-and-releases).
