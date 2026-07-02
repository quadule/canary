import { describe, expect, it } from "vitest";
import {
  attributionFor,
  buildCommonsSearchUrl,
  cleanArtist,
  imageKeywords,
  isPermissiveLicense,
  pickCommonsImage,
  sanitizeImageQuery,
} from "./wikimedia.js";

describe("sanitizeImageQuery", () => {
  it("collapses whitespace and caps length", () => {
    expect(sanitizeImageQuery("  noir   city  ")).toBe("noir city");
    expect(sanitizeImageQuery("a".repeat(200)).length).toBe(120);
  });
});

describe("imageKeywords", () => {
  it("splits hyphens, drops stopwords/short tokens, de-dupes, and caps at 6", () => {
    expect(
      imageKeywords(
        "A lone detective in a rain-soaked neon city at midnight. Cinematic noir."
      )
    ).toEqual(["lone", "detective", "rain", "soaked", "neon", "city"]);
  });
  it("returns an empty list when there's nothing evocative", () => {
    expect(imageKeywords("the a of in on")).toEqual([]);
  });
});

describe("buildCommonsSearchUrl", () => {
  it("searches the File namespace for raster images with license metadata", () => {
    // URLSearchParams encodes spaces as '+'; undo it to read the query.
    const decoded = decodeURIComponent(
      buildCommonsSearchUrl("noir city", 1280)
    ).replace(/\+/g, " ");
    expect(decoded).toContain("commons.wikimedia.org/w/api.php");
    expect(decoded).toContain("generator=search");
    expect(decoded).toContain("noir city filetype:bitmap");
    expect(decoded).toContain("gsrnamespace=6");
    expect(decoded).toContain("extmetadata");
  });
  it("falls back to a generic term for an empty direction", () => {
    const decoded = decodeURIComponent(
      buildCommonsSearchUrl("  ", 640)
    ).replace(/\+/g, " ");
    expect(decoded).toContain("cinematic landscape filetype:bitmap");
  });
});

describe("isPermissiveLicense", () => {
  it("accepts public domain, CC0, and the CC-BY family", () => {
    for (const k of ["pd", "cc0", "cc-by-2.0", "cc-by-sa-4.0", "cc-by-3.0"]) {
      expect(isPermissiveLicense(k)).toBe(true);
    }
  });
  it("rejects non-free, fair-use, and unknown licenses", () => {
    for (const k of ["fair use", "gfdl", "", undefined, 42]) {
      expect(isPermissiveLicense(k)).toBe(false);
    }
  });
});

describe("cleanArtist", () => {
  it("strips HTML to a short plain string", () => {
    expect(cleanArtist('<a href="/wiki/User:X">Jane Doe</a>')).toBe("Jane Doe");
    expect(cleanArtist(undefined)).toBeUndefined();
  });
});

describe("pickCommonsImage", () => {
  const page = (index: number, over: Record<string, unknown>) => ({
    index,
    title: over.title ?? `File:img${index}.jpg`,
    imageinfo: [
      {
        url: `https://upload/${index}.jpg`,
        thumburl: `https://upload/thumb/${index}.jpg`,
        mediatype: over.mediatype ?? "BITMAP",
        extmetadata: {
          License: { value: over.license },
          LicenseShortName: { value: over.short ?? "CC BY 3.0" },
          Artist: { value: over.artist ?? "<b>Ansel</b>" },
        },
      },
    ],
  });

  it("picks the first permissive raster, skipping non-free and non-bitmap hits", () => {
    const body = {
      query: {
        pages: {
          a: page(0, { license: "fair use" }), // rejected: non-free
          b: page(1, { license: "cc-by-3.0", mediatype: "DRAWING" }), // rejected: not bitmap
          c: page(2, { license: "cc-by-sa-4.0", title: "File:good.jpg" }), // ✓
        },
      },
    };
    const picked = pickCommonsImage(body);
    expect(picked?.title).toBe("File:good.jpg");
    expect(picked?.imageUrl).toBe("https://upload/thumb/2.jpg");
    expect(picked?.artist).toBe("Ansel");
  });
  it("returns null when nothing qualifies", () => {
    expect(pickCommonsImage({ query: { pages: {} } })).toBeNull();
    expect(pickCommonsImage({})).toBeNull();
  });
});

describe("attributionFor", () => {
  it("credits title, artist, license, and links the Commons page", () => {
    expect(
      attributionFor({
        title: "File:Wet Street.jpg",
        imageUrl: "https://upload/x.jpg",
        descriptionUrl: "",
        license: "CC BY-SA 4.0",
        artist: "Jane Doe",
      })
    ).toBe(
      'title image: "File:Wet Street.jpg" by Jane Doe (CC BY-SA 4.0) — https://commons.wikimedia.org/wiki/File%3AWet_Street.jpg'
    );
  });
});
