import {zColor} from "@remotion/zod-types";
import {
	AbsoluteFill,
	Img,
	Sequence,
	interpolate,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";
import {z} from "zod";

export const beeefSaasPromoSchema = z.object({
	accentBlue: zColor(),
	accentOrange: zColor(),
	lightBackground: zColor(),
	darkBackground: zColor(),
	beeSrc: z.string(),
	textSrc: z.string(),
	brandLine: z.string(),
	tagline: z.string(),
	introLine: z.string(),
	conceptLine: z.string(),
	liveLine: z.string(),
	actionLine: z.string(),
	aiLine: z.string(),
	resultLine: z.string(),
	ctaLine: z.string(),
});

const clamp = {
	extrapolateLeft: "clamp",
	extrapolateRight: "clamp",
} as const;

const displayFont =
	"'Sora', 'Inter Tight', 'Segoe UI Variable Display', 'Segoe UI', sans-serif";
const bodyFont =
	"'Manrope', 'Inter', 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
const monoFont = "'JetBrains Mono', 'Consolas', monospace";

const sceneDurations = {
	intro: 180,
	concept: 240,
	live: 300,
	action: 360,
	ai: 360,
	result: 360,
	cta: 300,
} as const;

const sceneStarts = {
	intro: 0,
	concept: sceneDurations.intro,
	live: sceneDurations.intro + sceneDurations.concept,
	action: sceneDurations.intro + sceneDurations.concept + sceneDurations.live,
	ai:
		sceneDurations.intro +
		sceneDurations.concept +
		sceneDurations.live +
		sceneDurations.action,
	result:
		sceneDurations.intro +
		sceneDurations.concept +
		sceneDurations.live +
		sceneDurations.action +
		sceneDurations.ai,
	cta:
		sceneDurations.intro +
		sceneDurations.concept +
		sceneDurations.live +
		sceneDurations.action +
		sceneDurations.ai +
		sceneDurations.result,
} as const;

const premiumShadow =
	"0 52px 140px rgba(26, 49, 99, 0.14), 0 24px 54px rgba(26, 49, 99, 0.08)";
const deviceShadow =
	"0 60px 160px rgba(29, 51, 100, 0.14), 0 24px 60px rgba(26, 49, 99, 0.08), inset 0 1px 0 rgba(255,255,255,0.85)";
const cardGradient =
	"linear-gradient(180deg, rgba(255,255,255,0.98), rgba(244,248,255,0.92))";
const panelGradient =
	"linear-gradient(180deg, rgba(248,251,255,0.94), rgba(239,246,255,0.9))";

const sceneOpacity = (
	frame: number,
	duration: number,
	fadeIn = 20,
	fadeOut = 20,
) => {
	return interpolate(
		frame,
		[0, fadeIn, duration - fadeOut, duration],
		[0, 1, 1, 0],
		clamp,
	);
};

const entrance = (
	frame: number,
	fps: number,
	delay = 0,
	stiffness = 140,
	damping = 18,
) => {
	return spring({
		fps,
		frame: frame - delay,
		config: {
			damping,
			mass: 0.9,
			stiffness,
		},
	});
};

const floatOffset = (
	frame: number,
	divisor: number,
	amplitude: number,
	phase = 0,
) => {
	return Math.sin(frame / divisor + phase) * amplitude;
};

const AmbientOrb: React.FC<{
	blur: number;
	color: string;
	height: number;
	left?: number | string;
	opacity?: number;
	right?: number | string;
	top?: number | string;
	width: number;
}> = ({blur, color, height, left, opacity = 1, right, top, width}) => {
	return (
		<div
			style={{
				background: color,
				borderRadius: "50%",
				filter: `blur(${blur}px)`,
				height,
				left,
				opacity,
				position: "absolute",
				right,
				top,
				width,
			}}
		/>
	);
};

const GlassPanel: React.FC<{
	children?: React.ReactNode;
	style?: React.CSSProperties;
}> = ({children, style}) => {
	return (
		<div
			style={{
				backdropFilter: "blur(28px)",
				background: cardGradient,
				border: "1px solid rgba(255,255,255,0.84)",
				borderRadius: 42,
				boxShadow: premiumShadow,
				overflow: "hidden",
				position: "relative",
				...style,
			}}
		>
			<div
				style={{
					background:
						"linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.08))",
					inset: 1,
					pointerEvents: "none",
					position: "absolute",
				}}
			/>
			<div
				style={{
					background:
						"radial-gradient(circle at 18% 0%, rgba(255,255,255,0.85), transparent 30%), radial-gradient(circle at 88% 28%, rgba(36,92,255,0.08), transparent 26%)",
					inset: 0,
					pointerEvents: "none",
					position: "absolute",
				}}
			/>
			{children}
		</div>
	);
};

const StagePanel: React.FC<{
	children?: React.ReactNode;
	style?: React.CSSProperties;
}> = ({children, style}) => {
	return (
		<GlassPanel
			style={{
				borderRadius: 56,
				boxShadow: deviceShadow,
				...style,
			}}
		>
			<div
				style={{
					background:
						"linear-gradient(180deg, rgba(255,255,255,0.56), rgba(255,255,255,0) 20%, rgba(255,255,255,0) 84%, rgba(214,227,255,0.24))",
					inset: 0,
					position: "absolute",
				}}
			/>
			{children}
		</GlassPanel>
	);
};

const Eyebrow: React.FC<{
	accent?: string;
	children: string;
	dark?: boolean;
}> = ({accent = "#245cff", children, dark = false}) => {
	return (
		<div
			style={{
				alignItems: "center",
				background: dark ? `${accent}14` : `${accent}10`,
				border: `1px solid ${dark ? `${accent}2a` : `${accent}20`}`,
				borderRadius: 999,
				color: dark ? "#ffbf95" : "#17356c",
				display: "inline-flex",
				fontFamily: monoFont,
				fontSize: 17,
				gap: 10,
				letterSpacing: 1.8,
				padding: "11px 18px",
				textTransform: "uppercase",
			}}
		>
			<div
				style={{
					background: accent,
					borderRadius: "50%",
					height: 8,
					width: 8,
				}}
			/>
			{children}
		</div>
	);
};

const MetricPill: React.FC<{
	label: string;
	value?: string;
}> = ({label, value}) => {
	return (
		<div
			style={{
				alignItems: "center",
				background: "rgba(255,255,255,0.72)",
				border: "1px solid rgba(204,216,240,0.78)",
				borderRadius: 999,
				boxShadow: "0 18px 40px rgba(52,92,168,0.08)",
				color: "#4e607d",
				display: "flex",
				fontFamily: bodyFont,
				fontSize: 20,
				gap: 12,
				padding: "12px 18px",
			}}
		>
			<span>{label}</span>
			{value ? (
				<span
					style={{
						color: "#111d33",
						fontFamily: displayFont,
						fontSize: 20,
						fontWeight: 700,
						letterSpacing: -0.4,
					}}
				>
					{value}
				</span>
			) : null}
		</div>
	);
};

const SectionHeader: React.FC<{
	accent: string;
	body?: string;
	eyebrow: string;
	title: string;
}> = ({accent, body, eyebrow, title}) => {
	return (
		<div
			style={{
				alignItems: "center",
				display: "flex",
				flexDirection: "column",
				gap: 18,
				maxWidth: 920,
				textAlign: "center",
			}}
		>
			<Eyebrow accent={accent}>{eyebrow}</Eyebrow>
			<div
				style={{
					color: "#0a1528",
					fontFamily: displayFont,
					fontSize: 92,
					fontWeight: 700,
					letterSpacing: -4.8,
					lineHeight: 0.92,
				}}
			>
				{title}
			</div>
			{body ? (
				<div
					style={{
						color: "#687994",
						fontFamily: bodyFont,
						fontSize: 28,
						letterSpacing: -0.25,
						lineHeight: 1.34,
						maxWidth: 820,
					}}
				>
					{body}
				</div>
			) : null}
		</div>
	);
};

const SceneWrap: React.FC<{
	children: React.ReactNode;
	duration: number;
	frame: number;
	shift?: number;
}> = ({children, duration, frame, shift = 30}) => {
	const {fps} = useVideoConfig();
	const opacity = sceneOpacity(frame, duration);
	const reveal = entrance(frame, fps, 0, 150, 18);

	return (
		<AbsoluteFill
			style={{
				alignItems: "center",
				justifyContent: "center",
				opacity,
				padding: "126px 58px 110px",
				transform: `translateY(${interpolate(reveal, [0, 1], [shift, 0], clamp)}px) scale(${interpolate(reveal, [0, 1], [0.985, 1], clamp)})`,
			}}
		>
			{children}
		</AbsoluteFill>
	);
};

const IntroScene: React.FC<{
	accentBlue: string;
	brandLine: string;
	durationInFrames: number;
	introLine: string;
	tagline: string;
}> = ({accentBlue, brandLine, durationInFrames, introLine, tagline}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const titleReveal = entrance(frame, fps, 4, 130, 19);
	const stageReveal = entrance(frame, fps, 12, 140, 18);
	const lineProgress = interpolate(frame, [14, 124], [0.05, 0.91], clamp);
	const knobPulse = 0.94 + Math.sin(frame / 8) * 0.03;
	const trackWidth = 714;
	const knobWidth = 206;
	const knobLeft = 124 + lineProgress * (trackWidth - knobWidth);
	const stageFloat = floatOffset(frame, 38, 7, 0.3);

	return (
		<SceneWrap duration={durationInFrames} frame={frame}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 34,
					width: 962,
				}}
			>
				<div
					style={{
						transform: `translateY(${interpolate(titleReveal, [0, 1], [26, 0], clamp)}px)`,
					}}
				>
					<SectionHeader
						accent={accentBlue}
						body={tagline}
						eyebrow={brandLine}
						title={introLine}
					/>
				</div>

				<StagePanel
					style={{
						height: 980,
						transform: `perspective(1600px) rotateX(4deg) rotateY(-2deg) translateY(${stageFloat}px) scale(${interpolate(stageReveal, [0, 1], [0.96, 1], clamp)})`,
						width: 962,
					}}
				>
					<AmbientOrb
						blur={54}
						color="rgba(36,92,255,0.18)"
						height={280}
						left={120}
						opacity={0.8}
						top={620}
						width={280}
					/>
					<AmbientOrb
						blur={58}
						color="rgba(36,92,255,0.12)"
						height={240}
						opacity={0.9}
						right={88}
						top={142}
						width={240}
					/>

					<div
						style={{
							alignItems: "center",
							color: "#71819d",
							display: "flex",
							fontFamily: monoFont,
							fontSize: 17,
							justifyContent: "space-between",
							left: 52,
							letterSpacing: 1.4,
							position: "absolute",
							right: 52,
							textTransform: "uppercase",
							top: 46,
						}}
					>
						<span>interactive flow</span>
						<span>premium product signal</span>
					</div>

					<GlassPanel
						style={{
							background: panelGradient,
							borderRadius: 34,
							boxShadow: "0 24px 60px rgba(36,92,255,0.08)",
							left: 58,
							padding: 24,
							position: "absolute",
							top: 108,
							width: 252,
						}}
					>
						<div
							style={{
								color: "#75849d",
								fontFamily: monoFont,
								fontSize: 14,
								letterSpacing: 1.2,
								marginBottom: 18,
								textTransform: "uppercase",
							}}
						>
							market state
						</div>
						<div
							style={{
								color: "#0e1932",
								fontFamily: displayFont,
								fontSize: 44,
								fontWeight: 700,
								letterSpacing: -1.5,
								marginBottom: 14,
							}}
						>
							82%
						</div>
						<div
							style={{
								background: "rgba(200,212,238,0.74)",
								borderRadius: 999,
								height: 8,
								marginBottom: 18,
								overflow: "hidden",
							}}
						>
							<div
								style={{
									background: `linear-gradient(90deg, ${accentBlue}, #77a8ff)`,
									borderRadius: 999,
									boxShadow: `0 0 30px ${accentBlue}44`,
									height: "100%",
									width: "82%",
								}}
							/>
						</div>
						<div
							style={{
								color: "#677891",
								fontFamily: bodyFont,
								fontSize: 20,
								lineHeight: 1.35,
							}}
						>
							Instant reading of a live debate market.
						</div>
					</GlassPanel>

					<div
						style={{
							background:
								"linear-gradient(180deg, rgba(46,108,255,0.42), rgba(46,108,255,0.12))",
							borderRadius: "86px 86px 46px 46px",
							bottom: 156,
							boxShadow: "0 34px 90px rgba(36,92,255,0.18)",
							height: 326,
							left: 112,
							position: "absolute",
							width: 252,
						}}
					/>
					<div
						style={{
							background:
								"linear-gradient(180deg, rgba(92,146,255,0.52), rgba(92,146,255,0.18))",
							borderRadius: "86px 86px 46px 46px",
							bottom: 184,
							boxShadow: "0 30px 80px rgba(36,92,255,0.12)",
							height: 404,
							left: 236,
							opacity: 0.84,
							position: "absolute",
							width: 342,
						}}
					/>

					<GlassPanel
						style={{
							background:
								"linear-gradient(180deg, rgba(248,251,255,0.9), rgba(239,245,255,0.88))",
							borderRadius: 30,
							boxShadow: "0 20px 48px rgba(36,92,255,0.08)",
							padding: 22,
							position: "absolute",
							right: 74,
							top: 182,
							width: 220,
						}}
					>
						<div
							style={{
								color: "#75839d",
								fontFamily: monoFont,
								fontSize: 14,
								letterSpacing: 1.2,
								marginBottom: 16,
								textTransform: "uppercase",
							}}
						>
							live stack
						</div>
						{[
							["Observe", "audience"],
							["Predict", "yes / no"],
							["Resolve", "ai"],
						].map(([label, value], index) => {
							return (
								<div
									key={label}
									style={{
										alignItems: "center",
										background: "rgba(255,255,255,0.74)",
										border: "1px solid rgba(208,218,239,0.74)",
										borderRadius: 20,
										display: "flex",
										justifyContent: "space-between",
										marginBottom: index === 2 ? 0 : 10,
										padding: "14px 16px",
									}}
								>
									<div
										style={{
											color: "#223453",
											fontFamily: displayFont,
											fontSize: 20,
											fontWeight: 600,
										}}
									>
										{label}
									</div>
									<div
										style={{
											color: "#6f809b",
											fontFamily: bodyFont,
											fontSize: 18,
										}}
									>
										{value}
									</div>
								</div>
							);
						})}
					</GlassPanel>

					<div
						style={{
							left: 124,
							position: "absolute",
							right: 124,
							top: 470,
						}}
					>
						<div
							style={{
								background: "rgba(188,203,232,0.58)",
								borderRadius: 999,
								height: 8,
								overflow: "hidden",
								position: "relative",
								width: trackWidth,
							}}
						>
							<div
								style={{
									background: `linear-gradient(90deg, ${accentBlue}, #77a8ff)`,
									borderRadius: 999,
									boxShadow: `0 0 34px ${accentBlue}58`,
									height: "100%",
									width: lineProgress * trackWidth,
								}}
							/>
						</div>

						{Array.from({length: 10}).map((_, index) => {
							const ratio = index / 9;
							const visible = Math.max(
								0,
								Math.min(1, (lineProgress - ratio) * 7),
							);

							return (
								<div
									key={ratio}
									style={{
										background: accentBlue,
										borderRadius: "50%",
										boxShadow: `0 0 20px ${accentBlue}58`,
										height: 14,
										left: ratio * (trackWidth - 14),
										opacity: visible * 0.92,
										position: "absolute",
										top: -3,
										transform: `scale(${interpolate(visible, [0, 1], [0.3, 1], clamp)})`,
										width: 14,
									}}
								/>
							);
						})}

						<div
							style={{
								alignItems: "center",
								backdropFilter: "blur(18px)",
								background:
									"linear-gradient(180deg, rgba(255,255,255,0.9), rgba(242,247,255,0.76))",
								border: "1px solid rgba(255,255,255,0.95)",
								borderRadius: 999,
								boxShadow: `0 34px 90px rgba(45,85,168,0.18), 0 0 38px ${accentBlue}28`,
								display: "flex",
								height: 112,
								justifyContent: "center",
								left: knobLeft,
								position: "absolute",
								top: -52,
								transform: `scale(${knobPulse})`,
								width: knobWidth,
							}}
						>
							<div
								style={{
									background: `linear-gradient(90deg, ${accentBlue}, rgba(36,92,255,0.04))`,
									borderRadius: 999,
									filter: "blur(8px)",
									height: 24,
									opacity: 0.98,
									width: 126,
								}}
							/>
						</div>
					</div>

					<div
						style={{
							bottom: 48,
							display: "flex",
							gap: 14,
							left: 48,
							position: "absolute",
						}}
					>
						<MetricPill label="Observe" value="Live" />
						<MetricPill label="Predict" value="YES / NO" />
						<MetricPill label="Resolve" value="AI" />
					</div>
				</StagePanel>
			</div>
		</SceneWrap>
	);
};

