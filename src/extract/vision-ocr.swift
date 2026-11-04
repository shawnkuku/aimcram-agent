// macOS Vision OCR 辅助程序（由 src/extract/image.mjs 编译调用）
// 用法：vision-ocr <image-path> [语言1,语言2]
// 输出：JSON 数组 [{ text, confidence, x, y }]
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
  FileHandle.standardError.write("usage: vision-ocr <image> [langs]\n".data(using: .utf8)!)
  exit(2)
}
let imagePath = args[1]
let langs = args.count > 2 ? args[2].split(separator: ",").map(String.init) : ["zh-Hans", "en-US"]

guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image: \(imagePath)\n".data(using: .utf8)!)
  exit(3)
}

func recognize(_ languages: [String]) throws -> [VNRecognizedTextObservation] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = languages
  if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = false
  }
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])
  return request.results ?? []
}

var observations: [VNRecognizedTextObservation] = []
do {
  observations = try recognize(langs)
} catch {
  // 某些系统缺少中文模型时回退到英文
  do {
    observations = try recognize(["en-US"])
  } catch {
    FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
    exit(4)
  }
}

var out: [[String: Any]] = []
for obs in observations {
  guard let top = obs.topCandidates(1).first else { continue }
  let box = obs.boundingBox
  out.append([
    "text": top.string,
    "confidence": Double(top.confidence),
    "x": Double(box.origin.x),
    "y": Double(box.origin.y),
    "w": Double(box.width),
    "h": Double(box.height)
  ])
}

let data = try JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
