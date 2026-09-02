// The Apple Intelligence helper, as source.
//
// Kept as a TS string rather than a `.swift` file on disk so it survives
// esbuild bundling with no asset-embedding step, and so the compiled binary can
// be cached by a hash of exactly the source that produced it.
//
// It reads {prompt, schema?} as JSON on stdin and writes the model's reply to
// stdout. A JSON Schema is translated at RUNTIME into a DynamicGenerationSchema,
// which is why this needs no per-schema Swift: Dailies' schemas live in
// TypeScript and are passed straight through.
//
// Requires macOS 26+ with Apple Intelligence enabled, and Xcode command line
// tools for `swiftc`. Exit codes are meaningful: 2 bad request, 3 model
// unavailable, 4 generation failed.

export const AFM_SWIFT_SOURCE = String.raw`import Foundation
import FoundationModels

// Translate a JSON-Schema fragment into a runtime DynamicGenerationSchema.
// Only the subset Dailies' schemas use is handled; anything unrecognized
// degrades to a string, which the tolerant JSON reader upstream can still cope
// with.
func build(_ node: [String: Any], name: String) throws -> DynamicGenerationSchema {
    let type = node["type"] as? String ?? "string"
    let desc = node["description"] as? String
    switch type {
    case "object":
        let props = node["properties"] as? [String: Any] ?? [:]
        let required = Set(node["required"] as? [String] ?? [])
        var out: [DynamicGenerationSchema.Property] = []
        // Sorted so the generated schema is deterministic run to run.
        for key in props.keys.sorted() {
            guard let child = props[key] as? [String: Any] else { continue }
            out.append(.init(name: key,
                             description: child["description"] as? String,
                             schema: try build(child, name: "\(name)_\(key)"),
                             isOptional: !required.contains(key)))
        }
        return DynamicGenerationSchema(name: name, description: desc, properties: out)
    case "array":
        let items = node["items"] as? [String: Any] ?? ["type": "string"]
        return DynamicGenerationSchema(arrayOf: try build(items, name: "\(name)_item"),
                                       minimumElements: node["minItems"] as? Int,
                                       maximumElements: node["maxItems"] as? Int)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    case "number":  return DynamicGenerationSchema(type: Double.self)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    default:        return DynamicGenerationSchema(type: String.self)
    }
}

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

@main
struct DailiesAppleIntelligence {
    static func main() async {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let req = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              let prompt = req["prompt"] as? String else {
            fail("expected {\"prompt\": string, \"schema\": object} on stdin", 2)
        }
        guard case .available = SystemLanguageModel.default.availability else {
            fail("Apple Intelligence is not available on this machine", 3)
        }
        do {
            let session = LanguageModelSession()
            if let schemaNode = req["schema"] as? [String: Any] {
                let schema = try GenerationSchema(root: try build(schemaNode, name: "Reply"),
                                                  dependencies: [])
                let reply = try await session.respond(to: prompt, schema: schema)
                print(reply.content.jsonString)
            } else {
                let reply = try await session.respond(to: prompt)
                print(reply.content)
            }
        } catch {
            fail("generation failed: \(error)", 4)
        }
    }
}
`;