const ProfileTile: React.FC<{
	accentBlue: string;
	buttonLabel: string;
	caption: string;
	frame: number;
	handle: string;
	side: "left" | "right";
	title: string;
}> = ({accentBlue, buttonLabel, caption, frame, handle, side, title}) => {
	const {fps} = useVideoConfig();
	const reveal = entrance(frame, fps, side === "left" ? 10 : 18, 138, 18);
	const xShift = interpolate(
		reveal,
		[0, 1],
		[side === "left" ? -70 : 70, 0],
		clamp,
	);
	const yFloat = floatOffset(frame, 28, 6, side === "left" ? 0.2 : 0.9);

	return (
		<StagePanel
			style={{
				height: 640,
				padding: 24,
				transform: `translateX(${xShift}px) translateY(${yFloat}px)`,
				width: 404,
			}}
		>
			<div
				style={{
					background:
						side === "left"
							? "linear-gradient(180deg, rgba(99,153,255,0.9), rgba(190,220,255,0.7))"
							: "linear-gradient(180deg, rgba(162,210,255,0.7), rgba(255,255,255,0.9))",
					borderRadius: 28,
					height: 154,
					overflow: "hidden",
					position: "relative",
				}}
			>
				<AmbientOrb
					blur={22}
					color={side === "left" ? "rgba(36,92,255,0.36)" : "rgba(36,92,255,0.16)"}
					height={140}
					left={42}
					opacity={1}
					top={40}
					width={140}
				/>
				<div
					style={{
						background:
							side === "left"
								? "linear-gradient(180deg, rgba(37,77,191,0.22), rgba(37,77,191,0.06))"
								: "linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0.1))",
						borderRadius: 28,
						inset: 0,
						position: "absolute",
					}}
				/>
			</div>

			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					marginTop: -52,
				}}
			>
				<div
					style={{
						alignItems: "center",
						background:
							"linear-gradient(180deg, rgba(255,255,255,0.94), rgba(232,241,255,0.88))",
						border: "1px solid rgba(255,255,255,0.92)",
						borderRadius: "50%",
						boxShadow: "0 28px 60px rgba(36,92,255,0.16)",
						display: "flex",
						height: 112,
						justifyContent: "center",
						width: 112,
					}}
				>
					<div
						style={{
							background: `radial-gradient(circle at 50% 32%, rgba(255,255,255,0.9), rgba(36,92,255,0.14) 65%, rgba(36,92,255,0.42) 100%)`,
							borderRadius: "50%",
							height: 74,
							width: 74,
						}}
					/>
				</div>
				<div
					style={{
						alignItems: "center",
						display: "flex",
						gap: 10,
						marginBottom: 10,
						marginTop: 16,
					}}
				>
					<div
						style={{
							color: "#081225",
							fontFamily: displayFont,
							fontSize: 44,
							fontWeight: 700,
							letterSpacing: -1.6,
						}}
					>
						{title}
					</div>
					<div
						style={{
							background: `${accentBlue}18`,
							borderRadius: "50%",
							color: accentBlue,
							fontFamily: bodyFont,
							fontSize: 16,
							fontWeight: 700,
							height: 28,
							lineHeight: "28px",
							textAlign: "center",
							width: 28,
						}}
					>
						v
					</div>
				</div>
				<div
					style={{
						color: "#74839c",
						fontFamily: bodyFont,
						fontSize: 24,
						marginBottom: 16,
					}}
				>
					{handle}
				</div>
				<div
					style={{
						alignItems: "center",
						display: "flex",
						gap: 12,
						marginBottom: 20,
					}}
				>
					{[
						["24 following"],
						["189 followers"],
					].map(([stat]) => {
						return (
							<div
								key={stat}
								style={{
									color: "#6d7d97",
									fontFamily: bodyFont,
									fontSize: 19,
								}}
							>
								{stat}
							</div>
						);
					})}
				</div>
				<div
					style={{
						alignItems: "center",
						background: `linear-gradient(180deg, ${accentBlue}, #3f7dff)`,
						borderRadius: 999,
						boxShadow: `0 24px 50px ${accentBlue}28`,
						color: "#ffffff",
						display: "flex",
						fontFamily: displayFont,
						fontSize: 24,
						fontWeight: 600,
						height: 62,
						justifyContent: "center",
						marginBottom: 22,
						padding: "0 28px",
					}}
				>
					{buttonLabel}
				</div>
			</div>

			<div
				style={{
					color: "#131f38",
					fontFamily: bodyFont,
					fontSize: 24,
					lineHeight: 1.32,
					marginBottom: 18,
					textAlign: "center",
				}}
			>
				{caption}
			</div>

			<div
				style={{
					display: "grid",
					gap: 10,
					gridTemplateColumns: "1fr 1fr 1fr",
				}}
			>
				{["Clarity", "Evidence", "Impact"].map((label, index) => {
					return (
						<div
							key={label}
							style={{
								background:
									index === 0
										? "linear-gradient(180deg, rgba(212,231,255,0.92), rgba(239,246,255,0.84))"
										: "linear-gradient(180deg, rgba(248,251,255,0.94), rgba(243,248,255,0.88))",
								border: "1px solid rgba(208,218,239,0.76)",
								borderRadius: 24,
								height: 126,
								padding: 16,
							}}
						>
							<div
								style={{
									color: "#7b8aa2",
									fontFamily: monoFont,
									fontSize: 12,
									letterSpacing: 1.1,
									marginBottom: 12,
									textTransform: "uppercase",
								}}
							>
								{label}
							</div>
							<div
								style={{
									background:
										index === 0
											? "linear-gradient(180deg, rgba(36,92,255,0.42), rgba(36,92,255,0.08))"
											: "linear-gradient(180deg, rgba(36,92,255,0.16), rgba(36,92,255,0.04))",
								borderRadius: 18,
								height: 64,
							}}
						/>
					</div>
				);
				})}
			</div>
		</StagePanel>
	);
};

