import { describe, expect, it } from "vitest";
import {
  buildImageRequestBody,
  describeImageCurl,
  imageFromResponse,
} from "./local-image.js";

describe("buildImageRequestBody", () => {
  it("requests a single base64 image at the video's pixel size", () => {
    const body = buildImageRequestBody({
      directionText: "noir jazz",
      width: 1280,
      height: 720,
    });
    expect(body.size).toBe("1280x720");
    expect(body.n).toBe(1);
    expect(body.response_format).toBe("b64_json");
    expect(String(body.prompt)).toContain("noir jazz");
    // The image prompt forbids text and asks for negative space.
    expect(String(body.prompt).toLowerCase()).toContain("no text");
    expect(body.model).toBeUndefined();
  });
  it("includes the model when configured", () => {
    expect(
      buildImageRequestBody({
        directionText: "x",
        width: 100,
        height: 100,
        model: "sdxl",
      }).model
    ).toBe("sdxl");
  });
});

describe("imageFromResponse", () => {
  it("decodes data[0].b64_json", () => {
    const b64 = Buffer.from("PNGDATA").toString("base64");
    const found = imageFromResponse({ data: [{ b64_json: b64 }] });
    expect(found?.bytes?.toString()).toBe("PNGDATA");
  });
  it("returns a url when only a url is present", () => {
    expect(imageFromResponse({ data: [{ url: "https://x/y.png" }] })).toEqual({
      url: "https://x/y.png",
    });
  });
  it("returns null for an empty or malformed response", () => {
    expect(imageFromResponse({ data: [] })).toBeNull();
    expect(imageFromResponse({})).toBeNull();
    expect(imageFromResponse({ data: [{ b64_json: "" }] })).toBeNull();
  });
});

describe("describeImageCurl", () => {
  it("references the key env var rather than embedding the key", () => {
    const curl = describeImageCurl({
      baseUrl: "http://127.0.0.1:8080",
      body: { prompt: "x" },
      hasKey: true,
    });
    expect(curl).toContain("http://127.0.0.1:8080/v1/images/generations");
    expect(curl).toContain("$CANARY_IMAGE_API_KEY");
  });
  it("omits the auth header when there's no key", () => {
    expect(
      describeImageCurl({ baseUrl: "http://x", body: {}, hasKey: false })
    ).not.toContain("Authorization");
  });
});
