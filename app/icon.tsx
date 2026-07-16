import { ImageResponse } from "next/og";

// Favicon + manifest 512 source (Next also downsizes for smaller sizes).
export const size = {
  width: 512,
  height: 512,
};
export const contentType = "image/png";

// "B" monogram — light glyph on the zinc-800 brand background, rounded, centered.
// Glyph kept within the center ~80% so it stays maskable-safe.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#27272a",
          borderRadius: 96,
        }}
      >
        <div
          style={{
            fontSize: 320,
            fontWeight: 700,
            color: "#fafafa",
            lineHeight: 1,
            letterSpacing: "-0.05em",
            display: "flex",
          }}
        >
          B
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