const ConceptScene: React.FC<{
	accentBlue: string;
	conceptLine: string;
	durationInFrames: number;
}> = ({accentBlue, conceptLine, durationInFrames}) => {
	const frame = useCurrentFrame();

	return (
		<SceneWrap duration={durationInFrames} frame={frame}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 34,
					width: 960,
				}}
			>
				<SectionHeader
					accent={accentBlue}
					body="Deux cartes produit premium, un setup ultra lisible et une tension de debat immediate."
					eyebrow="debate setup"
					title={conceptLine}
				/>

				<div
					style={{
						alignItems: "center",
						display: "flex",
						gap: 28,
						height: 690,
						justifyContent: "center",
						position: "relative",
						width: 960,
					}}
				>
					<AmbientOrb
						blur={40}
						color="rgba(36,92,255,0.12)"
						height={240}
						left={256}
						opacity={1}
						top={192}
						width={420}
					/>
					<ProfileTile
						accentBlue={accentBlue}
						buttonLabel="YES"
						caption="Vision claire, structure forte, proposition directe."
						frame={frame}
						handle="@pro yes"
						side="left"
						title="YES"
					/>
					<div
						style={{
							alignItems: "center",
							background:
								"linear-gradient(180deg, rgba(255,255,255,0.84), rgba(241,247,255,0.72))",
							border: "1px solid rgba(209,219,240,0.72)",
							borderRadius: "50%",
							boxShadow: "0 26px 70px rgba(36,92,255,0.12)",
							color: "#17356c",
							display: "flex",
							flexDirection: "column",
							fontFamily: monoFont,
							fontSize: 14,
							gap: 4,
							height: 112,
							justifyContent: "center",
							letterSpacing: 1.4,
							position: "absolute",
							textTransform: "uppercase",
							width: 112,
							zIndex: 2,
						}}
					>
						<span>live</span>
						<span>1v1</span>
					</div>
					<ProfileTile
						accentBlue={accentBlue}
						buttonLabel="NO"
						caption="Contre-argument net, angle critique, repartie credible."
						frame={frame}
						handle="@pro no"
						side="right"
						title="NO"
					/>
				</div>
			</div>
		</SceneWrap>
	);
};

