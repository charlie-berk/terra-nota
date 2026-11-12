// Draws the app icon: a globe made from the app's real coastline data.
//     swift native/make_icon.swift web/data/world.js out.png

import Cocoa

let side = 1024.0
let source = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let start = source.firstIndex(of: "{")!
let end = source.lastIndex(of: "}")!
let world = try! JSONSerialization.jsonObject(with: Data(source[start...end].utf8)) as! [String: Any]
let grid = world["grid"] as! Double
let cut = world["cut"] as! Double
let countries = world["countries"] as! [[String: Any]]

/// Reads "M12 34l5-6 7 8z" into closed rings of grid coordinates, where
/// longitude = x * grid + cut and latitude = 90 - y * grid.
func rings(_ path: String) -> [[(Double, Double)]] {
    var out: [[(Double, Double)]] = []
    var ring: [(Double, Double)] = []
    var numbers: [Double] = []
    var token = ""
    var absolute = true
    var x = 0.0
    var y = 0.0

    func flushToken() {
        if !token.isEmpty, let value = Double(token) { numbers.append(value) }
        token = ""
        while numbers.count >= 2 {
            if absolute {
                x = numbers[0]
                y = numbers[1]
                absolute = false
            } else {
                x += numbers[0]
                y += numbers[1]
            }
            ring.append((x, y))
            numbers.removeFirst(2)
        }
    }

    for character in path {
        switch character {
        case "M":
            flushToken()
            absolute = true
        case "l":
            flushToken()
        case "z":
            flushToken()
            out.append(ring)
            ring = []
        case " ":
            flushToken()
        case "-":
            flushToken()
            token = "-"
        default:
            token.append(character)
        }
    }
    return out
}

let centreLon = 18.0 * .pi / 180
let centreLat = 24.0 * .pi / 180
let radius = 318.0
let middle = side / 2

/// Grid point -> orthographic point. Points on the far side land on the limb,
/// which keeps shapes that wrap the horizon closed.
func project(_ point: (Double, Double)) -> CGPoint {
    let lon = (point.0 * grid + cut) * .pi / 180
    let lat = (90 - point.1 * grid) * .pi / 180
    let delta = lon - centreLon
    var x = cos(lat) * sin(delta)
    var y = cos(centreLat) * sin(lat) - sin(centreLat) * cos(lat) * cos(delta)
    let facing = sin(centreLat) * sin(lat) + cos(centreLat) * cos(lat) * cos(delta)
    if facing < 0 {
        let length = max(hypot(x, y), 0.0001)
        x /= length
        y /= length
    }
    return CGPoint(x: middle + x * radius, y: middle + y * radius)
}

let color = { (hex: Int) in
    NSColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1).cgColor
}
let paper = 0xf4eee2
let sea = 0xc6d6d4
let land = 0xf8f3e8
let border = 0xa99c85
let been = 0xc4512b
let lived = 0x2f7a4a
let beenIds: Set<String> = ["FRA", "ESP", "ITA", "DEU", "GBR", "IRL", "PRT", "GRC", "TUR", "EGY", "MAR", "KEN", "TZA", "ZAF", "IND", "THA", "JPN"]
let livedIds: Set<String> = ["SWE", "NOR", "NAM"]

let context = CGContext(data: nil, width: Int(side), height: Int(side), bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

// The macOS icon shape: an 824 pt rounded square centred on a 1024 canvas.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -12), blur: 24, color: NSColor(white: 0, alpha: 0.28).cgColor)
context.addPath(tilePath)
context.setFillColor(color(paper))
context.fillPath()
context.restoreGState()

let disc = CGRect(x: middle - radius, y: middle - radius, width: radius * 2, height: radius * 2)
context.saveGState()
context.addEllipse(in: disc)
context.clip()
context.setFillColor(color(sea))
context.fill(disc)
context.setLineJoin(.round)
for country in countries {
    let id = country["id"] as! String
    let paths = country["paths"] as! [String]
    for ring in rings(paths[0]) where ring.count > 2 {
        context.beginPath()
        context.move(to: project(ring[0]))
        for point in ring.dropFirst() { context.addLine(to: project(point)) }
        context.closePath()
        let fill = livedIds.contains(id) ? lived : beenIds.contains(id) ? been : land
        context.setFillColor(color(fill))
        context.setStrokeColor(color(border))
        context.setLineWidth(1.6)
        context.drawPath(using: .fillStroke)
    }
}
context.restoreGState()

// The double rule of an atlas plate.
context.setStrokeColor(color(0x2a251f))
context.setLineWidth(9)
context.strokeEllipse(in: disc)
context.setLineWidth(3)
context.strokeEllipse(in: disc.insetBy(dx: -18, dy: -18))

let image = NSBitmapImageRep(cgImage: context.makeImage()!)
try! image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
