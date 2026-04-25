import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

const particles = [
  { left: 0.18, top: 0.24, size: 8, drift: 24, speed: 0.9, offset: 0.2 },
  { left: 0.27, top: 0.2, size: 6, drift: 18, speed: 1.1, offset: 1.1 },
  { left: 0.74, top: 0.22, size: 7, drift: 20, speed: 0.85, offset: 2.7 },
  { left: 0.82, top: 0.29, size: 9, drift: 26, speed: 1.2, offset: 0.8 },
  { left: 0.15, top: 0.68, size: 10, drift: 22, speed: 0.7, offset: 2.1 },
  { left: 0.28, top: 0.74, size: 7, drift: 24, speed: 0.95, offset: 3.4 },
  { left: 0.71, top: 0.76, size: 8, drift: 20, speed: 1.05, offset: 1.9 },
  { left: 0.84, top: 0.66, size: 11, drift: 18, speed: 0.75, offset: 4.1 },
  { left: 0.5, top: 0.14, size: 6, drift: 16, speed: 1.15, offset: 2.3 },
  { left: 0.5, top: 0.86, size: 7, drift: 16, speed: 0.8, offset: 5.2 },
];

export const BeeefLogoOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();

  const intro = spring({
    frame: frame - 2,
    fps,
    config: {
      damping: 18,
      stiffness: 120,
      mass: 0.95,
    },
  });

  const glow = spring({
    frame: frame - 10,
    fps,
    config: {
      damping: 22,
      stiffness: 80,
      mass: 1.1,
    },
  });

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 24, durationInFrames],
    [1, 0],
    clamp,
  );

  const backgroundZoom = interpolate(intro, [0, 1], [1.16, 1.06]);
  const cardScale = interpolate(intro, [0, 1], [0.86, 1]);
  const cardTranslateY = interpolate(intro, [0, 1], [90, 0]);
  const cardRotateX = interpolate(intro, [0, 1], [18, 0]);
  const cardRotateZ = interpolate(intro, [0, 1], [-2.8, 0]);
  const focusBlur = interpolate(frame, [0, 18], [32, 0], clamp);
  const sweepX = interpolate(frame, [24, 68], [-width * 0.55, width * 0.55], clamp);
  const sweepOpacity = interpolate(frame, [18, 30, 58, 74], [0, 0.95, 0.95, 0], clamp);
  const ringOneScale = interpolate(frame, [8, 54], [0.58, 1.24], clamp);
  const ringOneOpacity = interpolate(frame, [8, 22, 54], [0, 0.3, 0], clamp);
  const ringTwoScale = interpolate(frame, [18, 68], [0.72, 1.44], clamp);
  const ringTwoOpacity = interpolate(frame, [18, 34, 68], [0, 0.18, 0], clamp);
  const pulse = 0.88 + Math.sin((frame / fps) * Math.PI * 2 * 0.75) * 0.12;
  const ambientScale = 0.96 + Math.sin((frame / fps) * Math.PI * 2 * 0.35) * 0.04;
  const finalBloom = interpolate(frame, [76, 96], [0.78, 1.04], clamp);

  return (
    <AbsoluteFill style={{ backgroundColor: "#050403" }}>
      <AbsoluteFill style={{ opacity: fadeOut }}>
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(circle at 50% 40%, rgba(255,134,74,0.18), rgba(7,5,4,0.92) 36%, #050403 78%)",
          }}
        />

        <AbsoluteFill style={{ opacity: 0.34 + glow * 0.16 }}>
          <Img
            src={staticFile("beeef-logo.png")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: `blur(${58 - glow * 14}px) saturate(1.55) brightness(${0.52 + glow * 0.22})`,
              transform: `scale(${backgroundZoom})`,
            }}
          />
        </AbsoluteFill>

        <AbsoluteFill
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.08), transparent 16%, transparent 84%, rgba(0,0,0,0.32))",
            opacity: 0.45,
          }}
        />

        <AbsoluteFill
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
            backgroundSize: "100% 100%, 120px 120px",
            opacity: 0.07,
          }}
        />

        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 980,
            height: 980,
            borderRadius: "50%",
            border: "1px solid rgba(255,157,102,0.24)",
            transform: `translate(-50%, -50%) scale(${ringOneScale})`,
            opacity: ringOneOpacity * fadeOut,
            filter: "blur(0.4px)",
          }}
        />

        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 1180,
            height: 1180,
            borderRadius: "50%",
            border: "1px solid rgba(255,157,102,0.16)",
            transform: `translate(-50%, -50%) scale(${ringTwoScale})`,
            opacity: ringTwoOpacity * fadeOut,
            filter: "blur(0.8px)",
          }}
        />

        {particles.map((particle, index) => {
          const twinkle =
            0.4 +
            0.6 *
              Math.sin((frame / fps) * (1.5 + particle.speed) + particle.offset);
          const offsetY =
            Math.sin((frame / fps) * (0.7 + particle.speed) + particle.offset) *
            particle.drift;
          const offsetX =
            Math.cos((frame / fps) * (0.5 + particle.speed) + particle.offset) *
            particle.drift *
            0.45;

          return (
            <div
              key={index}
              style={{
                position: "absolute",
                left: `${particle.left * 100}%`,
                top: `${particle.top * 100}%`,
                width: particle.size,
                height: particle.size,
                borderRadius: "50%",
                transform: `translate(${offsetX}px, ${offsetY}px) scale(${0.7 + twinkle * 0.6})`,
                background:
                  "radial-gradient(circle, rgba(255,224,197,0.95) 0%, rgba(255,143,82,0.68) 42%, rgba(255,143,82,0) 76%)",
                opacity: (0.14 + twinkle * 0.24) * glow * fadeOut,
                filter: "blur(1px)",
                boxShadow: "0 0 18px rgba(255,109,53,0.45)",
              }}
            />
          );
        })}

        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 880,
            height: 200,
            transform: "translate(-50%, 280px)",
            background:
              "radial-gradient(circle, rgba(255,117,56,0.42) 0%, rgba(255,117,56,0.14) 34%, rgba(255,117,56,0) 72%)",
            filter: "blur(26px)",
            opacity: 0.72 * glow * fadeOut * pulse,
          }}
        />

        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 50% 58%, rgba(255,106,44,0.55), rgba(255,106,44,0.12) 19%, rgba(0,0,0,0) 46%)",
            transform: `scale(${ambientScale})`,
            opacity: 0.44 * fadeOut * pulse,
            filter: "blur(28px)",
          }}
        />

        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div
            style={{
              position: "relative",
              width: 980,
              height: 654,
              borderRadius: 56,
              overflow: "hidden",
              background: "rgba(12,8,6,0.58)",
              border: "1px solid rgba(255,180,140,0.18)",
              transform: `perspective(1800px) translateY(${cardTranslateY}px) scale(${cardScale}) rotateX(${cardRotateX}deg) rotateZ(${cardRotateZ}deg)`,
              boxShadow: `0 50px 140px rgba(0,0,0,0.58), 0 0 ${80 + glow * 80}px rgba(255,101,42,${0.18 + glow * 0.16})`,
            }}
          >
            <Img
              src={staticFile("beeef-logo.png")}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                filter: `blur(${focusBlur}px) saturate(${1.08 + glow * 0.35}) brightness(${0.9 + glow * 0.14}) contrast(1.06)`,
                transform: `scale(${1.02 + (1 - intro) * 0.04})`,
              }}
            />

            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02) 22%, rgba(0,0,0,0.22) 100%)",
              }}
            />

            <div
              style={{
                position: "absolute",
                inset: 0,
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -40px 80px rgba(0,0,0,0.24)",
              }}
            />

            <div
              style={{
                position: "absolute",
                top: "-20%",
                bottom: "-20%",
                width: "24%",
                transform: `translateX(${sweepX}px) skewX(-20deg)`,
                background:
                  "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.58), rgba(255,180,120,0.75), rgba(255,255,255,0))",
                opacity: sweepOpacity,
                filter: "blur(10px)",
                mixBlendMode: "screen",
              }}
            />

            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: 26,
                width: 420,
                height: 4,
                borderRadius: 999,
                transform: "translateX(-50%)",
                background:
                  "linear-gradient(90deg, rgba(255,106,44,0), rgba(255,184,138,0.92), rgba(255,106,44,0))",
                filter: "blur(4px)",
                opacity: 0.68 * finalBloom,
              }}
            />
          </div>

          <div
            style={{
              marginTop: 34,
              width: 360,
              height: 3,
              borderRadius: 999,
              background:
                "linear-gradient(90deg, rgba(255,107,53,0), rgba(255,186,144,0.95), rgba(255,107,53,0))",
              filter: "blur(3px)",
              opacity: 0.8 * glow * fadeOut,
              transform: `scaleX(${0.9 + finalBloom * 0.1})`,
            }}
          />
        </AbsoluteFill>

        <AbsoluteFill
          style={{
            background:
              "radial-gradient(circle, transparent 40%, rgba(0,0,0,0.16) 70%, rgba(0,0,0,0.54) 100%)",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