const SpeakerPanel: React.FC<{
	accentBlue: string;
	active: boolean;
	frame: number;
	label: string;
	tint: string;
}> = ({accentBlue, active, frame, label, tint}) => {
	const wave = 0.58 + Math.sin(frame / 8) * 0.24;

	return (
		<GlassPanel
			style={{
				background: tint,
				borderRadius: 32,
				height: 316,
				padding: 24,
			}}
		>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					justifyContent: "space-between",
					marginBottom: 16,
				}}
			>
				<div
					style={{
						color: "#13203a",
						fontFamily: displayFont,
						fontSize: 34,
						fontWeight: 700,
						letterSpacing: -1.2,
					}}
				>
					{label}
				</div>
				<div
					style={{
						background: active ? `${accentBlue}14` : "rgba(16,24,38,0.08)",
						border: `1px solid ${active ? `${accentBlue}20` : "rgba(16,24,38,0.12)"}`,
						borderRadius: 999,
						color: active ? accentBlue : "#52637f",
						fontFamily: monoFont,
						fontSize: 13,
						letterSpacing: 1.2,
						padding: "9px 12px",
						textTransform: "uppercase",
					}}
				>
					{active ? "speaking" : "listening"}
				</div>
			</div>

			<div
				style={{
					background: "rgba(255,255,255,0.56)",
					border: "1px solid rgba(209,219,240,0.76)",
					borderRadius: 26,
					height: 176,
					marginBottom: 16,
					overflow: "hidden",
					position: "relative",
				}}
			>
				<AmbientOrb
					blur={20}
					color={active ? "rgba(36,92,255,0.24)" : "rgba(36,92,255,0.1)"}
					height={124}
					left={32}
					opacity={1}
					top={54}
					width={124}
				/>
				<div
					style={{
						bottom: 22,
						display: "flex",
						gap: 8,
						left: 20,
						position: "absolute",
						right: 20,
					}}
				>
					{Array.from({length: 6}).map((_, index) => {
						const localWave =
							0.4 + Math.sin(frame / 5 + index * 0.8 + (active ? 0 : 1.5)) * 0.24;

						return (
							<div
								key={index}
								style={{
									alignSelf: "flex-end",
									background: active
										? `linear-gradient(180deg, ${accentBlue}, rgba(36,92,255,0.18))`
										: "linear-gradient(180deg, rgba(73,90,120,0.64), rgba(73,90,120,0.16))",
									borderRadius: 999,
									height: 36 + localWave * 88,
									width: 14,
								}}
							/>
						);
					})}
				</div>
			</div>

			<div
				style={{
					alignItems: "center",
					display: "flex",
					justifyContent: "space-between",
				}}
			>
				<div
					style={{
						color: "#6b7c95",
						fontFamily: bodyFont,
						fontSize: 20,
					}}
				>
					Argument density
				</div>
				<div
					style={{
						color: "#0a1528",
						fontFamily: displayFont,
						fontSize: 26,
						fontWeight: 700,
						letterSpacing: -0.6,
					}}
				>
					{Math.round(wave * 100)}%
				</div>
			</div>
		</GlassPanel>
	);
};

const AudiencePulseCard: React.FC<{
	accentBlue: string;
	frame: number;
}> = ({accentBlue, frame}) => {
	const dots = Array.from({length: 12}).map((_, index) => {
		return {
			index,
			x: 42 + index * 24,
			y:
				index % 2 === 0
					? 96 + Math.sin(index * 0.8) * 18
					: 112 + Math.cos(index * 0.75) * 24,
		};
	});

	return (
		<GlassPanel
			style={{
				background: panelGradient,
				borderRadius: 30,
				boxShadow: "none",
				height: 238,
				padding: 22,
				width: 268,
			}}
		>
			<div
				style={{
					color: "#74839c",
					fontFamily: monoFont,
					fontSize: 14,
					letterSpacing: 1.1,
					marginBottom: 18,
					textTransform: "uppercase",
				}}
			>
				audience pulse
			</div>
			<div
				style={{
					background: "rgba(194,206,232,0.72)",
					borderRadius: 999,
					height: 4,
					left: 22,
					position: "absolute",
					right: 22,
					top: 122,
				}}
			/>
			{dots.map((dot) => {
				const reveal = interpolate(
					frame,
					[30 + dot.index * 6, 92 + dot.index * 6],
					[0, 1],
					clamp,
				);

				return (
					<div
						key={dot.index}
						style={{
							background: dot.index < 8 ? accentBlue : "rgba(97,112,143,0.54)",
							borderRadius: "50%",
							boxShadow:
								dot.index < 8
									? `0 0 18px ${accentBlue}66`
									: "0 0 14px rgba(97,112,143,0.12)",
							height: 14,
							left: dot.x,
							opacity: reveal,
							position: "absolute",
							top: dot.y,
							transform: `scale(${interpolate(reveal, [0, 1], [0.3, 1], clamp)})`,
							width: 14,
						}}
					/>
				);
			})}
		</GlassPanel>
	);
};

