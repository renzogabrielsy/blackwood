import { ImageResponse } from "next/og";

// iOS home-screen icon (Apple touch icon).
export const size = {
  width: 180,
  height: 180,
};
export const contentType = "image/png";

// "B" monogram — light glyph on the zinc-800 brand background, rounded, centered.
export default function AppleIcon() {
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
          borderRadius: 34,
        }}
      >
        <div
          style={{
            fontSize: 112,
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
