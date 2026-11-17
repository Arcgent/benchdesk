// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BenchdeskCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "BenchdeskCore", targets: ["BenchdeskCore"])],
    targets: [
        .target(name: "BenchdeskCore"),
        .testTarget(name: "BenchdeskCoreTests", dependencies: ["BenchdeskCore"])
    ]
)