const LiveScene: React.FC<{
	accentBlue: string;
	durationInFrames: number;
	liveLine: string;
}> = ({accentBlue, durationInFrames, liveLine}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const reveal = entrance(frame, fps, 6, 140, 18);
	const stageShift = floatOffset(frame, 42, 5, 0.2);
	const bias = Math.round(interpolate(frame, [30, 220], [54, 67], clamp));

	return (
		<SceneWrap duration={durationInFrames} frame={frame}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 34,
					width: 982,
				}}
			>
				<SectionHeader
					accent={accentBlue}
					eyebrow="live debate"
					title={liveLine}
				/>

				<StagePanel
					style={{
						padding: 28,
						transform: `translateY(${stageShift}px) scale(${interpolate(reveal, [0, 1], [0.97, 1], clamp)})`,
						width: 982,
					}}
				>
					<div
						style={{
							alignItems: "center",
							display: "flex",
							justifyContent: "space-between",
							marginBottom: 22,
						}}
					>
						<Eyebrow accent={accentBlue}>public view</Eyebrow>
						<div
							style={{
								color: "#74839d",
								fontFamily: monoFont,
								fontSize: 16,
								letterSpacing: 1.1,
								textTransform: "uppercase",
							}}
						>
							3.4k watching
						</div>
					</div>

					<div
						style={{
							display: "grid",
							gap: 16,
							gridTemplateColumns: "1fr 1fr",
							marginBottom: 18,
						}}
					>
						<SpeakerPanel
							accentBlue={accentBlue}
							active
							frame={frame}
							label="YES"
							tint="linear-gradient(180deg, rgba(220,235,255,0.96), rgba(247,250,255,0.9))"
						/>
						<SpeakerPanel
							accentBlue={accentBlue}
							active={false}
							frame={frame}
							label="NO"
							tint="linear-gradient(180deg, rgba(244,247,252,0.98), rgba(249,251,255,0.9))"
						/>
					</div>

					<GlassPanel
						style={{
							background: panelGradient,
							borderRadius: 30,
							boxShadow: "none",
							marginBottom: 18,
							padding: 24,
						}}
					>
						<div
							style={{
								alignItems: "center",
								display: "flex",
								justifyContent: "space-between",
								marginBottom: 14,
							}}
						>
							<div
								style={{
									color: "#75839d",
									fontFamily: monoFont,
									fontSize: 14,
									letterSpacing: 1.1,
									textTransform: "uppercase",
								}}
							>
								public leaning
							</div>
							<div
								style={{
									color: "#0c172d",
									fontFamily: displayFont,
									fontSize: 32,
									fontWeight: 700,
									letterSpacing: -0.8,
								}}
							>
								{bias}% / {100 - bias}%
							</div>
						</div>
						<div
							style={{
								background: "rgba(198,210,236,0.74)",
								borderRadius: 999,
								height: 10,
								overflow: "hidden",
								position: "relative",
							}}
						>
							<div
								style={{
									background: `linear-gradient(90deg, ${accentBlue}, #7aabff)`,
									borderRadius: 999,
									boxShadow: `0 0 30px ${accentBlue}52`,
									height: "100%",
									width: `${bias}%`,
								}}
							/>
							{Array.from({length: 9}).map((_, index) => {
								const revealDot = interpolate(
									frame,
									[36 + index * 9, 78 + index * 9],
									[0, 1],
									clamp,
								);
								return (
									<div
										key={index}
										style={{
											background: accentBlue,
											borderRadius: "50%",
											boxShadow: `0 0 16px ${accentBlue}58`,
											height: 12,
											left: 40 + index * 80,
											opacity: revealDot,
											position: "absolute",
											top: -1,
											transform: `scale(${interpolate(revealDot, [0, 1], [0.2, 1], clamp)})`,
											width: 12,
										}}
									/>
								);
							})}
						</div>
					</GlassPanel>

					<div
						style={{
							display: "grid",
							gap: 16,
							gridTemplateColumns: "1.45fr 0.55fr",
						}}
					>
						<GlassPanel
							style={{
								background: panelGradient,
								borderRadius: 30,
								boxShadow: "none",
								padding: 22,
							}}
						>
							<div
								style={{
									color: "#74839d",
									fontFamily: monoFont,
									fontSize: 14,
									letterSpacing: 1.1,
									marginBottom: 16,
									textTransform: "uppercase",
								}}
							>
								live notes
							</div>
							{[
								"YES gagne du terrain sur la clarte.",
								"NO repond mais l'impact baisse.",
								"Le public voit le momentum en direct.",
							].map((message, index) => {
								return (
									<div
										key={message}
										style={{
											background: "rgba(255,255,255,0.72)",
											border: "1px solid rgba(208,218,239,0.76)",
											borderRadius: 22,
											color: "#344764",
											fontFamily: bodyFont,
											fontSize: 22,
											lineHeight: 1.34,
											marginBottom: index === 2 ? 0 : 10,
											padding: "16px 18px",
										}}
									>
										{message}
									</div>
								);
							})}
						</GlassPanel>

						<AudiencePulseCard accentBlue={accentBlue} frame={frame} />
					</div>
				</StagePanel>
			</div>
		</SceneWrap>
	);
};

const ActionScene: React.FC<{
	accentBlue: string;
	accentOrange: string;
	actionLine: string;
	durationInFrames: number;
}> = ({accentBlue, accentOrange, actionLine, durationInFrames}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const reveal = entrance(frame, fps, 10, 140, 18);
	const selectorProgress = interpolate(frame, [34, 132], [0.5, 0.12], clamp);
	const knobLeft = 30 + selectorProgress * 520;
	const ripple = interpolate(frame, [130, 236], [0, 1], clamp);
	const buttonLift = interpolate(
		Math.sin(frame / 16) * 0.5 + 0.5,
		[0, 1],
		[0, -8],
		clamp,
	);

	return (
		<SceneWrap duration={durationInFrames} frame={frame}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 36,
					width: 942,
				}}
			>
				<SectionHeader
					accent={accentBlue}
					eyebrow="prediction layer"
					title={actionLine}
				/>

				<StagePanel
					style={{
						padding: 32,
						transform: `translateY(${floatOffset(frame, 38, 5, 0.4)}px) scale(${interpolate(reveal, [0, 1], [0.97, 1], clamp)})`,
						width: 942,
					}}
				>
					<div
						style={{
							color: "#75839d",
							fontFamily: monoFont,
							fontSize: 14,
							letterSpacing: 1.2,
							marginBottom: 24,
							textTransform: "uppercase",
						}}
					>
						choose your side
					</div>

					<div
						style={{
							display: "grid",
							gap: 16,
							gridTemplateColumns: "1.2fr 0.8fr",
							marginBottom: 20,
						}}
					>
						<GlassPanel
							style={{
								background: panelGradient,
								borderRadius: 34,
								boxShadow: "none",
								padding: 20,
							}}
						>
							<div
								style={{
									background:
										"linear-gradient(180deg, rgba(255,255,255,0.9), rgba(242,247,255,0.92))",
									border: "1px solid rgba(210,220,240,0.78)",
									borderRadius: 999,
									boxShadow: "inset 0 1px 0 rgba(255,255,255,0.88)",
									height: 150,
									marginBottom: 22,
									position: "relative",
								}}
							>
								<div
									style={{
										background: `linear-gradient(180deg, ${accentBlue}, #6b99ff)`,
										borderRadius: 999,
										boxShadow: `0 28px 70px ${accentBlue}30`,
										height: 112,
										left: knobLeft,
										position: "absolute",
										top: 18,
										width: 352,
									}}
								/>
								<div
									style={{
										alignItems: "center",
										display: "grid",
										gridTemplateColumns: "1fr 1fr",
										height: "100%",
										position: "relative",
										zIndex: 2,
									}}
								>
									{[
										{active: selectorProgress < 0.3, label: "YES"},
										{active: selectorProgress >= 0.3, label: "NO"},
									].map(({active, label}) => {
										return (
											<div
												key={label}
												style={{
													color: active ? "#ffffff" : "#17253c",
													fontFamily: displayFont,
													fontSize: 42,
													fontWeight: 700,
													letterSpacing: -1.6,
													textAlign: "center",
												}}
											>
												{label}
											</div>
										);
									})}
								</div>
							</div>

							<div
								style={{
									display: "flex",
									gap: 12,
									marginBottom: 22,
								}}
							>
								{["50 pts", "100 pts", "250 pts"].map((amount, index) => {
									const active = index === 1;

									return (
										<div
											key={amount}
											style={{
												background: active
													? `${accentBlue}12`
													: "rgba(255,255,255,0.74)",
												border: `1px solid ${active ? `${accentBlue}28` : "rgba(206,216,238,0.74)"}`,
												borderRadius: 22,
												color: active ? "#2b64f0" : "#657795",
												fontFamily: displayFont,
												fontSize: 28,
												fontWeight: 700,
												letterSpacing: -0.8,
												padding: "16px 22px",
											}}
										>
											{amount}
										</div>
									);
								})}
							</div>

							<div
								style={{
									alignItems: "center",
									display: "flex",
									justifyContent: "space-between",
								}}
							>
								<div>
									<div
										style={{
											color: "#0d1730",
											fontFamily: displayFont,
											fontSize: 44,
											fontWeight: 700,
											letterSpacing: -1.7,
											marginBottom: 8,
										}}
									>
										Projection: YES
									</div>
									<div
										style={{
											color: "#6b7b95",
											fontFamily: bodyFont,
											fontSize: 24,
											lineHeight: 1.34,
											maxWidth: 420,
										}}
									>
										Une interaction plus tactile et plus premium, avec un vrai
										sentiment de produit.
									</div>
								</div>

								<div style={{position: "relative"}}>
									<div
										style={{
											background: `${accentOrange}14`,
											borderRadius: "50%",
											height: 176,
											left: "50%",
											opacity: 0.48 * (1 - ripple),
											position: "absolute",
											top: "50%",
											transform: `translate(-50%, -50%) scale(${interpolate(ripple, [0, 1], [0.45, 1.35], clamp)})`,
											width: 176,
										}}
									/>
									<div
										style={{
											alignItems: "center",
											background: `linear-gradient(180deg, ${accentBlue}, #2b71ff)`,
											borderRadius: 999,
											boxShadow: `0 30px 80px ${accentBlue}30`,
											color: "#ffffff",
											display: "flex",
											fontFamily: displayFont,
											fontSize: 28,
											fontWeight: 700,
											height: 86,
											justifyContent: "center",
											padding: "0 34px",
											position: "relative",
											transform: `translateY(${buttonLift}px)`,
										}}
									>
										Confirmer le choix
									</div>
								</div>
							</div>
						</GlassPanel>

						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: 16,
							}}
						>
							<GlassPanel
								style={{
									background: panelGradient,
									borderRadius: 30,
									boxShadow: "none",
									padding: 22,
								}}
							>
								<div
									style={{
										color: "#75839d",
										fontFamily: monoFont,
										fontSize: 14,
										letterSpacing: 1.1,
										marginBottom: 16,
										textTransform: "uppercase",
									}}
								>
									potential upside
								</div>
								<div
									style={{
										color: "#0d1730",
										fontFamily: displayFont,
										fontSize: 56,
										fontWeight: 700,
										letterSpacing: -1.8,
										marginBottom: 10,
									}}
								>
									+1 240
								</div>
								<div
									style={{
										color: "#6b7b95",
										fontFamily: bodyFont,
										fontSize: 23,
										lineHeight: 1.34,
									}}
								>
									Reward visibility before the final verdict.
								</div>
							</GlassPanel>

							<GlassPanel
								style={{
									background: panelGradient,
									borderRadius: 30,
									boxShadow: "none",
									padding: 22,
								}}
							>
								<div
									style={{
										color: "#75839d",
										fontFamily: monoFont,
										fontSize: 14,
										letterSpacing: 1.1,
										marginBottom: 16,
										textTransform: "uppercase",
									}}
								>
									current probability
								</div>
								<div
									style={{
										background: "rgba(198,210,236,0.74)",
										borderRadius: 999,
										height: 10,
										marginBottom: 16,
										overflow: "hidden",
									}}
								>
									<div
										style={{
											background: `linear-gradient(90deg, ${accentBlue}, #7aaeff)`,
											borderRadius: 999,
											height: "100%",
											width: "66%",
										}}
									/>
								</div>
								<div
									style={{
										color: "#0d1730",
										fontFamily: displayFont,
										fontSize: 40,
										fontWeight: 700,
										letterSpacing: -1.2,
									}}
								>
									66% YES
								</div>
							</GlassPanel>
						</div>
					</div>
				</StagePanel>
			</div>
		</SceneWrap>
	);
};

