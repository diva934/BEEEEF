import { zColor } from "@remotion/zod-types";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const beeefOutroSchema = z.object({
  beeSrc: z.string(),
  textSrc: z.string(),
  accentColor: zColor(),
  backgroundColor: zColor(),
  beeWidth: z.number(),
  textWidth: z.number(),
  shouldFadeOut: z.boolean(),
});

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

export const BeeefOutro: React.FC<z.infer<typeof beeefOutroSchema>> = ({
  accentColor,
  backgroundColor,
  beeSrc,
  beeWidth,
  shouldFadeOut,
  textSrc,
  textWidth,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const beeIntro = spring({
    fps,
    frame: frame - 2,
    config: {
      damping: 18,
      mass: 0.75,
      stiffness: 180,
    },
  });

  const textIntro = spring({
    fps,
    frame: frame - 8,
    config: {
      damping: 20,
      mass: 0.9,
      stiffness: 120,
    },
  });

  const outroOpacity = shouldFadeOut
    ? interpolate(frame, [durationInFrames - 18, durationInFrames], [1, 0], clamp)
    : 1;

  const beeOpacity = interpolate(frame, [0, 24], [0, 1], clamp) * outroOpacity;
  const textOpacity = interpolate(frame, [8, 34], [0, 1], clamp) * outroOpacity;

  const beeEntranceScale = interpolate(beeIntro, [0, 1], [0.82, 1], clamp);
  const textEntranceScale = interpolate(textIntro, [0, 1], [0.95, 1], clamp);

  const beeEntranceY = interpolate(beeIntro, [0, 1], [34, 0], clamp);
  const textEntranceY = interpolate(textIntro, [0, 1], [20, 0], clamp);

  const beeEntranceBlur = interpolate(frame, [0, 18], [10, 0], clamp);
  const textEntranceBlur = interpolate(frame, [8, 24], [8, 0], clamp);

  const hoverStrength = interpolate(frame, [36, 70], [0, 1], clamp);
  const hoverPhase = ((frame - 36) / fps) * Math.PI * 2;

  const beeFloatY = Math.sin(hoverPhase * 0.92) * 14 * hoverStrength;
  const beeFloatX = Math.cos(hoverPhase * 0.46) * 6 * hoverStrength;
  const beeRotate = Math.sin(hoverPhase * 0.84) * 1.4 * hoverStrength;
  const beeBreathScale = 1 + Math.sin(hoverPhase * 0.7) * 0.012 * hoverStrength;

  const beeGlowPulse = 0.78 + Math.sin((frame / fps) * Math.PI * 2 * 0.8) * 0.12;
  const textGlowPulse = 0.9 + Math.sin((frame / fps) * Math.PI * 2 * 0.45) * 0.06;

  const lightPassProgress = interpolate(frame, [156, 176, 196], [0, 1, 0], clamp);
  const lightPassX = interpolate(frame, [152, 190], [-400, 400], clamp);

  const beeAuraOpacity = interpolate(frame, [0, 26, 120, 188], [0, 0.58, 0.64, 0.42], clamp);
  const textAuraOpacity = interpolate(frame, [6, 36, 188], [0, 0.42, 0.3], clamp);

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 34%, rgba(255,122,53,0.14), rgba(0,0,0,0) 28%), radial-gradient(circle at 50% 58%, rgba(255,122,53,0.1), rgba(0,0,0,0) 34%)",
          opacity: outroOpacity,
        }}
      />

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0) 18%, rgba(255,255,255,0) 82%, rgba(255,255,255,0.025))",
          opacity: 0.55 * outroOpacity,
        }}
      />

      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle, rgba(0,0,0,0) 42%, rgba(0,0,0,0.36) 78%, rgba(0,0,0,0.75) 100%)",
          opacity: outroOpacity,
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          opacity: outroOpacity,
          transform: "translateY(-18px)",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexDirection: "column",
            gap: 36,
            position: "relative",
          }}
        >
          <div
            style={{
              background: `radial-gradient(circle, ${accentColor}66 0%, ${accentColor}18 42%, transparent 72%)`,
              borderRadius: "50%",
              filter: "blur(48px)",
              height: 290,
              left: "50%",
              opacity: beeAuraOpacity * beeGlowPulse * outroOpacity,
              position: "absolute",
              top: -12,
              transform: "translateX(-50%)",
              width: 290,
            }}
          />

          <div
            style={{
              background: `radial-gradient(circle, ${accentColor}40 0%, ${accentColor}12 45%, transparent 72%)`,
              borderRadius: "50%",
              filter: "blur(62px)",
              height: 300,
              left: "50%",
              opacity: textAuraOpacity * textGlowPulse * outroOpacity,
              position: "absolute",
              top: 250,
              transform: "translateX(-50%)",
              width: 760,
            }}
          />

          <Img
            src={staticFile(beeSrc)}
            style={{
              filter: `blur(${beeEntranceBlur}px) brightness(1.18) saturate(1.08) drop-shadow(0 0 16px ${accentColor}66) drop-shadow(0 0 34px ${accentColor}22)`,
              opacity: beeOpacity,
              transform: `translate3d(${beeFloatX}px, ${beeEntranceY + beeFloatY}px, 0) rotate(${beeRotate}deg) scale(${beeEntranceScale * beeBreathScale})`,
              transformOrigin: "center center",
              width: beeWidth,
            }}
          />

          <div
            style={{
              opacity: textOpacity,
              position: "relative",
              transform: `translateY(${textEntranceY}px) scale(${textEntranceScale})`,
            }}
          >
            <Img
              src={staticFile(textSrc)}
              style={{
                filter: `blur(${textEntranceBlur}px) brightness(1.16) saturate(1.06) drop-shadow(0 0 16px ${accentColor}40) drop-shadow(0 0 28px ${accentColor}16)`,
                width: textWidth,
              }}
            />

            <div
              style={{
                background: `linear-gradient(90deg, transparent, ${accentColor}cc, transparent)`,
                borderRadius: 999,
                bottom: 18,
                filter: "blur(6px)",
                height: 6,
                left: "50%",
                opacity: 0.62 * textGlowPulse * outroOpacity,
                position: "absolute",
                transform: "translateX(-50%)",
                width: Math.round(textWidth * 0.62),
              }}
            />

            <div
              style={{
                background:
                  "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.62), rgba(255,214,184,0.96), rgba(255,255,255,0))",
                filter: "blur(10px)",
                height: "132%",
                left: "50%",
                mixBlendMode: "screen",
                opacity: 0.46 * lightPassProgress * outroOpacity,
                position: "absolute",
                top: "-16%",
                transform: `translateX(${lightPassX}px) skewX(-18deg)`,
                width: Math.round(textWidth * 0.16),
              }}
            />
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