const ChartScene: React.FC<{
	accentBlue: string;
	accentOrange: string;
	aiLine: string;
	durationInFrames: number;
}> = ({accentBlue, accentOrange, aiLine, durationInFrames}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const reveal = entrance(frame, fps, 8, 145, 18);
	const chartProgress = interpolate(frame, [24, 198], [0, 1], clamp);
	const dashOffset = interpolate(chartProgress, [0, 1], [980, 0], clamp);
	const scanX = interpolate(frame, [84, 220], [-120, 760], clamp);

	return (
		<SceneWrap duration={durationInFrames} frame={frame}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 32,
					width: 982,
				}}
			>
				<SectionHeader
					accent={accentBlue}
					eyebrow="ai verdict engine"
					title={aiLine}
				/>

				<StagePanel
					style={{
						padding: 28,
						transform: `scale(${interpolate(reveal, [0, 1], [0.972, 1], clamp)})`,
						width: 982,
					}}
				>
					<div
						style={{
							alignItems: "center",
							display: "flex",
							justifyContent: "space-between",
							marginBottom: 22,
						}}
					>
						<Eyebrow accent={accentBlue}>analysis live</Eyebrow>
						<div
							style={{
								color: "#75839d",
								fontFamily: monoFont,
								fontSize: 15,
								letterSpacing: 1.2,
								textTransform: "uppercase",
							}}
						>
							confidence 94%
						</div>
					</div>

					<div
						style={{
							display: "grid",
							gap: 16,
							gridTemplateColumns: "1.35fr 0.65fr",
							marginBottom: 18,
						}}
					>
						<GlassPanel
							style={{
								background: panelGradient,
								borderRadius: 34,
								boxShadow: "none",
								height: 548,
								overflow: "hidden",
								padding: 24,
								position: "relative",
							}}
						>
							<div
								style={{
									alignItems: "center",
									display: "flex",
									justifyContent: "space-between",
									marginBottom: 16,
								}}
							>
								<div
									style={{
										color: "#74839d",
										fontFamily: monoFont,
										fontSize: 14,
										letterSpacing: 1.1,
										textTransform: "uppercase",
									}}
								>
									argument quality over time
								</div>
								<div
									style={{
										background: `${accentBlue}10`,
										border: `1px solid ${accentBlue}20`,
										borderRadius: 999,
										color: accentBlue,
										fontFamily: monoFont,
										fontSize: 13,
										letterSpacing: 1.1,
										padding: "8px 12px",
										textTransform: "uppercase",
									}}
								>
									transcript scanning
								</div>
							</div>

							<svg height="390" viewBox="0 0 820 390" width="100%">
								<defs>
									<linearGradient id="beeef-chart-line-v2" x1="0" x2="1" y1="0" y2="0">
										<stop offset="0%" stopColor={accentBlue} />
										<stop offset="100%" stopColor="#82b6ff" />
									</linearGradient>
									<linearGradient id="beeef-chart-area-v2" x1="0" x2="0" y1="0" y2="1">
										<stop offset="0%" stopColor={accentBlue} stopOpacity="0.28" />
										<stop offset="100%" stopColor={accentBlue} stopOpacity="0.02" />
									</linearGradient>
									<linearGradient id="beeef-chart-orange-v2" x1="0" x2="1" y1="0" y2="0">
										<stop offset="0%" stopColor={accentOrange} stopOpacity="0.84" />
										<stop offset="100%" stopColor="#ffb67d" stopOpacity="0.62" />
									</linearGradient>
								</defs>

								{[44, 112, 180, 248, 316].map((y) => (
									<line
										key={y}
										stroke="rgba(190, 204, 230, 0.72)"
										strokeWidth="1"
										x1="40"
										x2="780"
										y1={y}
										y2={y}
									/>
								))}

								<polygon
									fill="url(#beeef-chart-area-v2)"
									points="40,286 130,258 220,238 310,206 400,176 490,148 580,136 670,110 760,88 760,340 40,340"
								/>
								<polyline
									fill="none"
									points="40,286 130,258 220,238 310,206 400,176 490,148 580,136 670,110 760,88"
									stroke="url(#beeef-chart-line-v2)"
									strokeDasharray="980 980"
									strokeDashoffset={dashOffset}
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth="8"
								/>
								<polyline
									fill="none"
									points="40,304 130,286 220,270 310,250 400,232 490,214 580,206 670,188 760,176"
									stroke="url(#beeef-chart-orange-v2)"
									strokeDasharray="980 980"
									strokeDashoffset={dashOffset}
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth="6"
								/>

								{[
									[40, 286],
									[130, 258],
									[220, 238],
									[310, 206],
									[400, 176],
									[490, 148],
									[580, 136],
									[670, 110],
									[760, 88],
								].map(([x, y], index) => {
									const pointReveal = interpolate(
										frame,
										[60 + index * 12, 92 + index * 12],
										[0, 1],
										clamp,
									);

									return (
										<circle
											cx={x}
											cy={y}
											fill={accentBlue}
											key={`${x}-${y}`}
											opacity={pointReveal}
											r={interpolate(pointReveal, [0, 1], [0, 8], clamp)}
										/>
									);
								})}
							</svg>

							<div
								style={{
									background:
										"linear-gradient(90deg, rgba(255,255,255,0), rgba(36,92,255,0.16), rgba(255,255,255,0))",
									filter: "blur(12px)",
									height: "100%",
									left: scanX,
									position: "absolute",
									top: 0,
									width: 120,
								}}
							/>
						</GlassPanel>

						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: 16,
							}}
						>
							{[
								["Clarity", "91"],
								["Evidence", "88"],
								["Consistency", "94"],
							].map(([label, value], index) => {
								return (
									<GlassPanel
										key={label}
										style={{
											background: panelGradient,
											borderRadius: 28,
											boxShadow: "none",
											padding: 22,
											transform: `translateY(${interpolate(reveal, [0, 1], [18 + index * 6, 0], clamp)}px)`,
										}}
									>
										<div
											style={{
												color: "#74839d",
												fontFamily: monoFont,
												fontSize: 13,
												letterSpacing: 1.1,
												marginBottom: 12,
												textTransform: "uppercase",
											}}
										>
											{label}
										</div>
										<div
											style={{
												color: "#091426",
												fontFamily: displayFont,
												fontSize: 48,
												fontWeight: 700,
												letterSpacing: -1.5,
												marginBottom: 8,
											}}
										>
											{value}
										</div>
										<div
											style={{
												color: "#6b7b95",
												fontFamily: bodyFont,
												fontSize: 20,
												lineHeight: 1.32,
											}}
										>
											AI scores update as the debate evolves.
										</div>
									</GlassPanel>
								);
							})}
						</div>
					</div>

					<GlassPanel
						style={{
							background: panelGradient,
							borderRadius: 30,
							boxShadow: "none",
							padding: 24,
						}}
					>
						<div
							style={{
								alignItems: "center",
								display: "flex",
								justifyContent: "space-between",
								marginBottom: 14,
							}}
						>
							<div
								style={{
									color: "#0d1830",
									fontFamily: displayFont,
									fontSize: 34,
									fontWeight: 700,
									letterSpacing: -1.1,
								}}
							>
								AI verdict: YES has the stronger case
							</div>
							<div
								style={{
									color: accentBlue,
									fontFamily: monoFont,
									fontSize: 14,
									letterSpacing: 1.1,
									textTransform: "uppercase",
								}}
							>
								high confidence
							</div>
						</div>
						<div
							style={{
								color: "#667791",
								fontFamily: bodyFont,
								fontSize: 24,
								lineHeight: 1.34,
							}}
						>
							Le dashboard se construit en direct, les signaux se clarifient,
							et le verdict devient visuellement inevitable.
						</div>
					</GlassPanel>
				</StagePanel>
			</div>
		</SceneWrap>
	);
};

const ResultScene: React.FC<{
	accentBlue: string;
	accentOrange: string;
	durationInFrames: number;
	resultLine: string;
}> = ({accentBlue, accentOrange, durationInFrames, resultLine}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const reveal = entrance(frame, fps, 6, 150, 18);
	const cardScale = interpolate(reveal, [0, 1], [0.9, 1], clamp);
	const glowStrength = interpolate(frame, [18, 120], [0.35, 1], clamp);

	return (
		<SceneWrap duration={durationInFrames} frame={frame}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 34,
					width: 920,
				}}
			>
				<SectionHeader
					accent={accentBlue}
					eyebrow="final result"
					title={resultLine}
				/>

				<div
					style={{
						alignItems: "center",
						display: "flex",
						justifyContent: "center",
						minHeight: 930,
						position: "relative",
						width: 920,
					}}
				>
					<AmbientOrb
						blur={62}
						color="rgba(36,92,255,0.18)"
						height={360}
						left="50%"
						opacity={glowStrength}
						top={220}
						width={360}
					/>

					<GlassPanel
						style={{
							background:
								"linear-gradient(180deg, rgba(246,250,255,0.84), rgba(241,247,255,0.78))",
							borderRadius: 40,
							boxShadow: "0 34px 90px rgba(26,49,99,0.08)",
							height: 560,
							position: "absolute",
							transform: "translateY(84px) rotate(-4deg) scale(0.9)",
							width: 700,
						}}
					/>
					<GlassPanel
						style={{
							background:
								"linear-gradient(180deg, rgba(246,250,255,0.9), rgba(241,247,255,0.82))",
							borderRadius: 40,
							boxShadow: "0 34px 90px rgba(26,49,99,0.08)",
							height: 560,
							position: "absolute",
							transform: "translateY(54px) rotate(4deg) scale(0.92)",
							width: 700,
						}}
					/>

					<StagePanel
						style={{
							padding: 34,
							transform: `scale(${cardScale}) translateY(${interpolate(reveal, [0, 1], [44, 0], clamp)}px)`,
							width: 764,
						}}
					>
						<div
							style={{
								alignItems: "center",
								display: "flex",
								justifyContent: "space-between",
								marginBottom: 26,
							}}
						>
							<Eyebrow accent={accentBlue}>winner</Eyebrow>
							<div
								style={{
									background: `${accentOrange}14`,
									border: `1px solid ${accentOrange}22`,
									borderRadius: 999,
									color: accentOrange,
									fontFamily: monoFont,
									fontSize: 13,
									letterSpacing: 1.2,
									padding: "10px 14px",
									textTransform: "uppercase",
								}}
							>
								brand verified
							</div>
						</div>

						<div
							style={{
								alignItems: "center",
								display: "flex",
								gap: 18,
								marginBottom: 10,
							}}
						>
							<div
								style={{
									background: `linear-gradient(180deg, ${accentBlue}, #77a8ff)`,
									borderRadius: 999,
									boxShadow: `0 0 38px ${accentBlue}36`,
									height: 16,
									width: 16,
								}}
							/>
							<div
								style={{
									color: accentBlue,
									fontFamily: monoFont,
									fontSize: 15,
									letterSpacing: 1.2,
									textTransform: "uppercase",
								}}
							>
								final consensus
							</div>
						</div>

						<div
							style={{
								color: "#0a1427",
								fontFamily: displayFont,
								fontSize: 94,
								fontWeight: 700,
								letterSpacing: -3.8,
								lineHeight: 0.88,
								marginBottom: 12,
							}}
						>
							YES wins
						</div>
						<div
							style={{
								color: "#667791",
								fontFamily: bodyFont,
								fontSize: 28,
								lineHeight: 1.32,
								marginBottom: 28,
								maxWidth: 620,
							}}
						>
							La carte gagnante remonte visuellement, le glow reste sobre, et
							la conclusion ressemble a un vrai produit haut de gamme.
						</div>

						<div
							style={{
								display: "grid",
								gap: 14,
								gridTemplateColumns: "1fr 1fr 1fr",
								marginBottom: 28,
							}}
						>
							{[
								["Score", "91"],
								["Audience", "+14%"],
								["AI", "94%"],
							].map(([label, value]) => {
								return (
									<GlassPanel
										key={label}
										style={{
											background: panelGradient,
											borderRadius: 24,
											boxShadow: "none",
											padding: 20,
										}}
									>
										<div
											style={{
												color: "#74839d",
												fontFamily: monoFont,
												fontSize: 13,
												letterSpacing: 1.1,
												marginBottom: 10,
												textTransform: "uppercase",
											}}
										>
											{label}
										</div>
										<div
											style={{
												color: "#0c172e",
												fontFamily: displayFont,
												fontSize: 42,
												fontWeight: 700,
												letterSpacing: -1.1,
											}}
										>
											{value}
										</div>
									</GlassPanel>
								);
							})}
						</div>

						<GlassPanel
							style={{
								background:
									"linear-gradient(180deg, rgba(236,244,255,0.82), rgba(243,247,255,0.92))",
								borderRadius: 26,
								boxShadow: "none",
								padding: "18px 20px",
							}}
						>
							<div
								style={{
									alignItems: "center",
									display: "flex",
									justifyContent: "space-between",
								}}
							>
								<div
									style={{
										color: "#1b3568",
										fontFamily: bodyFont,
										fontSize: 24,
									}}
								>
									Payout distributed automatically
								</div>
								<div
									style={{
										color: accentBlue,
										fontFamily: displayFont,
										fontSize: 38,
										fontWeight: 700,
										letterSpacing: -1.1,
									}}
								>
									+ 1 240 pts
								</div>
							</div>
						</GlassPanel>
					</StagePanel>
				</div>
			</div>
		</SceneWrap>
	);
};

const BrandOutro: React.FC<{
	accentOrange: string;
	beeSrc: string;
	brandLine: string;
	ctaLine: string;
	durationInFrames: number;
	tagline: string;
	textSrc: string;
}> = ({
	accentOrange,
	beeSrc,
	brandLine,
	ctaLine,
	durationInFrames,
	tagline,
	textSrc,
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const reveal = entrance(frame, fps, 8, 130, 19);
	const beeFloat = floatOffset(frame, 16, 10, 0.2);
	const beeRotate = floatOffset(frame, 34, 1.8, 0.5);
	const glowPulse = 0.72 + Math.sin(frame / 15) * 0.08;
	const streakScale = interpolate(frame, [34, 140], [0.2, 1], clamp);

	return (
		<SceneWrap duration={durationInFrames} frame={frame} shift={20}>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: 28,
					transform: `translateY(${interpolate(reveal, [0, 1], [18, 0], clamp)}px)`,
				}}
			>
				<Eyebrow accent={accentOrange} dark>
					{brandLine}
				</Eyebrow>

				<div
					style={{
						alignItems: "center",
						display: "flex",
						flexDirection: "column",
						gap: 26,
						position: "relative",
					}}
				>
					<div
						style={{
							background: `radial-gradient(circle, ${accentOrange}54 0%, ${accentOrange}14 44%, transparent 74%)`,
							borderRadius: "50%",
							filter: "blur(48px)",
							height: 290,
							left: "50%",
							opacity: glowPulse,
							position: "absolute",
							top: -18,
							transform: "translateX(-50%)",
							width: 290,
						}}
					/>
					<div
						style={{
							background: `linear-gradient(90deg, transparent, ${accentOrange}18, transparent)`,
							filter: "blur(14px)",
							height: 68,
							left: "50%",
							opacity: 0.8,
							position: "absolute",
							top: 236,
							transform: `translateX(-50%) scaleX(${streakScale})`,
							width: 760,
						}}
					/>
					<div
						style={{
							background: `radial-gradient(circle, ${accentOrange}18 0%, transparent 72%)`,
							borderRadius: "50%",
							filter: "blur(72px)",
							height: 260,
							left: "50%",
							opacity: 0.7,
							position: "absolute",
							top: 190,
							transform: "translateX(-50%)",
							width: 760,
						}}
					/>
					<Img
						src={staticFile(beeSrc)}
						style={{
							filter: `brightness(1.12) drop-shadow(0 0 20px ${accentOrange}88) drop-shadow(0 0 44px ${accentOrange}2a)`,
							transform: `translateY(${beeFloat}px) rotate(${beeRotate}deg)`,
							width: 208,
						}}
					/>
					<Img
						src={staticFile(textSrc)}
						style={{
							filter: `brightness(1.08) drop-shadow(0 0 16px ${accentOrange}58) drop-shadow(0 0 36px ${accentOrange}16)`,
							width: 620,
						}}
					/>
				</div>

				<div
					style={{
						color: "#ffffff",
						fontFamily: displayFont,
						fontSize: 96,
						fontWeight: 700,
						letterSpacing: -4.4,
						lineHeight: 0.92,
						textAlign: "center",
					}}
				>
					{ctaLine}
				</div>
				<div
					style={{
						color: "rgba(255,255,255,0.72)",
						fontFamily: bodyFont,
						fontSize: 28,
						lineHeight: 1.35,
						maxWidth: 760,
						textAlign: "center",
					}}
				>
					{tagline}
				</div>
			</div>
		</SceneWrap>
	);
};

export const BeeefSaasPromo: React.FC<
	z.infer<typeof beeefSaasPromoSchema>
> = ({
	accentBlue,
	accentOrange,
	lightBackground,
	darkBackground,
	beeSrc,
	textSrc,
	brandLine,
	tagline,
	introLine,
	conceptLine,
	liveLine,
	actionLine,
	aiLine,
	resultLine,
	ctaLine,
}) => {
	const frame = useCurrentFrame();
	const darkBlend = interpolate(
		frame,
		[sceneStarts.cta - 24, sceneStarts.cta + 38],
		[0, 1],
		clamp,
	);

	return (
		<AbsoluteFill style={{backgroundColor: lightBackground}}>
			<AbsoluteFill
				style={{
					background: `linear-gradient(180deg, ${lightBackground} 0%, #eff4fc 48%, #f8fbff 100%)`,
				}}
			/>
			<AbsoluteFill
				style={{
					background:
						"radial-gradient(circle at 14% 16%, rgba(36,92,255,0.1), transparent 24%), radial-gradient(circle at 86% 18%, rgba(36,92,255,0.08), transparent 22%), radial-gradient(circle at 52% 82%, rgba(36,92,255,0.1), transparent 26%)",
				}}
			/>
			<AbsoluteFill
				style={{
					backgroundImage:
						"linear-gradient(rgba(186,199,226,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(186,199,226,0.14) 1px, transparent 1px)",
					backgroundSize: "100% 100%, 98px 98px",
					opacity: 0.22 * (1 - darkBlend),
				}}
			/>
			<AbsoluteFill
				style={{
					background:
						"linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0) 24%, rgba(255,255,255,0) 80%, rgba(255,255,255,0.32))",
					opacity: 0.74 * (1 - darkBlend),
				}}
			/>
			<AbsoluteFill
				style={{
					background: darkBackground,
					opacity: darkBlend,
				}}
			/>
			<AbsoluteFill
				style={{
					background: `radial-gradient(circle at 50% 24%, ${accentOrange}12 0%, transparent 28%), radial-gradient(circle at 50% 62%, ${accentOrange}08 0%, transparent 34%)`,
					opacity: darkBlend,
				}}
			/>

			<Sequence
				durationInFrames={sceneDurations.intro}
				from={sceneStarts.intro}
			>
				<IntroScene
					accentBlue={accentBlue}
					brandLine={brandLine}
					durationInFrames={sceneDurations.intro}
					introLine={introLine}
					tagline={tagline}
				/>
			</Sequence>

			<Sequence
				durationInFrames={sceneDurations.concept}
				from={sceneStarts.concept}
			>
				<ConceptScene
					accentBlue={accentBlue}
					conceptLine={conceptLine}
					durationInFrames={sceneDurations.concept}
				/>
			</Sequence>

			<Sequence durationInFrames={sceneDurations.live} from={sceneStarts.live}>
				<LiveScene
					accentBlue={accentBlue}
					durationInFrames={sceneDurations.live}
					liveLine={liveLine}
				/>
			</Sequence>

			<Sequence
				durationInFrames={sceneDurations.action}
				from={sceneStarts.action}
			>
				<ActionScene
					accentBlue={accentBlue}
					accentOrange={accentOrange}
					actionLine={actionLine}
					durationInFrames={sceneDurations.action}
				/>
			</Sequence>

			<Sequence durationInFrames={sceneDurations.ai} from={sceneStarts.ai}>
				<ChartScene
					accentBlue={accentBlue}
					accentOrange={accentOrange}
					aiLine={aiLine}
					durationInFrames={sceneDurations.ai}
				/>
			</Sequence>

			<Sequence
				durationInFrames={sceneDurations.result}
				from={sceneStarts.result}
			>
				<ResultScene
					accentBlue={accentBlue}
					accentOrange={accentOrange}
					durationInFrames={sceneDurations.result}
					resultLine={resultLine}
				/>
			</Sequence>

			<Sequence durationInFrames={sceneDurations.cta} from={sceneStarts.cta}>
				<BrandOutro
					accentOrange={accentOrange}
					beeSrc={beeSrc}
					brandLine={brandLine}
					ctaLine={ctaLine}
					durationInFrames={sceneDurations.cta}
					tagline={tagline}
					textSrc={textSrc}
				/>
			</Sequence>
		</AbsoluteFill>
	);
};
